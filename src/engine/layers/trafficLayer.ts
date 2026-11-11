import type * as CesiumType from 'cesium';
import type { DetectionTarget } from '@/types/gev';
import { ensureGeoidReady, geoidHeightOrZero } from '../geoid';
import { tilesForBounds } from '../tomtomTiles';
import {
  DENSITY_BY_HIGHWAY,
  FLOW_BUCKET_HEX,
  PIXEL_SIZE_BY_HIGHWAY,
  SPEED_BY_HIGHWAY_MPS,
  clampBoundsAroundCenter,
  decodeTomTomFlowTile,
  deriveFetchCenter,
  flowDensityMult,
  flowSpeedScale,
  type FlowBucket,
  type TrafficFlowSegment,
} from '../trafficFlow';
import { greatCircleKmBetween } from '../routePlausible';

const ACTIVATION_ALTITUDE_M = 14_000;
const FAST_FETCH_ALTITUDE_M = 5_500;
const FETCH_DEBOUNCE_MS = 320;
const REFRESH_TTL_MS = 90_000;
const CLIENT_TILE_TTL_MS = 120_000;
const MIN_CENTER_SHIFT_KM = 0.35;
const FLOW_LINE_CAP = 1_200;
const MAX_PARTICLES = 1_800;

interface PreparedRoad {
  seg: TrafficFlowSegment;
  cumDistM: number[];
  totalDistM: number;
  waypoints: CesiumType.Cartesian3[];
}

interface TrafficParticle {
  road: PreparedRoad;
  distM: number;
  speedMps: number;
  point: CesiumType.PointPrimitive;
}

export class TrafficLayerController {
  private viewer: CesiumType.Viewer;
  private Cesium: typeof CesiumType;
  private pointCollection: CesiumType.PointPrimitiveCollection;
  private groundPrimitives: CesiumType.GroundPolylinePrimitive[] = [];
  private fallbackLines: CesiumType.PolylineCollection | null = null;
  private roads: PreparedRoad[] = [];
  private particles: TrafficParticle[] = [];
  private detectionTargets: DetectionTarget[] = [];

  private tileCache = new Map<string, { at: number; stale: boolean; segments: TrafficFlowSegment[] }>();
  private enabled = false;
  private hasKey: boolean | null = null;
  private fetchSeq = 0;
  private lastFetchCenter: { lat: number; lon: number; atMs: number } | null = null;
  private debounceTimer: number | null = null;
  private refreshTimer: number | null = null;
  private removeCameraListener: (() => void) | null = null;

  private onStats: (patch: {
    loading?: boolean;
    count?: number;
    status?: 'IDLE' | 'LOADING' | 'LIVE' | 'STALE' | 'ERROR';
    sourceLabel?: string;
    error?: string | null;
  }) => void;

