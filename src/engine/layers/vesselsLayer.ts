import type * as CesiumType from 'cesium';
import type { DetectionTarget, SelectedEntityInfo } from '@/types/gev';
import { ensureGeoidReady, geoidHeightOrZero } from '../geoid';
import {
  HorizonOccluder,
  ScreenHeadingProjector,
  shortestAngleDelta,
} from '../horizonAndHeading';

const VESSEL_LIFT_M = 3;
const TRAIL_HEIGHT_M = 3;
const TRAIL_COLOR = '#39ffd5';
const KNOT_TO_MPS = 0.514444;
const MAX_DISPLAY_VESSELS = 12_000;
const ROTATION_DEADBAND_RAD = 0.005;

interface BillboardSlot {
  bb: CesiumType.Billboard;
  iconKey: string;
  scale: number;
  show: boolean;
}

const NUMERIC_TYPE_SPECIALS: Record<number, string> = {
  30: 'FISHING',
  31: 'TOWING',
  32: 'TOWING',
  33: 'DREDGER',
  34: 'DIVE OPS',
  35: 'MILITARY',
  36: 'SAILING',
  37: 'PLEASURE',
  50: 'PILOT',
  51: 'SAR',
  52: 'TUG',
  53: 'PORT TENDER',
  54: 'ANTI-POLLUTION',
  55: 'LAW ENFORCE',
  58: 'MEDICAL',
};

const NUMERIC_TYPE_FAMILIES: Record<number, string> = {
  4: 'HIGH-SPEED',
  6: 'PASSENGER',
  7: 'CARGO',
  8: 'TANKER',
  9: 'OTHER',
};

export function normalizeVesselType(type: string): string {
  const text = String(type || '').trim();
  if (!text || !/^\d+$/.test(text)) return text;
  const code = Number(text);
  if (code <= 0 || code >= 100) return '';
  if (NUMERIC_TYPE_SPECIALS[code]) return NUMERIC_TYPE_SPECIALS[code];
  return NUMERIC_TYPE_FAMILIES[Math.floor(code / 10)] || 'OTHER';
}

const TYPE_STYLES: Array<{ pattern: RegExp; css: string }> = [
  { pattern: /tanker/i, css: '#ffb347' },
  { pattern: /cargo|container|bulk|carrier/i, css: '#39d5ff' },
  { pattern: /passenger|ferry|cruise/i, css: '#ff7adf' },
  { pattern: /fishing/i, css: '#7cff9b' },
  { pattern: /tug|tow|pilot|supply|service/i, css: '#f7f0a3' },
  { pattern: /military|law|sar/i, css: '#ffb800' },
];

export function vesselTypeCss(type: string): string {
  const normalized = normalizeVesselType(type);
  return TYPE_STYLES.find((entry) => entry.pattern.test(normalized))?.css || '#39d5ff';
}

export interface VesselRecord {
  entityId: string;
  mmsi: string;
  name: string;
  imo: string;
  type: string;
  displayType: string;
  destination: string;
  lat: number;
  lon: number;
  speedKts: number | null;
  speedMps: number;
  courseDeg: number | null;
  headingDeg: number | null;
  lastPositionUtc: string;
  observedAtMs: number;
}

interface VesselSnapshotPayload {
  rows?: Array<{
    lat: number;
    lon: number;
    name?: string;
    mmsi: string;
    imo?: string;
    type?: string;
    destination?: string;
    speed?: number | null;
    course?: number | null;
    heading?: number | null;
    last_position_UTC?: string;
    last_position_epoch?: number;
  }>;
  status?: string;
  error?: string | null;
  refreshing?: boolean;
}

