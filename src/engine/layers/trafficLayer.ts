import type * as CesiumType from 'cesium';
import type { DetectionTarget } from '@/types/gev';
import { ensureGeoidReady, geoidHeightOrZero } from '../geoid';
import { tilesForBounds, type TileBBox } from '../tomtomTiles';
import {
  DENSITY_BY_HIGHWAY,
  FLOW_BUCKET_HEX,
  PIXEL_SIZE_BY_HIGHWAY,
  SPEED_BY_HIGHWAY_MPS,
  boundsOverlap,
  clampBoundsAroundCenter,
  clipLineToBounds,
  decodeTomTomFlowTile,
  deriveFetchCenter,
  flowDensityMult,
  flowSpeedScale,
  roadDotBudget,
  roadHeightStations,
  simplifyRoadCoords,
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
const MAX_PREPARED_ROADS = 900;
const FLOW_LINE_CAP = 320;
const MAX_PARTICLES = 1_000;
const SURFACE_CACHE_MAX = 15_000;
const REFINE_SLICE_BUDGET_MS = 5;
const REFINE_MAX_SAMPLES_PER_SLICE = 3;
const REFINE_MAX_SAMPLE_HEIGHT_TOTAL = 160;

interface PreparedRoad {
  seg: TrafficFlowSegment;
  waypoints: CesiumType.Cartesian3[];
  segmentDist: number[];
  totalDistM: number;
  heightIndices: number[];
  heightDistances: number[];
}

interface TrafficParticle {
  road: PreparedRoad;
  segIdx: number;
  t: number;
  direction: 1 | -1;
  speedMps: number;
  point: CesiumType.PointPrimitive;
}

type GroundPrim = CesiumType.GroundPolylinePrimitive & { ready?: boolean };

function yieldSlice(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function quantizeHeightKey(lat: number, lon: number): string {
  // ~55 m grid cell so intersecting/parallel street segments share sampled heights
  const qLat = (Math.round(lat * 2000) / 2000).toFixed(4);
  const qLon = (Math.round(lon * 2000) / 2000).toFixed(4);
  return `${qLat},${qLon}`;
}

export class TrafficLayerController {
  private viewer: CesiumType.Viewer;
  private Cesium: typeof CesiumType;
  private pointCollection: CesiumType.PointPrimitiveCollection;
  private groundPrimitives: GroundPrim[] = [];
  private retiredGroundPrimitives: GroundPrim[] = [];
  private pendingLineRoads: PreparedRoad[] | null = null;
  private fallbackLines: CesiumType.PolylineCollection | null = null;
  private roads: PreparedRoad[] = [];
  private particles: TrafficParticle[] = [];
  private detectionTargets: DetectionTarget[] = [];

  private scratchPos: CesiumType.Cartesian3;
  private scratchPickCarto: CesiumType.Cartographic;
  private scratchPickWorld: CesiumType.Cartesian3;
  private scratchPickScreen: CesiumType.Cartesian2;
  private bucketColors: Record<FlowBucket, CesiumType.Color>;
  private lineColors: Record<FlowBucket, CesiumType.Color>;
  private outlineColor: CesiumType.Color;
  private scaleByDistance: CesiumType.NearFarScalar | undefined;
  private translucencyByDistance: CesiumType.NearFarScalar | undefined;

  private tileCache = new Map<string, { at: number; stale: boolean; segments: TrafficFlowSegment[] }>();
  private surfaceHeights = new Map<string, number>();
  private lastSurfaceMode = '';

  private enabled = false;
  private showLines = false;
  private hasKey: boolean | null = null;
  private fetchSeq = 0;
  private activeAbort: AbortController | null = null;
  private refineRunning = false;
  private lastFetchCenter: { lat: number; lon: number; atMs: number } | null = null;
  private lastFetchBounds: TileBBox | null = null;
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

    const BlendOption = (Cesium as unknown as { BlendOption?: { TRANSLUCENT?: unknown } }).BlendOption;
    this.pointCollection = BlendOption?.TRANSLUCENT
      ? new (Cesium.PointPrimitiveCollection as unknown as new (opts?: unknown) => CesiumType.PointPrimitiveCollection)({
          blendOption: BlendOption.TRANSLUCENT,
        })
      : new Cesium.PointPrimitiveCollection();
    viewer.scene.primitives.add(this.pointCollection);

    this.scratchPos = new Cesium.Cartesian3();
    this.scratchPickCarto = new Cesium.Cartographic();
    this.scratchPickWorld = new Cesium.Cartesian3();
    this.scratchPickScreen = new Cesium.Cartesian2();

    this.bucketColors = {
      free: Cesium.Color.fromCssColorString(FLOW_BUCKET_HEX.free).withAlpha(0.95),
      slow: Cesium.Color.fromCssColorString(FLOW_BUCKET_HEX.slow).withAlpha(0.95),
      jam: Cesium.Color.fromCssColorString(FLOW_BUCKET_HEX.jam).withAlpha(0.95),
    };
    this.lineColors = {
      free: Cesium.Color.fromCssColorString(FLOW_BUCKET_HEX.free).withAlpha(0.75),
      slow: Cesium.Color.fromCssColorString(FLOW_BUCKET_HEX.slow).withAlpha(0.82),
      jam: Cesium.Color.fromCssColorString(FLOW_BUCKET_HEX.jam).withAlpha(0.88),
    };
    this.outlineColor = Cesium.Color.BLACK.withAlpha(0.75);

    if (typeof Cesium.NearFarScalar === 'function') {
      this.scaleByDistance = new Cesium.NearFarScalar(150, 1.35, 10_000, 0.35);
      this.translucencyByDistance = new Cesium.NearFarScalar(250, 1.0, 14_000, 0.15);
    }
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      void ensureGeoidReady();
      this.hasKey = null;
      this.lastFetchCenter = null;
      this.lastFetchBounds = null;
      this.installListeners();
      void this.refresh(true);
    } else {
      this.abortInFlight();
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

  setLinesEnabled(enabled: boolean) {
    if (this.showLines === enabled) return;
    this.showLines = enabled;
    if (!this.enabled) return;
    if (!enabled) {
      this.clearLinesOnly();
      return;
    }
    if (this.roads.length) {
      if (this.linesBuilding()) {
        this.pendingLineRoads = this.roads;
      } else {
        this.rebuildFlowLines(this.roads);
      }
    }
  }

  private abortInFlight() {
    this.fetchSeq++;
    this.activeAbort?.abort();
    this.activeAbort = null;
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

  private removeGroundPrimitiveList(list: GroundPrim[]) {
    if (!this.viewer.isDestroyed()) {
      for (const prim of list) {
        this.viewer.scene.groundPrimitives.remove(prim);
      }
    }
    list.length = 0;
  }

  private clearLinesOnly() {
    this.pendingLineRoads = null;
    this.removeGroundPrimitiveList(this.groundPrimitives);
    this.removeGroundPrimitiveList(this.retiredGroundPrimitives);
    if (!this.viewer.isDestroyed() && this.fallbackLines) {
      this.viewer.scene.primitives.remove(this.fallbackLines);
      this.fallbackLines = null;
    }
  }

  private clearVisuals() {
    this.clearLinesOnly();
    this.pointCollection.removeAll();
    this.particles = [];
    this.roads = [];
  }

  private linesBuilding(): boolean {
    return this.groundPrimitives.some((prim) => prim && prim.ready === false);
  }

  private retireGroundPrimitives() {
    if (this.linesBuilding()) return;
    if (this.retiredGroundPrimitives.length > 0) {
      this.removeGroundPrimitiveList(this.retiredGroundPrimitives);
    }
    if (this.pendingLineRoads) {
      const next = this.pendingLineRoads;
      this.pendingLineRoads = null;
      this.rebuildFlowLines(next);
    }
  }

  private async ensureKeyStatus(signal: AbortSignal): Promise<boolean> {
    if (this.hasKey !== null) return this.hasKey;
    try {
      const resp = await fetch('/api/tomtom/status', { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as { hasKey?: boolean };
      this.hasKey = Boolean(json?.hasKey);
      return this.hasKey;
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err;
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
    signal: AbortSignal,
  ): Promise<{ stale: boolean; segments: TrafficFlowSegment[] }> {
    const key = `${z}/${x}/${y}`;
    const now = Date.now();
    const cached = this.tileCache.get(key);
    if (cached && now - cached.at < CLIENT_TILE_TTL_MS) {
      return { stale: cached.stale, segments: cached.segments };
    }

    const resp = await fetch(`/api/tomtom/flow/${z}/${x}/${y}.pbf`, { signal });
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
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
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

    const viewCenter = this.resolveCameraFetchCenter();
    if (!viewCenter) return;

    if (viewCenter.altitudeM > ACTIVATION_ALTITUDE_M) {
      this.abortInFlight();
      this.clearVisuals();
      this.detectionTargets = [];
      this.lastFetchBounds = null;
      this.lastFetchCenter = null;
      this.onStats({
        loading: false,
        count: 0,
        status: 'LIVE',
        sourceLabel: 'TomTom · Zoom < 14km',
        error: null,
      });
      return;
    }

    const bounds = clampBoundsAroundCenter(viewCenter.lat, viewCenter.lon, 0.025);
    const now = Date.now();
    if (!force && this.lastFetchCenter && this.lastFetchBounds) {
      const shiftKm = greatCircleKmBetween(this.lastFetchCenter, {
        lat: viewCenter.lat,
        lon: viewCenter.lon,
      });
      if (
        boundsOverlap(bounds, this.lastFetchBounds, 0.6) &&
        shiftKm < MIN_CENTER_SHIFT_KM &&
        now - this.lastFetchCenter.atMs < REFRESH_TTL_MS
      ) {
        return;
      }
    }

    this.abortInFlight();
    const seq = this.fetchSeq;
    const controller = new AbortController();
    this.activeAbort = controller;

    let keyReady = false;
    try {
      keyReady = await this.ensureKeyStatus(controller.signal);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
    }
    if (!this.enabled || seq !== this.fetchSeq || controller.signal.aborted || this.viewer.isDestroyed()) {
      return;
    }

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

    this.onStats({
      loading: true,
      status: this.roads.length ? 'LIVE' : 'LOADING',
      sourceLabel: 'TomTom Flow',
      error: null,
    });

    const tiles = tilesForBounds(bounds, 12, 4);

    try {
      const results = await Promise.allSettled(
        tiles.map((t) => this.fetchTile(t.z, t.x, t.y, controller.signal)),
      );
      if (!this.enabled || seq !== this.fetchSeq || controller.signal.aborted || this.viewer.isDestroyed()) {
        return;
      }

      const settled: Array<{ stale: boolean; segments: TrafficFlowSegment[] }> = [];
      let rejectedError: string | null = null;
      for (const r of results) {
        if (r.status === 'fulfilled') settled.push(r.value);
        else if (!rejectedError && (r.reason as { name?: string })?.name !== 'AbortError') {
          rejectedError = r.reason instanceof Error ? r.reason.message : 'upstream';
        }
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
      this.lastFetchBounds = bounds;

      // Clip decoded tile lines to the camera bounds and yield between tiles so frames stay smooth
      const clippedSegments: TrafficFlowSegment[] = [];
      let anyStale = false;
      const majorOnly = viewCenter.altitudeM > FAST_FETCH_ALTITUDE_M;

      for (let tIdx = 0; tIdx < settled.length; tIdx++) {
        const item = settled[tIdx];
        if (item.stale) anyStale = true;
        for (const seg of item.segments) {
          if (
            majorOnly &&
            seg.highway !== 'motorway' &&
            seg.highway !== 'trunk' &&
            seg.highway !== 'primary'
          ) {
            continue;
          }
          for (const clippedCoords of clipLineToBounds(seg.coords, bounds)) {
            const simplified = simplifyRoadCoords(clippedCoords, 18, 40);
            if (simplified.length >= 2) {
              clippedSegments.push({ ...seg, coords: simplified });
            }
          }
        }
        if (tIdx < settled.length - 1) {
          await yieldSlice();
          if (!this.enabled || seq !== this.fetchSeq || controller.signal.aborted || this.viewer.isDestroyed()) {
            return;
          }
        }
      }

      this.buildSceneGeometry(clippedSegments, viewCenter.altitudeM, viewCenter.lat, viewCenter.lon, seq);

      this.onStats({
        loading: false,
        count: this.roads.length,
        status: anyStale ? 'STALE' : 'LIVE',
        sourceLabel: anyStale ? 'TomTom (Cached)' : 'TomTom Flow',
        error: null,
      });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      if (!this.enabled || seq !== this.fetchSeq) return;
      this.onStats({
        loading: false,
        status: this.roads.length ? 'STALE' : 'ERROR',
        error: err instanceof Error ? err.message : 'TomTom traffic error',
      });
    }
  }

  private surfaceModeKey(): string {
    return this.viewer.scene.globe?.show === false ? 'tiles' : 'globe';
  }

  private fastSurfaceHeightM(lon: number, lat: number, fallbackAltM: number): number {
    const mode = this.surfaceModeKey();
    if (mode !== this.lastSurfaceMode) {
      this.surfaceHeights.clear();
      this.lastSurfaceMode = mode;
    }

    const key = quantizeHeightKey(lat, lon);
    const cached = this.surfaceHeights.get(key);
    if (cached !== undefined) return cached + 3;

    if (this.viewer.scene.globe?.show) {
      this.scratchPickCarto.longitude = (lon * Math.PI) / 180;
      this.scratchPickCarto.latitude = (lat * Math.PI) / 180;
      this.scratchPickCarto.height = 0;
      const h = this.viewer.scene.globe.getHeight(this.scratchPickCarto);
      if (typeof h === 'number' && Number.isFinite(h)) {
        this.rememberHeight(key, h);
        return h + 3;
      }
    }

    return fallbackAltM + 3;
  }

  private rememberHeight(key: string, altM: number) {
    if (!Number.isFinite(altM) || Math.abs(altM) > 9_000) return;
    if (this.surfaceHeights.size >= SURFACE_CACHE_MAX) {
      const oldest = this.surfaceHeights.keys().next().value;
      if (oldest) this.surfaceHeights.delete(oldest);
    }
    this.surfaceHeights.set(key, altM);
  }

  /** Depth-buffer pick at road coordinates (zero extra Cesium scene render pass). */
  private sampleDepthBufferHeight(lon: number, lat: number, estimateAltM: number): number | undefined {
    const scene = this.viewer.scene as CesiumType.Scene & {
      pickPositionSupported?: boolean;
      pickTranslucentDepth?: boolean;
      pickPosition?: (winPos: CesiumType.Cartesian2) => CesiumType.Cartesian3 | undefined;
    };
    if (
      !scene.pickPositionSupported ||
      scene.pickTranslucentDepth ||
      typeof scene.pickPosition !== 'function' ||
      typeof this.Cesium.SceneTransforms?.worldToWindowCoordinates !== 'function'
    ) {
      return undefined;
    }
    const w = scene.canvas.clientWidth || 0;
    const h = scene.canvas.clientHeight || 0;
    if (w <= 0 || h <= 0) return undefined;

    let alt = Number.isFinite(estimateAltM) ? estimateAltM : 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.Cesium.Cartesian3.fromDegrees(lon, lat, alt, this.Cesium.Ellipsoid.WGS84, this.scratchPickWorld);
      const win = this.Cesium.SceneTransforms.worldToWindowCoordinates(
        scene,
        this.scratchPickWorld,
        this.scratchPickScreen,
      );
      if (!win || win.x < 0 || win.y < 0 || win.x >= w || win.y >= h) return undefined;
      let hit: CesiumType.Cartesian3 | undefined;
      try {
        hit = scene.pickPosition(win);
      } catch {
        return undefined;
      }
      if (!hit) return undefined;
      const carto = this.Cesium.Cartographic.fromCartesian(hit, this.Cesium.Ellipsoid.WGS84, this.scratchPickCarto);
      if (!carto || !Number.isFinite(carto.height) || Math.abs(carto.height) > 9_000) return undefined;
      const dx = (this.Cesium.Math.toDegrees(carto.longitude) - lon) * Math.cos((lat * Math.PI) / 180) * 111_320;
      const dy = (this.Cesium.Math.toDegrees(carto.latitude) - lat) * 111_320;
      if (Math.hypot(dx, dy) <= 3) return carto.height;
      alt = carto.height;
    }
    return undefined;
  }

  /**
   * Time-sliced background height refinement for 3D Tiles mode (ported from upstream surface.js).
   * Never blocks a single frame > ~5 ms, samples only 150 m road stations, and updates dots in place.
   */
  private async startSurfaceRefinement(seq: number) {
    if (this.refineRunning || this.viewer.isDestroyed() || this.viewer.scene.globe?.show !== false) {
      return;
    }
    const scene = this.viewer.scene as CesiumType.Scene & {
      sampleHeightSupported?: boolean;
      sampleHeight?: (carto: CesiumType.Cartographic, objectsToExclude?: unknown[]) => number | undefined;
    };
    if (!scene.sampleHeightSupported && !scene.pickPositionSupported) return;

    this.refineRunning = true;
    try {
      let sliceStart = performance.now();
      let sampleCountInSlice = 0;
      let totalSampleHeightCalls = 0;
      const missedInPass = new Set<string>();

      for (const road of this.roads) {
        if (!this.enabled || seq !== this.fetchSeq || this.viewer.isDestroyed()) return;
        const coords = road.seg.coords;
        const indices = road.heightIndices;
        const distances = road.heightDistances;
        const stationHeights = new Map<number, number>();

        for (const idx of indices) {
          const [lon, lat] = coords[idx];
          const key = quantizeHeightKey(lat, lon);
          let h = this.surfaceHeights.get(key);

          if (h === undefined && !missedInPass.has(key)) {
            const geoidEstimate = geoidHeightOrZero(lat, lon);
            h = this.sampleDepthBufferHeight(lon, lat, geoidEstimate);
            if (
              h === undefined &&
              totalSampleHeightCalls < REFINE_MAX_SAMPLE_HEIGHT_TOTAL &&
              scene.sampleHeightSupported &&
              typeof scene.sampleHeight === 'function'
            ) {
              sampleCountInSlice++;
              totalSampleHeightCalls++;
              try {
                this.scratchPickCarto.longitude = (lon * Math.PI) / 180;
                this.scratchPickCarto.latitude = (lat * Math.PI) / 180;
                this.scratchPickCarto.height = 0;
                const sh = scene.sampleHeight(this.scratchPickCarto, [this.pointCollection]);
                if (typeof sh === 'number' && Number.isFinite(sh) && Math.abs(sh) <= 9_000) {
                  h = sh;
                }
              } catch {
                // Tile may still be streaming
              }
            }
            if (h !== undefined) {
              this.rememberHeight(key, h);
            } else {
              missedInPass.add(key);
            }
          }

          if (h !== undefined) {
            stationHeights.set(idx, h);
          }

          if (
            sampleCountInSlice >= REFINE_MAX_SAMPLES_PER_SLICE ||
            performance.now() - sliceStart >= REFINE_SLICE_BUDGET_MS
          ) {
            await yieldSlice();
            if (!this.enabled || seq !== this.fetchSeq || this.viewer.isDestroyed()) return;
            sliceStart = performance.now();
            sampleCountInSlice = 0;
          }
        }

        if (stationHeights.size === 0) continue;

        let stPtr = 1;
        for (let i = 0; i < coords.length; i++) {
          while (stPtr < indices.length - 1 && i > indices[stPtr]) stPtr++;
          const aIdx = indices[stPtr - 1];
          const bIdx = indices[stPtr];
          const ha = stationHeights.get(aIdx);
          const hb = stationHeights.get(bIdx);
          if (ha === undefined && hb === undefined) continue;
          const span = distances[bIdx] - distances[aIdx];
          const interpH =
            ha !== undefined && hb !== undefined
              ? span > 0
                ? ha + ((hb - ha) * (distances[i] - distances[aIdx])) / span
                : ha
              : (ha ?? hb ?? 0);
          const [lon, lat] = coords[i];
          this.Cesium.Cartesian3.fromDegrees(
            lon,
            lat,
            interpH + 3,
            this.Cesium.Ellipsoid.WGS84,
            road.waypoints[i],
          );
        }
      }
    } finally {
      this.refineRunning = false;
    }
  }

  private buildSceneGeometry(
    segments: TrafficFlowSegment[],
    altitudeM: number,
    centerLat: number,
    centerLon: number,
    seq: number,
  ) {
    this.pointCollection.removeAll();
    this.particles = [];
    this.roads = [];
    this.detectionTargets = [];

    const rank: Record<FlowBucket, number> = { jam: 0, slow: 1, free: 2 };
    const sorted = [...segments].sort((a, b) => rank[a.bucket] - rank[b.bucket]);
    const capped = sorted.slice(0, MAX_PREPARED_ROADS);

    // One cheap baseline ground estimate for the center view (zero per-vertex sampleHeight calls)
    let baselineAltM = geoidHeightOrZero(centerLat, centerLon);
    if (this.viewer.scene.globe?.show) {
      this.scratchPickCarto.longitude = (centerLon * Math.PI) / 180;
      this.scratchPickCarto.latitude = (centerLat * Math.PI) / 180;
      this.scratchPickCarto.height = 0;
      const gh = this.viewer.scene.globe.getHeight(this.scratchPickCarto);
      if (typeof gh === 'number' && Number.isFinite(gh)) baselineAltM = gh;
    } else {
      const centerKey = quantizeHeightKey(centerLat, centerLon);
      const cachedCenter = this.surfaceHeights.get(centerKey);
      if (cachedCenter !== undefined) {
        baselineAltM = cachedCenter;
      } else {
        const scene = this.viewer.scene as CesiumType.Scene & {
          sampleHeightSupported?: boolean;
          sampleHeight?: (carto: CesiumType.Cartographic, exclude?: unknown[]) => number | undefined;
        };
        if (scene.sampleHeightSupported && typeof scene.sampleHeight === 'function') {
          try {
            this.scratchPickCarto.longitude = (centerLon * Math.PI) / 180;
            this.scratchPickCarto.latitude = (centerLat * Math.PI) / 180;
            this.scratchPickCarto.height = 0;
            const sh = scene.sampleHeight(this.scratchPickCarto, [this.pointCollection]);
            if (typeof sh === 'number' && Number.isFinite(sh) && Math.abs(sh) <= 9_000) {
              baselineAltM = sh;
              this.rememberHeight(centerKey, sh);
            }
          } catch {
            // Fallback keeps baseline geoid height
          }
        }
      }
    }

    const prepared: PreparedRoad[] = [];
    for (const seg of capped) {
      const segmentDist: number[] = [];
      const waypoints: CesiumType.Cartesian3[] = [];
      let total = 0;
      for (let i = 0; i < seg.coords.length; i++) {
        const [lon, lat] = seg.coords[i];
        const altM = this.fastSurfaceHeightM(lon, lat, baselineAltM);
        waypoints.push(this.Cesium.Cartesian3.fromDegrees(lon, lat, altM));
        if (i > 0) {
          const [prevLon, prevLat] = seg.coords[i - 1];
          const segM = greatCircleKmBetween({ lat: prevLat, lon: prevLon }, { lat, lon }) * 1000;
          segmentDist.push(segM);
          total += segM;
        }
      }
      if (waypoints.length >= 2 && total > 5) {
        const stations = roadHeightStations(seg.coords, 150);
        prepared.push({
          seg,
          waypoints,
          segmentDist,
          totalDistM: total,
          heightIndices: stations.indices,
          heightDistances: stations.distances,
        });
      }
    }
    this.roads = prepared;

    // 1. Rebuild GroundPolylinePrimitive batch only when LINES toggle is active
    if (!this.showLines) {
      this.clearLinesOnly();
    } else if (this.linesBuilding()) {
      this.pendingLineRoads = prepared;
    } else {
      this.rebuildFlowLines(prepared);
    }

    // 2. Spawn animated moving traffic dots scaled smoothly with altitude
    let particleBudget = roadDotBudget(altitudeM, MAX_PARTICLES);
    const roadDotBaseOpts = {
      outlineColor: this.outlineColor,
      outlineWidth: 1,
      disableDepthTestDistance: 0,
      ...(this.scaleByDistance ? { scaleByDistance: this.scaleByDistance } : {}),
      ...(this.translucencyByDistance ? { translucencyByDistance: this.translucencyByDistance } : {}),
    };

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
        6,
        Math.max(
          1,
          Math.round((road.totalDistM / 200) * baseDensity * flowDensityMult(road.seg.trafficLevel)),
        ),
      );
      const count = Math.min(desiredDots, particleBudget);
      particleBudget -= count;

      const color = this.bucketColors[road.seg.bucket];
      const baseSpeed = SPEED_BY_HIGHWAY_MPS[road.seg.highway] ?? 12;
      const speedMps = baseSpeed * flowSpeedScale(road.seg.trafficLevel);
      const pixelSize = PIXEL_SIZE_BY_HIGHWAY[road.seg.highway] ?? 5;
      const numSegments = road.segmentDist.length;

      for (let d = 0; d < count; d++) {
        const segIdx = Math.floor((numSegments * d) / count) % numSegments;
        const t = ((d + 0.5) / count) % 1;
        this.Cesium.Cartesian3.lerp(
          road.waypoints[segIdx],
          road.waypoints[segIdx + 1],
          t,
          this.scratchPos,
        );
        const point = this.pointCollection.add({
          position: this.Cesium.Cartesian3.clone
            ? this.Cesium.Cartesian3.clone(this.scratchPos)
            : new this.Cesium.Cartesian3(this.scratchPos.x, this.scratchPos.y, this.scratchPos.z),
          color,
          pixelSize,
          ...roadDotBaseOpts,
        });
        this.particles.push({
          road,
          segIdx,
          t,
          direction: d % 2 === 0 ? 1 : -1,
          speedMps,
          point,
        });
      }
    }

    // Refine 3D Tile surface heights asynchronously in 5 ms slices
    if (this.viewer.scene.globe?.show === false && prepared.length > 0) {
      void this.startSurfaceRefinement(seq);
    }
  }

  private rebuildFlowLines(roads: PreparedRoad[]) {
    if (this.viewer.isDestroyed()) return;
    if (!this.showLines) {
      this.clearLinesOnly();
      return;
    }

    this.removeGroundPrimitiveList(this.retiredGroundPrimitives);
    if (this.fallbackLines) {
      this.viewer.scene.primitives.remove(this.fallbackLines);
      this.fallbackLines = null;
    }

    const previous = this.groundPrimitives;
    this.groundPrimitives = [];

    // Prioritize congested corridors + major arterial flow lines (skips heavy OBB extrusion on minor green streets)
    const lineCandidates = roads.filter(
      (r) =>
        r.seg.bucket !== 'free' ||
        r.seg.highway === 'motorway' ||
        r.seg.highway === 'trunk' ||
        r.seg.highway === 'primary',
    );
    const rank: Record<FlowBucket, number> = { jam: 0, slow: 1, free: 2 };
    lineCandidates.sort((a, b) =>
      a.seg.bucket === b.seg.bucket
        ? b.totalDistM - a.totalDistM
        : rank[a.seg.bucket] - rank[b.seg.bucket],
    );
    const keptLines = lineCandidates.slice(0, FLOW_LINE_CAP);

    const groundSupported = this.Cesium.GroundPolylinePrimitive.isSupported(this.viewer.scene);
    if (groundSupported) {
      const byBucket: Record<FlowBucket, CesiumType.GeometryInstance[]> = {
        free: [],
        slow: [],
        jam: [],
      };
      for (const road of keptLines) {
        byBucket[road.seg.bucket].push(
          new this.Cesium.GeometryInstance({
            geometry: new this.Cesium.GroundPolylineGeometry({
              positions: road.waypoints,
              width: road.seg.bucket === 'jam' ? 3.8 : 2.6,
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
                color: this.lineColors[bucket],
              }),
            }),
          }),
        ) as GroundPrim;
        this.groundPrimitives.push(prim);
      }

      if (this.groundPrimitives.length > 0 && previous.length > 0) {
        // Retain previous batch only until the replacement batch finishes async worker compilation
        this.retiredGroundPrimitives.push(...previous);
      } else {
        this.removeGroundPrimitiveList(previous);
      }
    } else {
      this.removeGroundPrimitiveList(previous);
      const col = new this.Cesium.PolylineCollection();
      this.viewer.scene.primitives.add(col);
      this.fallbackLines = col;
      for (const road of keptLines) {
        col.add({
          positions: road.waypoints,
          width: road.seg.bucket === 'jam' ? 3.5 : 2.4,
          material: this.Cesium.Material.fromType('Color', {
            color: this.lineColors[road.seg.bucket],
          }),
        });
      }
    }
  }

  tick(dtSec: number) {
    if (!this.enabled) return;
    if (this.retiredGroundPrimitives.length > 0 || this.pendingLineRoads) {
      this.retireGroundPrimitives();
    }
    if (!this.particles.length) return;

    const clampedDt = Math.min(0.1, Math.max(0, dtSec));
    if (clampedDt <= 0) return;

    const lerp = this.Cesium.Cartesian3.lerp;
    const scratch = this.scratchPos;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      const segs = p.road.segmentDist;
      const wps = p.road.waypoints;
      const numSegs = segs.length;
      if (numSegs <= 0) continue;

      let travel = p.speedMps * clampedDt;
      while (travel > 0) {
        const segLen = Math.max(0.05, segs[p.segIdx]);
        const avail = (p.direction > 0 ? 1 - p.t : p.t) * segLen;
        if (travel < avail) {
          p.t += (travel / segLen) * p.direction;
          break;
        }
        travel -= avail;
        const nextSeg = p.segIdx + p.direction;
        if (nextSeg < 0 || nextSeg >= numSegs) {
          p.segIdx = p.direction > 0 ? 0 : numSegs - 1;
          p.t = p.direction > 0 ? 0 : 1;
          break;
        }
        p.segIdx = nextSeg;
        p.t = p.direction > 0 ? 0 : 1;
      }

      lerp(wps[p.segIdx], wps[p.segIdx + 1], p.t, scratch);
      p.point.position = scratch;
    }
  }

  getTickData(): { detectionTargets: DetectionTarget[] } {
    return {
      detectionTargets: this.enabled ? this.detectionTargets : [],
    };
  }

  destroy() {
    this.abortInFlight();
    this.teardownListeners();
    this.clearVisuals();
    this.surfaceHeights.clear();
    if (!this.viewer.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.pointCollection);
    }
  }
}