  constructor(
    viewer: CesiumType.Viewer,
    Cesium: typeof CesiumType,
    onStats: TrafficLayerController['onStats'],
  ) {
    this.viewer = viewer;
    this.Cesium = Cesium;
    this.onStats = onStats;
    this.pointCollection = new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(this.pointCollection);
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      void ensureGeoidReady();
      this.hasKey = null;
      this.lastFetchCenter = null;
      this.installListeners();
      void this.refresh(true);
    } else {
      this.teardownListeners();
      this.clearVisuals();
      this.detectionTargets = [];
      this.onStats({
        loading: false,
        count: 0,
        status: 'IDLE',
        sourceLabel: 'TomTom Flow',
        error: null,
      });
    }
  }

  private installListeners() {
    if (!this.removeCameraListener && !this.viewer.isDestroyed()) {
      this.removeCameraListener = this.viewer.camera.moveEnd.addEventListener(() => {
        if (!this.enabled) return;
        if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
        this.debounceTimer = window.setTimeout(() => {
          this.debounceTimer = null;
          void this.refresh(false);
        }, FETCH_DEBOUNCE_MS);
      });
    }
    if (this.refreshTimer === null) {
      this.refreshTimer = window.setInterval(() => {
        if (this.enabled) void this.refresh(true);
      }, REFRESH_TTL_MS);
    }
  }

  private teardownListeners() {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.removeCameraListener) {
      this.removeCameraListener();
      this.removeCameraListener = null;
    }
  }

  private clearVisuals() {
    if (!this.viewer.isDestroyed()) {
      for (const prim of this.groundPrimitives) {
        this.viewer.scene.groundPrimitives.remove(prim);
      }
      if (this.fallbackLines) {
        this.viewer.scene.primitives.remove(this.fallbackLines);
        this.fallbackLines = null;
      }
    }
    this.groundPrimitives = [];
    this.pointCollection.removeAll();
    this.particles = [];
    this.roads = [];
  }

  private async ensureKeyStatus(): Promise<boolean> {
    if (this.hasKey !== null) return this.hasKey;
    try {
      const resp = await fetch('/api/tomtom/status');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as { hasKey?: boolean };
      this.hasKey = Boolean(json?.hasKey);
      return this.hasKey;
    } catch {
      this.hasKey = false;
      return false;
    }
  }

  private resolveCameraFetchCenter() {
    const cam = this.viewer.camera;
    const carto = cam.positionCartographic;
    if (!carto) return null;

    const altitudeM = carto.height;
    const nadirLat = this.Cesium.Math.toDegrees(carto.latitude);
    const nadirLon = this.Cesium.Math.toDegrees(carto.longitude);

    let hitLat: number | undefined;
    let hitLon: number | undefined;
    const canvas = this.viewer.scene.canvas;
    const w = canvas.clientWidth || 0;
    const h = canvas.clientHeight || 0;
    if (w > 0 && h > 0) {
      const hit = cam.pickEllipsoid(
        new this.Cesium.Cartesian2(w / 2, h / 2),
        this.Cesium.Ellipsoid.WGS84,
      );
      if (hit) {
        const hitCarto = this.Cesium.Cartographic.fromCartesian(hit);
        hitLat = this.Cesium.Math.toDegrees(hitCarto.latitude);
        hitLon = this.Cesium.Math.toDegrees(hitCarto.longitude);
      }
    }

    const center = deriveFetchCenter({
      nadirLat,
      nadirLon,
      hitLat,
      hitLon,
      maxPullKm: 12,
    });
    return { ...center, altitudeM };
  }

  private async fetchTile(
    z: number,
    x: number,
    y: number,
  ): Promise<{ stale: boolean; segments: TrafficFlowSegment[] }> {
    const key = `${z}/${x}/${y}`;
    const now = Date.now();
    const cached = this.tileCache.get(key);
    if (cached && now - cached.at < CLIENT_TILE_TTL_MS) {
      return { stale: cached.stale, segments: cached.segments };
    }

    const resp = await fetch(`/api/tomtom/flow/${z}/${x}/${y}.pbf`);
    if (!resp.ok) {
      let errCode = `HTTP ${resp.status}`;
      try {
        const body = (await resp.json()) as { error?: string };
        if (body?.error === 'no_key') errCode = 'no_key';
        else if (body?.error === 'budget') errCode = 'budget';
      } catch {
        // non-JSON body
      }
      throw new Error(errCode);
    }

    const cacheHeader = resp.headers.get('x-tomtom-cache') || '';
    const stale = cacheHeader.startsWith('STALE');
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const segments = decodeTomTomFlowTile(bytes, z, x, y, true);

    if (this.tileCache.size >= 24) {
      const oldest = this.tileCache.keys().next().value;
      if (oldest) this.tileCache.delete(oldest);
    }
    this.tileCache.set(key, { at: now, stale, segments });
    return { stale, segments };
  }

  private async refresh(force: boolean) {
    if (!this.enabled || this.viewer.isDestroyed()) return;

    const seq = ++this.fetchSeq;
    const keyReady = await this.ensureKeyStatus();
    if (!this.enabled || seq !== this.fetchSeq || this.viewer.isDestroyed()) return;

    if (!keyReady) {
      this.clearVisuals();
      this.detectionTargets = [];
      this.onStats({
        loading: false,
        count: 0,
        status: 'ERROR',
        sourceLabel: 'TomTom Flow',
        error: 'TOMTOM_API_KEY required — configure in Power Up',
      });
      return;
    }

    const viewCenter = this.resolveCameraFetchCenter();
    if (!viewCenter) return;

    if (viewCenter.altitudeM > ACTIVATION_ALTITUDE_M) {
      this.clearVisuals();
      this.detectionTargets = [];
      this.onStats({
        loading: false,
        count: 0,
        status: 'LIVE',
        sourceLabel: 'TomTom · Zoom < 14km',
        error: null,
      });
      return;
    }

    const now = Date.now();
    if (!force && this.lastFetchCenter) {
      const shiftKm = greatCircleKmBetween(this.lastFetchCenter, {
        lat: viewCenter.lat,
        lon: viewCenter.lon,
      });
      if (shiftKm < MIN_CENTER_SHIFT_KM && now - this.lastFetchCenter.atMs < REFRESH_TTL_MS) {
        return;
      }
    }

    this.onStats({
      loading: true,
      status: this.roads.length ? 'LIVE' : 'LOADING',
      sourceLabel: 'TomTom Flow',
      error: null,
    });

    const bounds = clampBoundsAroundCenter(viewCenter.lat, viewCenter.lon, 0.025);
    const tiles = tilesForBounds(bounds, 12, 9);

    try {
      const results = await Promise.allSettled(
        tiles.map((t) => this.fetchTile(t.z, t.x, t.y)),
      );
      if (!this.enabled || seq !== this.fetchSeq || this.viewer.isDestroyed()) return;

      const settled: Array<{ stale: boolean; segments: TrafficFlowSegment[] }> = [];
      let rejectedError: string | null = null;
      for (const r of results) {
        if (r.status === 'fulfilled') settled.push(r.value);
        else if (!rejectedError) rejectedError = r.reason instanceof Error ? r.reason.message : 'upstream';
      }

      if (!settled.length) {
        if (rejectedError === 'no_key') this.hasKey = false;
        const msg =
          rejectedError === 'no_key'
            ? 'TOMTOM_API_KEY required — configure in Power Up'
            : rejectedError === 'budget'
              ? 'TomTom daily tile budget reached'
              : 'TomTom upstream unavailable';
        this.onStats({
          loading: false,
          status: this.roads.length ? 'STALE' : 'ERROR',
          error: msg,
        });
        return;
      }

      this.lastFetchCenter = { lat: viewCenter.lat, lon: viewCenter.lon, atMs: Date.now() };

      const allSegments: TrafficFlowSegment[] = [];
      let anyStale = false;
      for (const item of settled) {
        if (item.stale) anyStale = true;
        for (const seg of item.segments) {
          allSegments.push(seg);
        }
      }

      const visible =
        viewCenter.altitudeM > FAST_FETCH_ALTITUDE_M
          ? allSegments.filter(
              (s) => s.highway === 'motorway' || s.highway === 'trunk' || s.highway === 'primary',
            )
          : allSegments;

      this.buildSceneGeometry(visible);

      this.onStats({
        loading: false,
        count: this.roads.length,
        status: anyStale ? 'STALE' : 'LIVE',
        sourceLabel: anyStale ? 'TomTom (Cached)' : 'TomTom Flow',
        error: null,
      });
    } catch (err) {
      if (!this.enabled || seq !== this.fetchSeq) return;
      this.onStats({
        loading: false,
        status: this.roads.length ? 'STALE' : 'ERROR',
        error: err instanceof Error ? err.message : 'TomTom traffic error',
      });
    }
  }

  private sampleSurfaceHeightM(lon: number, lat: number): number {
    const scene = this.viewer.scene as CesiumType.Scene & {
      sampleHeightSupported?: boolean;
      sampleHeight?: (carto: CesiumType.Cartographic) => number | undefined;
    };
    const carto = this.Cesium.Cartographic.fromDegrees(lon, lat);
    if (scene.sampleHeightSupported && typeof scene.sampleHeight === 'function') {
      try {
        const h = scene.sampleHeight(carto);
        if (typeof h === 'number' && Number.isFinite(h)) return h + 3;
      } catch {
        // Fallback below
      }
    }
    const globeH = this.viewer.scene.globe?.getHeight(carto);
    if (typeof globeH === 'number' && Number.isFinite(globeH)) return globeH + 4;
    return geoidHeightOrZero(lat, lon) + 4;
  }

  private buildSceneGeometry(segments: TrafficFlowSegment[]) {
    this.clearVisuals();
    this.detectionTargets = [];

    const rank: Record<FlowBucket, number> = { jam: 0, slow: 1, free: 2 };
    const sorted = [...segments].sort((a, b) => rank[a.bucket] - rank[b.bucket]);
    const capped = sorted.slice(0, FLOW_LINE_CAP);

    const prepared: PreparedRoad[] = [];
    for (const seg of capped) {
      const cumDistM: number[] = [0];
      const waypoints: CesiumType.Cartesian3[] = [];
      let total = 0;
      for (let i = 0; i < seg.coords.length; i++) {
        const [lon, lat] = seg.coords[i];
        const altM = this.sampleSurfaceHeightM(lon, lat);
        waypoints.push(this.Cesium.Cartesian3.fromDegrees(lon, lat, altM));
        if (i > 0) {
          const [prevLon, prevLat] = seg.coords[i - 1];
          total +=
            greatCircleKmBetween({ lat: prevLat, lon: prevLon }, { lat, lon }) * 1000;
          cumDistM.push(total);
        }
      }
      if (waypoints.length >= 2 && total > 5) {
        prepared.push({ seg, cumDistM, totalDistM: total, waypoints });
      }
    }
    this.roads = prepared;

    // 1. Drape flow lines onto ground / 3D Tiles via batched GroundPolylinePrimitive per bucket
    const groundSupported = this.Cesium.GroundPolylinePrimitive.isSupported(this.viewer.scene);
    if (groundSupported) {
      const byBucket: Record<FlowBucket, CesiumType.GeometryInstance[]> = {
        free: [],
        slow: [],
        jam: [],
      };
      for (const road of prepared) {
        byBucket[road.seg.bucket].push(
          new this.Cesium.GeometryInstance({
            geometry: new this.Cesium.GroundPolylineGeometry({
              positions: road.waypoints,
              width: road.seg.bucket === 'jam' ? 4.5 : 3.2,
            }),
          }),
        );
      }

      const clsType =
        this.viewer.scene.globe?.show === false
          ? this.Cesium.ClassificationType.CESIUM_3D_TILE
          : this.Cesium.ClassificationType.BOTH;

      for (const bucket of ['free', 'slow', 'jam'] as const) {
        const instances = byBucket[bucket];
        if (!instances.length) continue;
        const prim = this.viewer.scene.groundPrimitives.add(
          new this.Cesium.GroundPolylinePrimitive({
            geometryInstances: instances,
            classificationType: clsType,
            appearance: new this.Cesium.PolylineMaterialAppearance({
              material: this.Cesium.Material.fromType('Color', {
                color: this.Cesium.Color.fromCssColorString(FLOW_BUCKET_HEX[bucket]).withAlpha(0.82),
              }),
            }),
          }),
        ) as CesiumType.GroundPolylinePrimitive;
        this.groundPrimitives.push(prim);
      }
    } else {
      const col = new this.Cesium.PolylineCollection();
      this.viewer.scene.primitives.add(col);
      this.fallbackLines = col;
      for (const road of prepared) {
        col.add({
          positions: road.waypoints,
          width: road.seg.bucket === 'jam' ? 4 : 2.8,
          material: this.Cesium.Material.fromType('Color', {
            color: this.Cesium.Color.fromCssColorString(FLOW_BUCKET_HEX[road.seg.bucket]).withAlpha(0.82),
          }),
        });
      }
    }

    // 2. Spawn animated moving traffic dots along each drivable road
    let particleBudget = MAX_PARTICLES;
    for (let idx = 0; idx < prepared.length; idx++) {
      const road = prepared[idx];
      if (road.seg.closure) {
        const mid = road.seg.coords[Math.floor(road.seg.coords.length / 2)];
        if (this.detectionTargets.length < 25) {
          this.detectionTargets.push({
            entityId: `traffic:closure:${idx}`,
            label: 'ROAD CLOSED',
            sublabel: road.seg.roadType.toUpperCase(),
            category: 'traffic',
            lat: mid[1],
            lon: mid[0],
            altM: 25,
            color: '#FF3B30',
            priority: 6,
          });
        }
        continue;
      }

      if (road.seg.bucket === 'jam' && this.detectionTargets.length < 25) {
        const mid = road.seg.coords[Math.floor(road.seg.coords.length / 2)];
        const pct = Math.round(road.seg.trafficLevel * 100);
        this.detectionTargets.push({
          entityId: `traffic:jam:${idx}`,
          label: `${road.seg.highway.toUpperCase()} JAM`,
          sublabel: `${pct}% FLOW`,
          category: 'traffic',
          lat: mid[1],
          lon: mid[0],
          altM: 25,
          color: FLOW_BUCKET_HEX.jam,
          priority: 4,
        });
      }

      if (particleBudget <= 0) continue;

      const baseDensity = DENSITY_BY_HIGHWAY[road.seg.highway] ?? 1.0;
      const desiredDots = Math.min(
        8,
        Math.max(
          1,
          Math.round((road.totalDistM / 180) * baseDensity * flowDensityMult(road.seg.trafficLevel)),
        ),
      );
      const count = Math.min(desiredDots, particleBudget);
      particleBudget -= count;

      const color = this.Cesium.Color.fromCssColorString(FLOW_BUCKET_HEX[road.seg.bucket]).withAlpha(0.95);
      const baseSpeed = SPEED_BY_HIGHWAY_MPS[road.seg.highway] ?? 12;
      const speedMps = baseSpeed * flowSpeedScale(road.seg.trafficLevel);
      const pixelSize = PIXEL_SIZE_BY_HIGHWAY[road.seg.highway] ?? 5;

      for (let d = 0; d < count; d++) {
        const distM = (road.totalDistM * (d + 0.5)) / count;
        const pos = this.interpolateAlongRoad(road, distM);
        const point = this.pointCollection.add({
          position: pos,
          color,
          pixelSize,
          outlineColor: this.Cesium.Color.BLACK.withAlpha(0.75),
          outlineWidth: 1,
          disableDepthTestDistance: 350,
        });
        this.particles.push({ road, distM, speedMps, point });
      }
    }
  }

  private interpolateAlongRoad(road: PreparedRoad, distM: number): CesiumType.Cartesian3 {
    const wrapped = ((distM % road.totalDistM) + road.totalDistM) % road.totalDistM;
    const cum = road.cumDistM;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < wrapped) i++;
    const segLen = Math.max(0.01, cum[i] - cum[i - 1]);
    const t = Math.max(0, Math.min(1, (wrapped - cum[i - 1]) / segLen));
    return this.Cesium.Cartesian3.lerp(
      road.waypoints[i - 1],
      road.waypoints[i],
      t,
      new this.Cesium.Cartesian3(),
    );
  }

  tick(dtSec: number) {
    if (!this.enabled || !this.particles.length) return;
    const clampedDt = Math.min(0.1, Math.max(0, dtSec));
    if (clampedDt <= 0) return;

    for (const p of this.particles) {
      p.distM = (p.distM + p.speedMps * clampedDt) % p.road.totalDistM;
      p.point.position = this.interpolateAlongRoad(p.road, p.distM);
    }
  }

  getTickData(): { detectionTargets: DetectionTarget[] } {
    return {
      detectionTargets: this.enabled ? this.detectionTargets : [],
    };
  }

  destroy() {
    this.teardownListeners();
    this.clearVisuals();
    if (!this.viewer.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.pointCollection);
    }
  }
}