export class VesselsLayerController {
  private viewer: CesiumType.Viewer;
  private Cesium: typeof CesiumType;
  private billboards: CesiumType.BillboardCollection;
  private records = new Map<string, VesselRecord>();
  private billboardMap = new Map<string, BillboardSlot>();
  private iconCache = new Map<string, string>();
  private occluder: HorizonOccluder;
  private headingProjector: ScreenHeadingProjector;
  private scratchPos: CesiumType.Cartesian3;
  private trailEntity: CesiumType.Entity | null = null;
  private trailFetchedFor: string | null = null;
  private trailSamples: Array<{ lat: number; lon: number }> = [];

  private enabled = false;
  private selectedEntityId: string | null = null;
  private pollTimer: number | null = null;
  private fastBootstrapPolls = 0;

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
    onStats: VesselsLayerController['onStats'],
  ) {
    this.viewer = viewer;
    this.Cesium = Cesium;
    this.onStats = onStats;
    this.scratchPos = new Cesium.Cartesian3();
    this.occluder = new HorizonOccluder(Cesium, viewer.camera.positionWC);
    this.headingProjector = new ScreenHeadingProjector(Cesium);
    this.billboards = new Cesium.BillboardCollection({
      scene: viewer.scene,
      blendOption: Cesium.BlendOption.TRANSLUCENT,
    });
    this.billboards.show = false;
    viewer.scene.primitives.add(this.billboards);
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.billboards.show = enabled;

    if (enabled) {
      this.fastBootstrapPolls = 0;
      void ensureGeoidReady(() => {
        if (this.enabled && this.selectedEntityId?.startsWith('vessel:')) {
          this.syncTrailPolyline();
        }
      });
      void this.poll();
      this.scheduleNextPoll();
    } else {
      if (this.pollTimer !== null) clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.billboards.removeAll();
      this.billboardMap.clear();
      this.records.clear();
      this.clearTrail();
      this.onStats({ loading: false, count: 0, status: 'IDLE', error: null });
    }
  }

  setSelectedEntityId(entityId: string | null) {
    this.selectedEntityId = entityId;
    if (!entityId || !entityId.startsWith('vessel:')) {
      this.clearTrail();
      return;
    }
    const mmsi = entityId.slice('vessel:'.length);
    if (this.trailFetchedFor !== mmsi) {
      this.trailFetchedFor = mmsi;
      this.trailSamples = [];
      void this.loadVesselTrack(mmsi);
    }
  }

  private clearTrail() {
    if (this.trailEntity) {
      this.viewer.entities.remove(this.trailEntity);
      this.trailEntity = null;
    }
    this.trailFetchedFor = null;
    this.trailSamples = [];
  }

  private scheduleNextPoll() {
    if (!this.enabled) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    // Poll briskly while AISStream fills its initial vessel cache, then settle to 25s
    const intervalMs =
      this.records.size < 25 && this.fastBootstrapPolls < 6 ? 6_000 : 25_000;
    this.pollTimer = window.setTimeout(() => {
      this.fastBootstrapPolls++;
      void this.poll().finally(() => this.scheduleNextPoll());
    }, intervalMs);
  }

  private shipIcon(displayType: string, selected: boolean): { key: string; url: string } {
    const cssColor = selected ? '#ffffff' : vesselTypeCss(displayType);
    const key = `${cssColor}:${selected ? 'selected' : 'normal'}`;
    const existing = this.iconCache.get(key);
    if (existing) return { key, url: existing };

    const stroke = selected ? 'rgba(6,26,32,0.95)' : 'rgba(4,18,24,0.9)';
    const strokeWidth = selected ? 1.1 : 0.7;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g transform="translate(16,16)"><path d="M0,-14 L11,10 L4,7 L0,14 L-4,7 L-11,10 Z" fill="${cssColor}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/></g></svg>`;
    const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    this.iconCache.set(key, url);
    return { key, url };
  }

  private shipScale(speedKts: number | null): number {
    const s = Number(speedKts || 0);
    if (s >= 18) return 0.76;
    if (s >= 8) return 0.66;
    return 0.56;
  }

  private datumHeightM(lat: number, lon: number, liftM: number): number {
    return geoidHeightOrZero(lat, lon) + liftM;
  }

  private async loadVesselTrack(mmsi: string) {
    try {
      const resp = await fetch(`/api/vessels/track?mmsi=${encodeURIComponent(mmsi)}`);
      if (!resp.ok) return;
      const json = (await resp.json()) as {
        samples?: Array<{ lat: number; lon: number; t: number }>;
      };
      if (!this.enabled || this.trailFetchedFor !== mmsi) return;
      this.trailSamples = (json.samples || []).filter(
        (s) => Number.isFinite(s.lat) && Number.isFinite(s.lon),
      );
      this.syncTrailPolyline();
    } catch {
      // non-fatal
    }
  }

  private syncTrailPolyline() {
    if (!this.selectedEntityId?.startsWith('vessel:')) {
      this.clearTrail();
      return;
    }
    const rec = this.records.get(this.selectedEntityId);
    if (!rec) return;
    const pts = [...this.trailSamples, { lat: rec.lat, lon: rec.lon }];
    if (pts.length < 2) return;

    const coords: number[] = [];
    for (const p of pts) {
      coords.push(p.lon, p.lat, this.datumHeightM(p.lat, p.lon, TRAIL_HEIGHT_M));
    }
    const positions = this.Cesium.Cartesian3.fromDegreesArrayHeights(coords);
    const material = new this.Cesium.PolylineGlowMaterialProperty({
      glowPower: 0.25,
      color: this.Cesium.Color.fromCssColorString(TRAIL_COLOR).withAlpha(0.85),
    });

    if (!this.trailEntity) {
      this.trailEntity = this.viewer.entities.add({
        polyline: { positions, width: 2.5, material },
      });
    } else if (this.trailEntity.polyline) {
      this.trailEntity.polyline.positions = new this.Cesium.ConstantProperty(positions);
    }
  }

  private async poll() {
    if (!this.enabled) return;
    this.onStats({
      loading: this.records.size === 0,
      status: this.records.size > 0 ? 'LIVE' : 'LOADING',
    });

    try {
      const resp = await fetch(`/api/vessels?maxRows=${MAX_DISPLAY_VESSELS}`);
      const json = (await resp.json()) as VesselSnapshotPayload;
      if (!this.enabled) return;

      if (resp.status === 503 || json.status === 'missing-key') {
        this.onStats({
          loading: false,
          count: 0,
          status: 'ERROR',
          sourceLabel: 'AISStream',
          error: 'AISSTREAM_API_KEY not set — add in POWER UP',
        });
        return;
      }

      if (!resp.ok) {
        throw new Error(json.error || `HTTP ${resp.status}`);
      }

      const rows = Array.isArray(json.rows) ? json.rows : [];
      const seen = new Set<string>();

      for (const row of rows) {
        const mmsi = String(row.mmsi || '').trim();
        if (!mmsi || !Number.isFinite(row.lat) || !Number.isFinite(row.lon)) continue;
        const entityId = `vessel:${mmsi}`;
        seen.add(entityId);

        const rawType = String(row.type || '');
        const displayType = normalizeVesselType(rawType);
        const speedKts = typeof row.speed === 'number' && Number.isFinite(row.speed) ? row.speed : null;
        const observedAtMs =
          typeof row.last_position_epoch === 'number' && Number.isFinite(row.last_position_epoch)
            ? row.last_position_epoch * 1000
            : Date.now();

        this.records.set(entityId, {
          entityId,
          mmsi,
          name: String(row.name || `MMSI ${mmsi}`).trim(),
          imo: String(row.imo || ''),
          type: rawType,
          displayType: displayType || 'VESSEL',
          destination: String(row.destination || ''),
          lat: row.lat,
          lon: row.lon,
          speedKts,
          speedMps: speedKts !== null ? speedKts * KNOT_TO_MPS : 0,
          courseDeg:
            typeof row.course === 'number' && Number.isFinite(row.course) ? row.course : null,
          headingDeg:
            typeof row.heading === 'number' && Number.isFinite(row.heading) ? row.heading : null,
          lastPositionUtc: row.last_position_UTC || new Date(observedAtMs).toISOString(),
          observedAtMs,
        });
      }

      for (const entityId of this.records.keys()) {
        if (!seen.has(entityId)) {
          this.records.delete(entityId);
          const slot = this.billboardMap.get(entityId);
          if (slot) {
            this.billboards.remove(slot.bb);
            this.billboardMap.delete(entityId);
          }
        }
      }

      if (this.selectedEntityId?.startsWith('vessel:')) {
        const selectedRec = this.records.get(this.selectedEntityId);
        if (selectedRec) {
          this.syncTrailPolyline();
        }
      }

      const feedStatus = json.status || 'live';
      const mappedStatus =
        feedStatus === 'auth-failed' || feedStatus === 'down'
          ? 'ERROR'
          : feedStatus === 'stale' || feedStatus === 'reconnecting'
            ? 'STALE'
            : feedStatus === 'connecting' && rows.length === 0
              ? 'LOADING'
              : 'LIVE';

      this.onStats({
        loading: mappedStatus === 'LOADING',
        count: this.records.size,
        status: mappedStatus,
        sourceLabel:
          feedStatus === 'connecting' && rows.length === 0
            ? 'AISStream · connecting…'
            : 'AISStream',
        error: json.error || null,
      });
    } catch (err) {
      this.onStats({
        loading: false,
        status: this.records.size > 0 ? 'STALE' : 'ERROR',
        error: err instanceof Error ? err.message : 'AISStream feed unavailable',
      });
    }
  }

  private getDeadReckonedPosition(rec: VesselRecord, nowMs: number) {
    const dtSec = Math.min(180, Math.max(0, (nowMs - rec.observedAtMs) / 1000));
    const dir = rec.courseDeg ?? rec.headingDeg;
    if (rec.speedMps < 0.3 || dir === null || dtSec === 0) {
      return { lat: rec.lat, lon: rec.lon };
    }
    const distM = rec.speedMps * dtSec;
    const rad = (dir * Math.PI) / 180;
    const dNorth = (distM * Math.cos(rad)) / 111_320;
    const cosLat = Math.max(0.15, Math.cos((rec.lat * Math.PI) / 180));
    const dEast = (distM * Math.sin(rad)) / (111_320 * cosLat);
    return { lat: rec.lat + dNorth, lon: rec.lon + dEast };
  }

  tick(nowMs: number): {
    detectionTargets: DetectionTarget[];
    selectedInfo: SelectedEntityInfo | null;
    trackedHeadingDeg: number;
  } {
    if (!this.enabled) {
      return { detectionTargets: [], selectedInfo: null, trackedHeadingDeg: 0 };
    }

    const camPos = this.viewer.camera.positionWC;
    this.occluder.updateCamera(camPos);

    const detectionTargets: DetectionTarget[] = [];
    let selectedInfo: SelectedEntityInfo | null = null;
    let trackedHeadingDeg = 0;
    const ellipsoid = this.Cesium.Ellipsoid.WGS84;

    for (const rec of this.records.values()) {
      const pos = this.getDeadReckonedPosition(rec, nowMs);
      const isSelected = rec.entityId === this.selectedEntityId;

      // Test horizon visibility against the WGS84 surface (h = 0), not geoid height,
      // so negative-geoid harbors are not rejected near sea level while far-side ships stay culled.
      const visible = this.occluder.isLatLonVisible(pos.lat, pos.lon, 0);
      const altM = visible || isSelected || !this.billboardMap.has(rec.entityId)
        ? this.datumHeightM(pos.lat, pos.lon, VESSEL_LIFT_M)
        : VESSEL_LIFT_M;

      let slot = this.billboardMap.get(rec.entityId);
      let revealed = false;
      if (!slot) {
        const icon = this.shipIcon(rec.displayType, isSelected);
        const scale = isSelected ? 1.05 : this.shipScale(rec.speedKts);
        const initialPos = this.Cesium.Cartesian3.fromDegrees(
          pos.lon,
          pos.lat,
          altM,
          ellipsoid,
          this.scratchPos,
        );
        const bb = this.billboards.add({
          id: { entityId: rec.entityId, kind: 'vessels' },
          position: initialPos,
          show: visible,
          image: icon.url,
          scale,
          rotation: 0,
          alignedAxis: this.Cesium.Cartesian3.ZERO,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        });
        slot = { bb, iconKey: icon.key, scale, show: visible };
        this.billboardMap.set(rec.entityId, slot);
        revealed = visible;
      } else if (slot.show !== visible) {
        revealed = visible;
        slot.bb.show = visible;
        slot.show = visible;
      }

      if (visible) {
        const cartesian = this.Cesium.Cartesian3.fromDegrees(
          pos.lon,
          pos.lat,
          altM,
          ellipsoid,
          this.scratchPos,
        );
        slot.bb.position = cartesian;

        const icon = this.shipIcon(rec.displayType, isSelected);
        if (slot.iconKey !== icon.key) {
          slot.bb.image = icon.url;
          slot.iconKey = icon.key;
        }
        const scale = isSelected ? 1.05 : this.shipScale(rec.speedKts);
        if (slot.scale !== scale) {
          slot.bb.scale = scale;
          slot.scale = scale;
        }

        const dir = rec.headingDeg ?? rec.courseDeg ?? 0;
        const nextRot = this.headingProjector.compute(
          this.viewer.camera,
          cartesian,
          dir,
          slot.bb.rotation,
        );
        if (revealed || Math.abs(shortestAngleDelta(slot.bb.rotation, nextRot)) > ROTATION_DEADBAND_RAD) {
          slot.bb.rotation = nextRot;
        }

        const dMeters = this.Cesium.Cartesian3.distance(camPos, cartesian);
        if (dMeters < 3_500_000) {
          detectionTargets.push({
            entityId: rec.entityId,
            label: rec.name.slice(0, 22),
            sublabel: `${rec.displayType}${rec.speedKts !== null ? ` · ${rec.speedKts.toFixed(1)}KT` : ''}`,
            category: 'vessel',
            lat: pos.lat,
            lon: pos.lon,
            altM,
            color: vesselTypeCss(rec.displayType),
            priority: isSelected ? 10 : 3,
          });
        }
      }

      if (isSelected) {
        trackedHeadingDeg = rec.headingDeg ?? rec.courseDeg ?? 0;
        selectedInfo = {
          entityId: rec.entityId,
          kind: 'vessel',
          title: rec.name,
          subtitle: `MMSI ${rec.mmsi} · ${rec.displayType}`,
          lat: pos.lat,
          lon: pos.lon,
          altM,
          telemetry: [
            { label: 'MMSI / IMO', value: `${rec.mmsi}${rec.imo ? ` / ${rec.imo}` : ''}` },
            { label: 'VESSEL TYPE', value: rec.displayType },
            {
              label: 'SPEED (SOG)',
              value: rec.speedKts !== null ? `${rec.speedKts.toFixed(1)} kts` : '--',
            },
            {
              label: 'COURSE / HDG',
              value: `${rec.courseDeg !== null ? `${Math.round(rec.courseDeg)}°` : '--'} / ${rec.headingDeg !== null ? `${Math.round(rec.headingDeg)}°` : '--'}`,
            },
            { label: 'DESTINATION', value: rec.destination || '--' },
            { label: 'LAST FIX (UTC)', value: rec.lastPositionUtc.slice(0, 19).replace('T', ' ') + 'Z' },
          ],
        };
      }
    }

    return { detectionTargets, selectedInfo, trackedHeadingDeg };
  }

  destroy() {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.clearTrail();
    if (!this.viewer.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.billboards);
    }
  }
}
