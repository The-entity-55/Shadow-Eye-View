import type * as CesiumType from 'cesium';
import type {
  AirportEndpoint,
  DetectionTarget,
  FlightPrediction,
  FlightRouteInfo,
  Models3dMode,
  NearbyContact,
  SelectedEntityInfo,
} from '@/types/gev';
import { greatCircleKm } from '../hudMath';
import { ensureGeoidReady, geoidHeightOrZero } from '../geoid';
import {
  HorizonOccluder,
  ScreenHeadingProjector,
  lerpAngleDeg,
  shortestAngleDelta,
  trackedModelScaleForPixelCap,
} from '../horizonAndHeading';
import {
  bearingBetweenDeg,
  relativeBearingDeg,
  routePlausible,
} from '../routePlausible';
import {
  TRAIL_MAX_POINTS,
  mergeBackfillTrailPoints,
  parseOpenSkyTrackWaypoints,
  splitTrailIntoSegments,
  type TrailFixPoint,
} from '../trailContinuity';
import { computeKinematicPrediction } from '../flightPredictionMath';

const MODEL_HEADING_OFFSET_DEG = 180;
const MODEL_ALT_CEIL_M = 800_000;
const TRACKED_MODEL_ENTER_ALT_M = 150_000;
const PROXIMITY_MODEL_CAP = 18;
const ALL_MODEL_CAP = 42;
const MAX_DISPLAY_FLIGHTS = 1800;
const ROTATION_DEADBAND_RAD = 0.005;
const POSITION_HISTORY_LIMIT = 5;
const CIVIL_RENDER_DELAY_MS = 30_000;
const MIL_RENDER_DELAY_MS = 15_000;
const DR_CORRECTION_MS = 900;
const COAST_MAX_SPEED_MPS = (1_500 * 1852) / 3600;

export interface PositionFix {
  epochMs: number;
  lat: number;
  lon: number;
  altM: number;
  speedMps: number;
  courseDeg: number;
  verticalRateMps: number;
}

export interface AircraftRecord {
  entityId: string;
  icao24: string;
  callsign: string;
  originCountry: string;
  lon: number;
  lat: number;
  baroAltM: number;
  geoAltM: number;
  hasGeoAlt: boolean;
  onGround: boolean;
  speedMps: number;
  courseDeg: number;
  verticalRateMps: number;
  squawk: string | null;
  emergency: boolean;
  military: boolean;
  category: number;
  updatedAtMs: number;
  newestFixMs: number;
  history: PositionFix[];
  trail: TrailFixPoint[];
  backfilledTrack?: boolean;
  airline?: string | null;
  typeCode?: string | null;
  typeName?: string | null;
  registration?: string | null;
  route?: { origin: AirportEndpoint; destination: AirportEndpoint } | null;
}

interface ModelSpec {
  url: string;
  radiusM: number;
  bellyM: number;
}

function makePlaneSvg(color: string, shape: 'airliner' | 'jet' | 'heli'): string {
  const body =
    shape === 'heli'
      ? `<path d="M16 4L18 14L26 17V19L18 17.5L17.5 24L21 26.5V28L16 26.8L11 28V26.5L14.5 24L14 17.5L6 19V17L14 14Z" fill="${color}" stroke="#061018" stroke-width="0.9"/><circle cx="16" cy="14" r="9" fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3 3"/>`
      : shape === 'jet'
        ? `<path d="M16 2L18.5 11L28 19L28 21.5L18.5 17.5L18 25L22 28V29.5L16 27.8L10 29.5V28L14 25L13.5 17.5L4 21.5V19L13.5 11Z" fill="${color}" stroke="#061018" stroke-width="0.9"/>`
        : `<path d="M16 2.5C17.2 2.5 17.8 5.2 17.8 9.2L29 16.8V19.4L17.8 15.6V23.4L21.5 26.2V28.2L16 26.6L10.5 28.2V26.2L14.2 23.4V15.6L3 19.4V16.8L14.2 9.2C14.2 5.2 14.8 2.5 16 2.5Z" fill="${color}" stroke="#061018" stroke-width="0.9"/>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${body}</svg>`,
  )}`;
}

const ICONS = {
  civil: makePlaneSvg('#ffffff', 'airliner'),
  military: makePlaneSvg('#FFB800', 'jet'),
  heli: makePlaneSvg('#67e8f9', 'heli'),
  emergency: makePlaneSvg('#FF3B30', 'jet'),
};

function selectModelSpec(rec: AircraftRecord): ModelSpec {
  if (rec.category === 8) return { url: '/models/bell206.glb', radiusM: 8.24, bellyM: 1.66 };
  if (rec.military) return { url: '/models/jet.glb', radiusM: 29.83, bellyM: 2.5 };
  if (rec.category === 2) return { url: '/models/c172.glb', radiusM: 7.0, bellyM: 1.36 };
  if (rec.category === 3) return { url: '/models/citation2.glb', radiusM: 11.24, bellyM: 2.86 };
  if (rec.category === 4) return { url: '/models/atr72.glb', radiusM: 19.49, bellyM: 3.81 };
  if (rec.category === 5 || rec.category === 6) return { url: '/models/b789.glb', radiusM: 44.08, bellyM: 7.81 };
  return { url: '/models/airplane.glb', radiusM: 34.41, bellyM: 6.72 };
}

export class FlightsLayerController {
  private viewer: CesiumType.Viewer;
  private Cesium: typeof CesiumType;
  private billboardCollection: CesiumType.BillboardCollection;
  private modelCollection: CesiumType.PrimitiveCollection;
  private trailEntities: CesiumType.Entity[] = [];
  private routeOverlayEntities: CesiumType.Entity[] = [];
  private predictedPathEntities: CesiumType.Entity[] = [];
  private occluder: HorizonOccluder;
  private headingProjector: ScreenHeadingProjector;

  private civilRecords = new Map<string, AircraftRecord>();
  private milRecords = new Map<string, AircraftRecord>();
  private billboards = new Map<string, CesiumType.Billboard>();
  private groundFloorCache = new Map<string, { lat: number; lon: number; heightM: number }>();
  private trackBackfillRequested = new Set<string>();
  private enrichRequested = new Set<string>();
  private selectedPrediction: { entityId: string; prediction: FlightPrediction } | null = null;
  private selectionSeq = 0;
  private predictTimer: number | null = null;
  private lastRouteOverlaySig = '';
  private lastPredictedOverlaySig = '';
  private lastTrailRecordMs = -Infinity;
  private lastTrailRecordPos: { lon: number; lat: number } | null = null;
  private models = new Map<
    string,
    { model: CesiumType.Model; url: string; radiusM: number; bellyM: number; matrix: CesiumType.Matrix4; selected: boolean }
  >();
  private loadingModels = new Set<string>();

  private civilEnabled = false;
  private milEnabled = false;
  private cockpitActive = false;
  private models3dMode: Models3dMode = 'proximity';
  private selectedEntityId: string | null = null;
  private civilTimer: number | null = null;
  private milTimer: number | null = null;

  private drReconcileId: string | null = null;
  private drPrevRaw: CesiumType.Cartesian3;
  private drPrevDisplay: CesiumType.Cartesian3;
  private drCorrection: CesiumType.Cartesian3;
  private drCorrectionStartMs = 0;
  private drPrevSampleMs = 0;
  private drReconcileValid = false;

  private onStats: (kind: 'flights' | 'military', patch: { loading?: boolean; count?: number; status?: 'IDLE' | 'LOADING' | 'LIVE' | 'STALE' | 'ERROR'; sourceLabel?: string; error?: string | null }) => void;

  constructor(
    viewer: CesiumType.Viewer,
    Cesium: typeof CesiumType,
    onStats: FlightsLayerController['onStats'],
  ) {
    this.viewer = viewer;
    this.Cesium = Cesium;
    this.onStats = onStats;
    this.drPrevRaw = new Cesium.Cartesian3();
    this.drPrevDisplay = new Cesium.Cartesian3();
    this.drCorrection = new Cesium.Cartesian3();
    this.occluder = new HorizonOccluder(Cesium, viewer.camera.positionWC);
    this.headingProjector = new ScreenHeadingProjector(Cesium);
    this.billboardCollection = new Cesium.BillboardCollection({ scene: viewer.scene });
    this.modelCollection = new Cesium.PrimitiveCollection();
    viewer.scene.primitives.add(this.billboardCollection);
    viewer.scene.primitives.add(this.modelCollection);
  }

  setCockpitActive(active: boolean) {
    this.cockpitActive = active;
  }

  setEnabled(kind: 'flights' | 'military', enabled: boolean) {
    if (kind === 'flights') {
      if (this.civilEnabled === enabled) return;
      this.civilEnabled = enabled;
      if (enabled) {
        void ensureGeoidReady();
        void this.pollCivil();
        this.civilTimer = window.setInterval(() => void this.pollCivil(), 12_000);
      } else {
        if (this.civilTimer !== null) clearInterval(this.civilTimer);
        this.civilTimer = null;
        this.clearRecords('flights');
        this.onStats('flights', { loading: false, count: 0, status: 'IDLE', error: null });
      }
    } else {
      if (this.milEnabled === enabled) return;
      this.milEnabled = enabled;
      if (enabled) {
        void ensureGeoidReady();
        void this.pollMilitary();
        this.milTimer = window.setInterval(() => void this.pollMilitary(), 15_000);
      } else {
        if (this.milTimer !== null) clearInterval(this.milTimer);
        this.milTimer = null;
        this.clearRecords('military');
        this.onStats('military', { loading: false, count: 0, status: 'IDLE', error: null });
      }
    }
  }

  setModels3dMode(mode: Models3dMode) {
    this.models3dMode = mode;
    if (mode === 'off') {
      this.releaseAllModels();
    }
  }

  setSelectedEntityId(entityId: string | null) {
    const changed = this.selectedEntityId !== entityId;
    if (changed) {
      this.drReconcileValid = false;
      this.drReconcileId = entityId;
      this.selectionSeq += 1;
      if (this.predictTimer !== null) {
        clearTimeout(this.predictTimer);
        this.predictTimer = null;
      }
      this.selectedPrediction = null;
      this.lastTrailRecordMs = -Infinity;
      this.lastTrailRecordPos = null;
      this.clearTrail();
      this.clearRouteVisuals();
      this.clearPredictedVisuals();
    }
    this.selectedEntityId = entityId;
    if (!entityId || (!entityId.startsWith('flight:') && !entityId.startsWith('mil:'))) {
      this.clearTrail();
      this.clearRouteVisuals();
      this.clearPredictedVisuals();
      return;
    }

    if (changed) {
      const rec = this.findRecord(entityId);
      const seq = this.selectionSeq;
      if (rec) {
        this.seedInstantPrediction(rec, entityId);
        void this.backfillSelectedTrack(entityId, rec, seq);
        void this.enrichSelectedAircraft(entityId, rec, seq);
        this.scheduleAiPrediction(entityId, seq, 350, false);
      }
    }
  }

  private findRecord(entityId: string | null): AircraftRecord | null {
    if (!entityId) return null;
    if (entityId.startsWith('flight:')) return this.civilRecords.get(entityId.slice(7)) ?? null;
    if (entityId.startsWith('mil:')) return this.milRecords.get(entityId.slice(4)) ?? null;
    return null;
  }

  private isRoutePlausible(rec: AircraftRecord): boolean {
    if (!rec.route) return false;
    return routePlausible({
      latDeg: rec.lat,
      lonDeg: rec.lon,
      altitudeM: rec.hasGeoAlt ? rec.geoAltM : rec.baroAltM,
      verticalRateMps: rec.verticalRateMps,
      origin: rec.route.origin,
      destination: rec.route.destination,
    });
  }

  private removeEntities(list: CesiumType.Entity[]) {
    if (!list.length) return;
    if (!this.viewer.isDestroyed()) {
      for (const e of list) {
        this.viewer.entities.remove(e);
      }
    }
    list.length = 0;
  }

  private clearTrail() {
    this.removeEntities(this.trailEntities);
  }

  private clearRouteVisuals() {
    this.removeEntities(this.routeOverlayEntities);
    this.lastRouteOverlaySig = '';
  }

  private clearPredictedVisuals() {
    this.removeEntities(this.predictedPathEntities);
    this.lastPredictedOverlaySig = '';
  }

  private async backfillSelectedTrack(entityId: string, rec: AircraftRecord, seq: number) {
    if (rec.military || rec.backfilledTrack) return;
    if (!/^[0-9a-f]{6}$/i.test(rec.icao24)) return;
    if (this.trackBackfillRequested.has(rec.icao24)) return;
    this.trackBackfillRequested.add(rec.icao24);

    try {
      const resp = await fetch(`/api/flights/track?icao24=${encodeURIComponent(rec.icao24)}`);
      if (!resp.ok) return;
      const json = (await resp.json()) as { path?: unknown[] };
      if (this.viewer.isDestroyed() || seq !== this.selectionSeq || this.selectedEntityId !== entityId) {
        return;
      }
      if (!Array.isArray(json?.path) || !json.path.length) return;
      await ensureGeoidReady();
      const current = this.findRecord(entityId);
      if (!current || seq !== this.selectionSeq) return;

      const oldestLive = current.trail.length ? current.trail[0].epochMs : Number.POSITIVE_INFINITY;
      const backfill = parseOpenSkyTrackWaypoints(json.path, oldestLive, geoidHeightOrZero);
      if (backfill.length) {
        current.trail = mergeBackfillTrailPoints(backfill, current.trail, TRAIL_MAX_POINTS);
        current.backfilledTrack = true;
      }
    } catch {
      // Silent fallback to locally accumulated trail
    }
  }

  private async enrichSelectedAircraft(entityId: string, rec: AircraftRecord, seq: number) {
    const cs = rec.callsign.trim().toUpperCase();
    const hex = rec.icao24.toLowerCase();
    const jobs: Promise<void>[] = [];

    if (/^[0-9a-f]{6}$/i.test(hex) && !this.enrichRequested.has(`t:${hex}`)) {
      this.enrichRequested.add(`t:${hex}`);
      jobs.push(
        fetch(`/api/adsbdb/type/${encodeURIComponent(hex)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { found?: boolean; typeCode?: string | null; typeName?: string | null; registration?: string | null } | null) => {
            if (!data?.found || seq !== this.selectionSeq) return;
            const current = this.findRecord(entityId);
            if (!current) return;
            current.typeCode = data.typeCode || current.typeCode;
            current.typeName = data.typeName || current.typeName;
            current.registration = data.registration || current.registration;
          })
          .catch(() => {}),
      );
    }

    if (/^[A-Z]{3}\d/.test(cs) && !this.enrichRequested.has(`r:${cs}`)) {
      this.enrichRequested.add(`r:${cs}`);
      jobs.push(
        fetch(`/api/adsbdb/route/${encodeURIComponent(cs)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data: { found?: boolean; airline?: string | null; origin?: AirportEndpoint; destination?: AirportEndpoint } | null) => {
            if (!data?.found || seq !== this.selectionSeq) return;
            const current = this.findRecord(entityId);
            if (!current) return;
            current.airline = data.airline || current.airline;
            if (data.origin && data.destination) {
              current.route = { origin: data.origin, destination: data.destination };
            }
          })
          .catch(() => {}),
      );
    }

    if (jobs.length) {
      await Promise.all(jobs);
      if (seq === this.selectionSeq && this.selectedEntityId === entityId) {
        const refreshed = this.findRecord(entityId);
        if (refreshed?.route && this.isRoutePlausible(refreshed)) {
          this.scheduleAiPrediction(entityId, seq, 100, false);
        }
      }
    }
  }

  private buildPredictPayload(rec: AircraftRecord, force: boolean) {
    const pos = this.getDisplayKinematics(rec, Date.now());
    const route = rec.route && this.isRoutePlausible(rec) ? rec.route : null;
    return {
      icao24: rec.icao24,
      callsign: rec.callsign,
      military: rec.military,
      typeCode: rec.typeCode ?? null,
      typeName: rec.typeName ?? null,
      airline: rec.airline ?? null,
      lat: pos.lat,
      lon: pos.lon,
      altM: pos.altM,
      speedMps: pos.speedMps,
      courseDeg: pos.courseDeg,
      verticalRateMps: rec.verticalRateMps,
      onGround: rec.onGround,
      recentFixes: rec.history.map((f) => ({
        lat: f.lat,
        lon: f.lon,
        altM: f.altM,
        epochMs: f.epochMs,
        speedMps: f.speedMps,
        courseDeg: f.courseDeg,
      })),
      route,
      force,
    };
  }

  private seedInstantPrediction(rec: AircraftRecord, entityId: string) {
    const payload = this.buildPredictPayload(rec, false);
    const baseline = computeKinematicPrediction(payload);
    this.selectedPrediction = {
      entityId,
      prediction: {
        provider: 'kinematic',
        model: 'great-circle-kinematic-v1',
        phase: baseline.phase,
        confidence: baseline.confidence,
        etaMin: baseline.etaMin,
        summary: baseline.summary,
        waypoints: baseline.waypoints,
        generatedAtMs: Date.now(),
        loading: true,
      },
    };
  }

  private scheduleAiPrediction(entityId: string, seq: number, delayMs: number, force: boolean) {
    if (this.predictTimer !== null) {
      clearTimeout(this.predictTimer);
    }
    this.predictTimer = window.setTimeout(() => {
      this.predictTimer = null;
      void this.runAiPrediction(entityId, seq, force);
    }, delayMs);
  }

  private async runAiPrediction(entityId: string, seq: number, force: boolean): Promise<FlightPrediction | null> {
    const rec = this.findRecord(entityId);
    if (!rec || seq !== this.selectionSeq || this.selectedEntityId !== entityId) return null;

    if (this.selectedPrediction?.entityId === entityId) {
      this.selectedPrediction = {
        entityId,
        prediction: { ...this.selectedPrediction.prediction, loading: true },
      };
    }

    try {
      const resp = await fetch('/api/flights/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildPredictPayload(rec, force)),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as FlightPrediction;
      if (this.viewer.isDestroyed() || seq !== this.selectionSeq || this.selectedEntityId !== entityId) {
        return null;
      }
      const next: FlightPrediction = { ...json, loading: false };
      this.selectedPrediction = { entityId, prediction: next };
      this.lastPredictedOverlaySig = '';
      return next;
    } catch {
      if (this.selectedPrediction?.entityId === entityId) {
        this.selectedPrediction = {
          entityId,
          prediction: { ...this.selectedPrediction.prediction, loading: false },
        };
      }
      return this.selectedPrediction?.prediction ?? null;
    }
  }

  async triggerAiPrediction(force = true): Promise<FlightPrediction | null> {
    if (!this.selectedEntityId) return null;
    const entityId = this.selectedEntityId;
    const seq = this.selectionSeq;
    return this.runAiPrediction(entityId, seq, force);
  }

  getFullRoutePositions(nowMs = Date.now()): CesiumType.Cartesian3[] | null {
    const rec = this.findRecord(this.selectedEntityId);
    if (!rec) return null;

    const disp = this.getDisplayKinematics(rec, nowMs);
    const pts: CesiumType.Cartesian3[] = [];
    for (const p of rec.trail) {
      if (p.epochMs <= disp.renderTimeMs) {
        pts.push(this.Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.altM));
      }
    }
    pts.push(this.Cesium.Cartesian3.fromDegrees(disp.lon, disp.lat, disp.altM));

    if (this.selectedPrediction?.entityId === rec.entityId) {
      for (const wp of this.selectedPrediction.prediction.waypoints) {
        pts.push(this.Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.altM));
      }
    }

    if (rec.route && this.isRoutePlausible(rec)) {
      const o = rec.route.origin;
      const d = rec.route.destination;
      if (o?.lat !== null && o?.lat !== undefined && o?.lon !== null && o?.lon !== undefined) {
        pts.push(this.Cesium.Cartesian3.fromDegrees(o.lon, o.lat, 50));
      }
      if (d?.lat !== null && d?.lat !== undefined && d?.lon !== null && d?.lon !== undefined) {
        pts.push(this.Cesium.Cartesian3.fromDegrees(d.lon, d.lat, 50));
      }
    }

    return pts.length >= 2 ? pts : null;
  }

  private clearRecords(kind: 'flights' | 'military') {
    const prefix = kind === 'flights' ? 'flight:' : 'mil:';
    const map = kind === 'flights' ? this.civilRecords : this.milRecords;
    for (const key of map.keys()) {
      const entityId = `${prefix}${key}`;
      const bb = this.billboards.get(entityId);
      if (bb) {
        this.billboardCollection.remove(bb);
        this.billboards.delete(entityId);
      }
      this.groundFloorCache.delete(entityId);
      this.releaseModel(entityId);
    }
    map.clear();
  }

  private releaseModel(entityId: string) {
    const entry = this.models.get(entityId);
    if (entry) {
      this.modelCollection.remove(entry.model);
      this.models.delete(entityId);
    }
  }

  private releaseAllModels() {
    this.modelCollection.removeAll();
    this.models.clear();
  }

  private upsertRecord(
    map: Map<string, AircraftRecord>,
    params: {
      key: string;
      entityId: string;
      icao24: string;
      callsign: string;
      originCountry: string;
      lon: number;
      lat: number;
      baroAltM: number;
      geoAltM: number;
      hasGeoAlt: boolean;
      onGround: boolean;
      speedMps: number;
      courseDeg: number;
      verticalRateMps: number;
      squawk: string | null;
      emergency: boolean;
      military: boolean;
      category: number;
      fixEpochMs: number;
      nowMs: number;
    },
  ) {
    const prev = map.get(params.key);
    const history = prev ? [...prev.history] : [];
    const prevNewest = history[history.length - 1];
    const renderAltM = params.hasGeoAlt
      ? Math.max(0, params.geoAltM)
      : (params.onGround ? 3 : Math.max(0, params.baroAltM)) + geoidHeightOrZero(params.lat, params.lon);

    // Only append a fix when the feed's position epoch actually advanced AND coordinates changed,
    // so cached/repeated snapshots never reset interpolation or cause backward jumps.
    const timeAdvanced = !prevNewest || params.fixEpochMs >= prevNewest.epochMs + 1000;
    const coordsChanged =
      !prevNewest ||
      Math.abs(prevNewest.lat - params.lat) > 1e-6 ||
      Math.abs(prevNewest.lon - params.lon) > 1e-6;
    const altitudeChanged = !prevNewest || Math.abs(prevNewest.altM - renderAltM) > 15;

    let newestFixMs = prev?.newestFixMs ?? params.fixEpochMs;
    if (!prevNewest || (timeAdvanced && (coordsChanged || altitudeChanged))) {
      history.push({
        epochMs: params.fixEpochMs,
        lat: params.lat,
        lon: params.lon,
        altM: renderAltM,
        speedMps: params.speedMps,
        courseDeg: params.courseDeg,
        verticalRateMps: params.verticalRateMps,
      });
      if (history.length > POSITION_HISTORY_LIMIT) {
        history.shift();
      }
      newestFixMs = params.fixEpochMs;
    }

    const trail = prev ? [...prev.trail] : [];
    const prevTrail = trail[trail.length - 1];
    if (
      !prevTrail ||
      (params.fixEpochMs >= prevTrail.epochMs + 1000 &&
        (Math.abs(prevTrail.lat - params.lat) > 0.0002 ||
          Math.abs(prevTrail.lon - params.lon) > 0.0002))
    ) {
      trail.push({
        lon: params.lon,
        lat: params.lat,
        altM: renderAltM,
        epochMs: params.fixEpochMs,
      });
      if (trail.length > TRAIL_MAX_POINTS) trail.shift();
    }

    map.set(params.key, {
      entityId: params.entityId,
      icao24: params.icao24,
      callsign: params.callsign,
      originCountry: params.originCountry,
      lon: params.lon,
      lat: params.lat,
      baroAltM: params.baroAltM,
      geoAltM: params.geoAltM,
      hasGeoAlt: params.hasGeoAlt,
      onGround: params.onGround,
      speedMps: params.speedMps,
      courseDeg: params.courseDeg,
      verticalRateMps: params.verticalRateMps,
      squawk: params.squawk,
      emergency: params.emergency,
      military: params.military,
      category: params.category,
      updatedAtMs: params.nowMs,
      newestFixMs,
      history,
      trail,
      backfilledTrack: prev?.backfilledTrack,
      airline: prev?.airline,
      typeCode: prev?.typeCode,
      typeName: prev?.typeName,
      registration: prev?.registration,
      route: prev?.route,
    });
  }

  private async pollCivil() {
    if (!this.civilEnabled) return;
    this.onStats('flights', { loading: true, status: this.civilRecords.size ? 'LIVE' : 'LOADING' });
    try {
      const carto = this.viewer.camera.positionCartographic;
      const lat = carto ? this.Cesium.Math.toDegrees(carto.latitude) : 30.27;
      const lon = carto ? this.Cesium.Math.toDegrees(carto.longitude) : -97.74;
      const resp = await fetch(`/api/flights?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const sourceHeader = resp.headers.get('x-feed-source') || 'OpenSky';
      const cacheHeader = resp.headers.get('x-cache');
      const data = (await resp.json()) as { time?: unknown; states?: unknown[][] };
      const states = Array.isArray(data?.states) ? data.states : [];
      const nowMs = Date.now();
      const snapshotTimeSec = Number(data?.time);
      const fallbackSnapshotMs =
        Number.isFinite(snapshotTimeSec) && snapshotTimeSec > 1_000_000_000
          ? Math.round(snapshotTimeSec * 1000)
          : nowMs;
      const nextSeen = new Set<string>();

      for (const s of states) {
        if (!Array.isArray(s) || s.length < 11) continue;
        const icao24 = String(s[0] || '').trim().toLowerCase();
        const lonVal = Number(s[5]);
        const latVal = Number(s[6]);
        if (!icao24 || !Number.isFinite(lonVal) || !Number.isFinite(latVal)) continue;
        if (nextSeen.size >= MAX_DISPLAY_FLIGHTS && icao24 !== this.selectedEntityId?.replace('flight:', '')) {
          if (greatCircleKm(lat, lon, latVal, lonVal) > 3500) continue;
        }
        nextSeen.add(icao24);
        const prev = this.civilRecords.get(icao24);
        const onGround = Boolean(s[8]);
        const hasGeoAlt = s[13] !== null && s[13] !== undefined && Number.isFinite(Number(s[13]));
        const baroAltM = s[7] !== null && s[7] !== undefined && Number.isFinite(Number(s[7]))
          ? Number(s[7])
          : prev?.baroAltM ?? (onGround ? 0 : 9500);
        const geoAltM = hasGeoAlt ? Number(s[13]) : baroAltM;
        const squawk = s[14] ? String(s[14]) : null;
        const rawPosSec = s[3] !== null && s[3] !== undefined ? Number(s[3]) : NaN;
        const rawContactSec = s[4] !== null && s[4] !== undefined ? Number(s[4]) : NaN;
        const fixEpochMs =
          Number.isFinite(rawPosSec) && rawPosSec > 1_000_000_000
            ? Math.round(rawPosSec * 1000)
            : Number.isFinite(rawContactSec) && rawContactSec > 1_000_000_000
              ? Math.round(rawContactSec * 1000)
              : fallbackSnapshotMs;

        this.upsertRecord(this.civilRecords, {
          key: icao24,
          entityId: `flight:${icao24}`,
          icao24,
          callsign: String(s[1] || prev?.callsign || icao24).trim() || icao24.toUpperCase(),
          originCountry: String(s[2] || prev?.originCountry || 'Live ADS-B'),
          lon: lonVal,
          lat: latVal,
          baroAltM,
          geoAltM,
          hasGeoAlt,
          onGround,
          speedMps: s[9] !== null && s[9] !== undefined && Number.isFinite(Number(s[9])) ? Number(s[9]) : prev?.speedMps ?? 0,
          courseDeg: s[10] !== null && s[10] !== undefined && Number.isFinite(Number(s[10])) ? Number(s[10]) : prev?.courseDeg ?? 0,
          verticalRateMps: s[11] !== null && s[11] !== undefined && Number.isFinite(Number(s[11])) ? Number(s[11]) : prev?.verticalRateMps ?? 0,
          squawk,
          emergency: squawk === '7500' || squawk === '7600' || squawk === '7700',
          military: false,
          category: Number(s[17]) || prev?.category || 0,
          fixEpochMs,
          nowMs,
        });
      }

      for (const [key, rec] of this.civilRecords.entries()) {
        if (!nextSeen.has(key) && nowMs - rec.updatedAtMs > 60_000) {
          this.civilRecords.delete(key);
          const bb = this.billboards.get(rec.entityId);
          if (bb) {
            this.billboardCollection.remove(bb);
            this.billboards.delete(rec.entityId);
          }
          this.groundFloorCache.delete(rec.entityId);
          this.releaseModel(rec.entityId);
        }
      }

      this.onStats('flights', {
        loading: false,
        count: this.civilRecords.size,
        status: cacheHeader === 'STALE' ? 'STALE' : 'LIVE',
        sourceLabel: sourceHeader,
        error: null,
      });
    } catch (err) {
      this.onStats('flights', {
        loading: false,
        status: this.civilRecords.size ? 'STALE' : 'ERROR',
        error: err instanceof Error ? err.message : 'Feed unavailable',
      });
    }
  }

  private async pollMilitary() {
    if (!this.milEnabled) return;
    this.onStats('military', { loading: true, status: this.milRecords.size ? 'LIVE' : 'LOADING' });
    try {
      const resp = await fetch('/api/military');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const cacheHeader = resp.headers.get('x-cache');
      const data = (await resp.json()) as { now?: unknown; ac?: Array<Record<string, unknown>> };
      const ac = Array.isArray(data?.ac) ? data.ac : [];
      const nowMs = Date.now();
      const snapshotNowSec = Number(data?.now);
      const baseEpochSec =
        Number.isFinite(snapshotNowSec) && snapshotNowSec > 1_000_000_000
          ? snapshotNowSec
          : nowMs / 1000;
      const nextSeen = new Set<string>();

      for (const row of ac) {
        const hex = String(row?.hex || '').trim().toLowerCase();
        const latVal = Number(row?.lat);
        const lonVal = Number(row?.lon);
        if (!hex || !Number.isFinite(latVal) || !Number.isFinite(lonVal)) continue;
        nextSeen.add(hex);
        const prev = this.milRecords.get(hex);
        const onGround = row?.alt_baro === 'ground';
        const hasGeoAlt = row?.alt_geom !== null && row?.alt_geom !== undefined && Number.isFinite(Number(row?.alt_geom));
        const altM = onGround
          ? 0
          : hasGeoAlt
            ? Number(row.alt_geom) * 0.3048
            : row?.alt_baro !== null && row?.alt_baro !== undefined && Number.isFinite(Number(row?.alt_baro))
              ? Number(row.alt_baro) * 0.3048
              : prev?.baroAltM ?? 8500;
        const speedMps = row?.gs !== null && row?.gs !== undefined && Number.isFinite(Number(row?.gs)) ? Number(row.gs) * 0.514444 : prev?.speedMps ?? 0;
        const courseDeg = row?.track !== null && row?.track !== undefined && Number.isFinite(Number(row?.track)) ? Number(row.track) : prev?.courseDeg ?? 0;
        const squawk = row?.squawk ? String(row.squawk) : null;
        const seenPos = Number(row?.seen_pos ?? row?.seen);
        const fixEpochMs =
          Number.isFinite(seenPos) && seenPos >= 0
            ? Math.round((baseEpochSec - seenPos) * 1000)
            : Math.round(baseEpochSec * 1000);

        this.upsertRecord(this.milRecords, {
          key: hex,
          entityId: `mil:${hex}`,
          icao24: hex,
          callsign: String(row?.flight || row?.r || hex).trim() || hex.toUpperCase(),
          originCountry: String(row?.t || 'MILITARY'),
          lon: lonVal,
          lat: latVal,
          baroAltM: altM,
          geoAltM: altM,
          hasGeoAlt,
          onGround,
          speedMps,
          courseDeg,
          verticalRateMps: Number.isFinite(Number(row?.baro_rate)) ? Number(row.baro_rate) * 0.00508 : 0,
          squawk,
          emergency: squawk === '7500' || squawk === '7600' || squawk === '7700',
          military: true,
          category: 6,
          fixEpochMs,
          nowMs,
        });
      }

      for (const [key, rec] of this.milRecords.entries()) {
        if (!nextSeen.has(key) && nowMs - rec.updatedAtMs > 60_000) {
          this.milRecords.delete(key);
          const bb = this.billboards.get(rec.entityId);
          if (bb) {
            this.billboardCollection.remove(bb);
            this.billboards.delete(rec.entityId);
          }
          this.groundFloorCache.delete(rec.entityId);
          this.releaseModel(rec.entityId);
        }
      }

      this.onStats('military', {
        loading: false,
        count: this.milRecords.size,
        status: cacheHeader === 'STALE' ? 'STALE' : 'LIVE',
        sourceLabel: 'adsb.lol Military',
        error: null,
      });
    } catch (err) {
      this.onStats('military', {
        loading: false,
        status: this.milRecords.size ? 'STALE' : 'ERROR',
        error: err instanceof Error ? err.message : 'Military feed unavailable',
      });
    }
  }

  private extrapolateFix(fix: PositionFix, dtSec: number, onGround: boolean) {
    const speed = Math.min(COAST_MAX_SPEED_MPS, Math.max(0, fix.speedMps));
    if (speed < 1.5 || dtSec === 0) {
      return {
        lat: fix.lat,
        lon: fix.lon,
        altM: fix.altM,
        speedMps: speed,
        courseDeg: fix.courseDeg,
      };
    }
    const distM = speed * dtSec;
    const rad = (fix.courseDeg * Math.PI) / 180;
    const dNorth = (distM * Math.cos(rad)) / 111_320;
    const cosLat = Math.max(0.1, Math.cos((fix.lat * Math.PI) / 180));
    const dEast = (distM * Math.sin(rad)) / (111_320 * cosLat);
    let lon = fix.lon + dEast;
    if (lon > 180) lon -= 360;
    else if (lon < -180) lon += 360;
    const altM = onGround ? fix.altM : Math.max(0, fix.altM + fix.verticalRateMps * dtSec);
    return {
      lat: Math.max(-89.9, Math.min(89.9, fix.lat + dNorth)),
      lon,
      altM,
      speedMps: speed,
      courseDeg: fix.courseDeg,
    };
  }

  /**
   * Render-behind interpolation (30s civil / 15s military): brackets two known
   * fixes whenever possible so polling never extrapolates ahead and snaps back.
   */
  private getDisplayKinematics(rec: AircraftRecord, nowMs: number) {
    const delayMs = rec.military ? MIL_RENDER_DELAY_MS : CIVIL_RENDER_DELAY_MS;
    const renderTimeMs = nowMs - delayMs;
    const history = rec.history;

    if (!history.length) {
      return {
        lat: rec.lat,
        lon: rec.lon,
        altM: rec.onGround ? geoidHeightOrZero(rec.lat, rec.lon) + 3 : Math.max(0, rec.geoAltM),
        speedMps: rec.speedMps,
        courseDeg: rec.courseDeg,
        renderTimeMs,
        stale: false,
      };
    }

    for (let i = history.length - 1; i >= 1; i--) {
      const a = history[i - 1];
      const b = history[i];
      if (a.epochMs <= renderTimeMs && renderTimeMs <= b.epochMs) {
        const spanMs = b.epochMs - a.epochMs;
        const t = spanMs > 0 ? (renderTimeMs - a.epochMs) / spanMs : 1;
        let dLon = b.lon - a.lon;
        if (dLon > 180) dLon -= 360;
        else if (dLon < -180) dLon += 360;
        let lon = a.lon + dLon * t;
        if (lon > 180) lon -= 360;
        else if (lon < -180) lon += 360;
        const lat = a.lat + (b.lat - a.lat) * t;
        const altM = a.altM + (b.altM - a.altM) * t;

        const dNorthM = (b.lat - a.lat) * 111_320;
        const dEastM = dLon * 111_320 * Math.max(0.1, Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)));
        const chordM = Math.hypot(dNorthM, dEastM);
        const segSpeed = spanMs > 0 ? chordM / (spanMs / 1000) : b.speedMps;
        const courseDeg =
          segSpeed > 15 && chordM > 25
            ? ((((Math.atan2(dEastM, dNorthM) * 180) / Math.PI) % 360) + 360) % 360
            : lerpAngleDeg(a.courseDeg, b.courseDeg, t);

        return {
          lat,
          lon,
          altM,
          speedMps: Number.isFinite(segSpeed) ? segSpeed : b.speedMps,
          courseDeg,
          renderTimeMs,
          stale: false,
        };
      }
    }

    const oldest = history[0];
    if (renderTimeMs < oldest.epochMs) {
      const lookbackSec = Math.max(-60, (renderTimeMs - oldest.epochMs) / 1000);
      const ex = this.extrapolateFix(oldest, lookbackSec, rec.onGround);
      return { ...ex, renderTimeMs, stale: false };
    }

    const newest = history[history.length - 1];
    const elapsedSec = Math.max(0, (renderTimeMs - newest.epochMs) / 1000);
    const coastCapSec = rec.onGround ? 0 : 90;
    const clampedSec = Math.min(coastCapSec, elapsedSec);
    const ex = this.extrapolateFix(newest, clampedSec, rec.onGround);
    return {
      ...ex,
      renderTimeMs,
      stale: elapsedSec > coastCapSec,
    };
  }

  private reconcileTrackedCartesian(
    rec: AircraftRecord,
    rawCartesian: CesiumType.Cartesian3,
    speedMps: number,
    nowMs: number,
    out?: CesiumType.Cartesian3,
  ): CesiumType.Cartesian3 {
    const dest = out || new this.Cesium.Cartesian3();
    const sameTrack = this.drReconcileValid && this.drReconcileId === rec.entityId;
    if (sameTrack) {
      const dtSec = Math.max(0.001, (nowMs - this.drPrevSampleMs) / 1000);
      const plausibleM = speedMps * dtSec * 4 + 25;
      if (this.Cesium.Cartesian3.distance(rawCartesian, this.drPrevRaw) > plausibleM) {
        this.Cesium.Cartesian3.subtract(this.drPrevDisplay, rawCartesian, this.drCorrection);
        this.drCorrectionStartMs = nowMs;
      }
    } else {
      this.Cesium.Cartesian3.clone(this.Cesium.Cartesian3.ZERO, this.drCorrection);
      this.drCorrectionStartMs = nowMs - DR_CORRECTION_MS;
    }

    const elapsed = nowMs - this.drCorrectionStartMs;
    const factor = elapsed >= DR_CORRECTION_MS ? 0 : Math.max(0, 1 - elapsed / DR_CORRECTION_MS);
    this.Cesium.Cartesian3.multiplyByScalar(this.drCorrection, factor, dest);
    this.Cesium.Cartesian3.add(rawCartesian, dest, dest);

    this.Cesium.Cartesian3.clone(rawCartesian, this.drPrevRaw);
    this.Cesium.Cartesian3.clone(dest, this.drPrevDisplay);
    this.drPrevSampleMs = nowMs;
    this.drReconcileId = rec.entityId;
    this.drReconcileValid = true;
    return dest;
  }

  getTrackedLivePosition(
    nowMs = Date.now(),
    result?: CesiumType.Cartesian3,
  ): CesiumType.Cartesian3 | undefined {
    const rec = this.findRecord(this.selectedEntityId);
    if (!rec) return undefined;
    const pos = this.getDisplayKinematics(rec, nowMs);
    const rawCart = this.Cesium.Cartesian3.fromDegrees(
      pos.lon,
      pos.lat,
      pos.altM,
      this.Cesium.Ellipsoid.WGS84,
    );
    return this.reconcileTrackedCartesian(rec, rawCart, pos.speedMps, nowMs, result);
  }

  private getGroundModelCartesian(
    rec: AircraftRecord,
    pos: { lat: number; lon: number; altM: number },
    bellyM: number,
  ): CesiumType.Cartesian3 {
    if (!rec.onGround) {
      return this.Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altM);
    }
    const cached = this.groundFloorCache.get(rec.entityId);
    if (
      cached &&
      Math.abs(cached.lat - pos.lat) < 0.0004 &&
      Math.abs(cached.lon - pos.lon) < 0.0004
    ) {
      return this.Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, cached.heightM + bellyM);
    }

    const scene = this.viewer.scene as CesiumType.Scene & {
      sampleHeightSupported?: boolean;
      sampleHeight?: (carto: CesiumType.Cartographic, objectsToExclude?: unknown[]) => number | undefined;
    };
    if (scene.sampleHeightSupported && typeof scene.sampleHeight === 'function') {
      try {
        const sampled = scene.sampleHeight(
          this.Cesium.Cartographic.fromDegrees(pos.lon, pos.lat),
          [...this.billboards.values()],
        );
        if (typeof sampled === 'number' && Number.isFinite(sampled)) {
          this.groundFloorCache.set(rec.entityId, {
            lat: pos.lat,
            lon: pos.lon,
            heightM: sampled,
          });
          return this.Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, sampled + bellyM);
        }
      } catch {
        // non-fatal fallback to geoid surface
      }
    }
    return this.Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altM + bellyM);
  }

  tick(nowMs: number): {
    detectionTargets: DetectionTarget[];
    nearbyContacts: NearbyContact[];
    selectedInfo: SelectedEntityInfo | null;
    trackedCartesian: CesiumType.Cartesian3 | null;
    trackedHeadingDeg: number;
    trackedSpeedMps: number;
    trackedStale: boolean;
  } {
    const camPos = this.viewer.camera.positionWC;
    this.occluder.updateCamera(camPos);
    const camCarto = this.viewer.camera.positionCartographic;
    const camAltM = camCarto?.height ?? 10_000_000;
    const camLat = camCarto ? this.Cesium.Math.toDegrees(camCarto.latitude) : 30.27;
    const camLon = camCarto ? this.Cesium.Math.toDegrees(camCarto.longitude) : -97.74;

    const allRecords: AircraftRecord[] = [
      ...(this.milEnabled ? [...this.milRecords.values()] : []),
      ...(this.civilEnabled ? [...this.civilRecords.values()] : []),
    ];

    const modelEligible = new Set<string>();
    if (this.models3dMode !== 'off' && camAltM < MODEL_ALT_CEIL_M) {
      const cap = this.models3dMode === 'all' ? ALL_MODEL_CAP : PROXIMITY_MODEL_CAP;
      const nearbyForModels: Array<{ entityId: string; dist: number }> = [];
      for (const rec of allRecords) {
        if (rec.entityId === this.selectedEntityId) {
          if (camAltM < TRACKED_MODEL_ENTER_ALT_M) {
            modelEligible.add(rec.entityId);
          }
          continue;
        }
        const dKm = greatCircleKm(camLat, camLon, rec.lat, rec.lon);
        if (dKm < 120) {
          nearbyForModels.push({ entityId: rec.entityId, dist: dKm });
        }
      }
      nearbyForModels.sort((a, b) => a.dist - b.dist);
      for (const item of nearbyForModels.slice(0, cap)) {
        modelEligible.add(item.entityId);
      }
    } else if (this.models3dMode !== 'off' && this.selectedEntityId && camAltM < TRACKED_MODEL_ENTER_ALT_M) {
      modelEligible.add(this.selectedEntityId);
    }

    const detectionTargets: DetectionTarget[] = [];
    const nearbyContacts: NearbyContact[] = [];
    let selectedInfo: SelectedEntityInfo | null = null;
    let trackedCartesian: CesiumType.Cartesian3 | null = null;
    let trackedHeadingDeg = 0;
    let trackedSpeedMps = 0;
    let trackedStale = false;

    for (const rec of allRecords) {
      const pos = this.getDisplayKinematics(rec, nowMs);
      const rawCartesian = this.Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, pos.altM);
      const isSelected = rec.entityId === this.selectedEntityId;
      const cartesian = isSelected
        ? this.reconcileTrackedCartesian(rec, rawCartesian, pos.speedMps, nowMs)
        : rawCartesian;
      const smoothedCarto = isSelected ? this.Cesium.Cartographic.fromCartesian(cartesian) : null;
      const dispLat = smoothedCarto ? this.Cesium.Math.toDegrees(smoothedCarto.latitude) : pos.lat;
      const dispLon = smoothedCarto ? this.Cesium.Math.toDegrees(smoothedCarto.longitude) : pos.lon;
      const dispAltM = smoothedCarto ? Math.max(0, smoothedCarto.height) : pos.altM;

      const distKm = greatCircleKm(camLat, camLon, dispLat, dispLon);

      if (distKm <= 250) {
        nearbyContacts.push({
          entityId: rec.entityId,
          id: rec.icao24.toUpperCase(),
          callsign: rec.callsign,
          kind: rec.military ? 'military' : 'flight',
          altM: dispAltM,
          speedKts: Math.round(pos.speedMps * 1.94384),
          headingDeg: Math.round(pos.courseDeg),
          distKm,
        });
      }

      if (isSelected) {
        trackedCartesian = cartesian;
        trackedHeadingDeg = pos.courseDeg;
        trackedSpeedMps = pos.speedMps;
        trackedStale = pos.stale;
        const speedKts = Math.round(pos.speedMps * 1.94384);
        const fl = Math.round((dispAltM * 3.28084) / 100);
        const routeOk = rec.route ? this.isRoutePlausible(rec) : false;
        const currentPrediction =
          this.selectedPrediction?.entityId === rec.entityId
            ? this.selectedPrediction.prediction
            : null;
        this.updateTrail(rec, { lon: dispLon, lat: dispLat, altM: dispAltM }, pos.renderTimeMs);
        this.updateRouteOverlay(rec, { lon: dispLon, lat: dispLat, altM: dispAltM }, routeOk, pos.renderTimeMs);
        this.updatePredictedOverlay(rec, { lon: dispLon, lat: dispLat, altM: dispAltM }, currentPrediction);

        const dest = routeOk && rec.route ? rec.route.destination : null;
        const destBearingDeg =
          dest && dest.lat !== null && dest.lon !== null
            ? bearingBetweenDeg(dispLat, dispLon, dest.lat, dest.lon)
            : null;
        const relBearingDeg =
          destBearingDeg !== null ? relativeBearingDeg(destBearingDeg, pos.courseDeg) : null;
        const flightRoute: FlightRouteInfo = {
          airline: rec.airline ?? null,
          registration: rec.registration ?? null,
          typeCode: rec.typeCode ?? null,
          typeName: rec.typeName ?? null,
          origin: routeOk && rec.route ? rec.route.origin : null,
          destination: routeOk && rec.route ? rec.route.destination : null,
          plausible: routeOk,
          destBearingDeg,
          relBearingDeg,
          trailPoints: rec.trail.length,
          backfilled: Boolean(rec.backfilledTrack),
        };
        selectedInfo = {
          entityId: rec.entityId,
          kind: rec.military ? 'military' : 'flight',
          title: rec.callsign,
          subtitle: `${rec.military ? 'MILITARY' : 'CIVIL'} · ICAO ${rec.icao24.toUpperCase()}${rec.registration ? ` · ${rec.registration}` : ''}`,
          lat: dispLat,
          lon: dispLon,
          altM: dispAltM,
          canCockpit: true,
          flightRoute,
          flightPrediction: currentPrediction,
          telemetry: [
            { label: 'ORIGIN / TYPE', value: rec.typeName || rec.typeCode || rec.originCountry },
            ...(rec.airline ? [{ label: 'AIRLINE', value: rec.airline }] : []),
            ...(routeOk && rec.route
              ? [{ label: 'ROUTE', value: `${rec.route.origin.code || '?'} → ${rec.route.destination.code || '?'}` }]
              : []),
            { label: 'ALTITUDE', value: rec.onGround ? 'ON GROUND' : `FL${String(fl).padStart(3, '0')} (${Math.round(dispAltM).toLocaleString()} m)` },
            { label: 'SPEED', value: `${speedKts} kts (${Math.round(pos.speedMps * 3.6)} km/h)` },
            { label: 'HEADING', value: `${Math.round(pos.courseDeg)}°` },
            { label: 'V/S', value: `${Math.round(rec.verticalRateMps * 196.85)} fpm` },
            { label: 'SQUAWK', value: rec.squawk || '--' },
          ],
        };
      }

      // Cull against horizon with a >= 200m lifted point so grounded negative-geoid traffic stays visible
      const visible = this.occluder.isLatLonVisible(dispLat, dispLon, Math.max(200, dispAltM));

      // Update 2D screen-aligned billboard
      let bb = this.billboards.get(rec.entityId);
      const image = rec.emergency
        ? ICONS.emergency
        : rec.military
          ? ICONS.military
          : rec.category === 8
            ? ICONS.heli
            : ICONS.civil;
      const bbScale = isSelected ? 0.95 : rec.onGround ? 0.56 : 0.72;
      let revealed = false;

      if (!bb) {
        bb = this.billboardCollection.add({
          id: { entityId: rec.entityId, kind: rec.military ? 'military' : 'flights' },
          position: cartesian,
          show: visible,
          image,
          scale: bbScale,
          rotation: 0,
          alignedAxis: this.Cesium.Cartesian3.ZERO,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          color: isSelected ? this.Cesium.Color.CYAN : this.Cesium.Color.WHITE,
        });
        this.billboards.set(rec.entityId, bb);
        revealed = visible;
      } else {
        if (visible && !bb.show) revealed = true;
        if (visible) {
          bb.position = cartesian;
          bb.image = image;
          bb.scale = bbScale;
          bb.color = isSelected ? this.Cesium.Color.CYAN : this.Cesium.Color.WHITE;
        }
      }

      if (isSelected) {
        for (const te of this.trailEntities) {
          te.show = !this.cockpitActive;
        }
      }

      const wantModel = visible && !(isSelected && this.cockpitActive) && modelEligible.has(rec.entityId);
      const modelEntry = this.models.get(rec.entityId);

      if (!visible || (isSelected && this.cockpitActive)) {
        bb.show = false;
        if (modelEntry) modelEntry.model.show = false;
        continue;
      }

      // Compute true screen-space course rotation so aircraft align cleanly at all latitudes
      const nextRot = this.headingProjector.compute(
        this.viewer.camera,
        cartesian,
        pos.courseDeg,
        bb.rotation,
      );
      if (revealed || Math.abs(shortestAngleDelta(bb.rotation, nextRot)) > ROTATION_DEADBAND_RAD) {
        bb.rotation = nextRot;
      }

      // Manage 3D model when zoomed in
      const dMeters = this.Cesium.Cartesian3.distance(camPos, cartesian);
      if (wantModel) {
        if (modelEntry) {
          const modelPos = rec.onGround
            ? this.getGroundModelCartesian(rec, { lat: dispLat, lon: dispLon, altM: dispAltM }, modelEntry.bellyM)
            : cartesian;
          const hpr = new this.Cesium.HeadingPitchRoll(
            this.Cesium.Math.toRadians((pos.courseDeg || 0) + MODEL_HEADING_OFFSET_DEG),
            0,
            0,
          );
          this.Cesium.Transforms.headingPitchRollToFixedFrame(
            modelPos,
            hpr,
            this.Cesium.Ellipsoid.WGS84,
            undefined,
            modelEntry.matrix,
          );
          modelEntry.model.modelMatrix = modelEntry.matrix;
          const frustum = this.viewer.camera.frustum as { fovy?: number };
          modelEntry.model.scale = trackedModelScaleForPixelCap({
            baseScale: 1,
            nativeRadiusM: modelEntry.radiusM,
            rangeM: Math.max(50, dMeters),
            viewportHeightPx: this.viewer.scene.canvas.clientHeight || 720,
            fovyRad: frustum.fovy || 1.047,
            maximumPixelSize: isSelected ? 200 : 140,
          });
          if (modelEntry.selected !== isSelected) {
            modelEntry.selected = isSelected;
            modelEntry.model.color = isSelected
              ? this.Cesium.Color.CYAN
              : rec.military
                ? this.Cesium.Color.fromCssColorString('#FFB800')
                : this.Cesium.Color.WHITE;
          }
          if (modelEntry.model.ready) {
            modelEntry.model.show = true;
            bb.show = false;
          } else {
            modelEntry.model.show = false;
            bb.show = true;
          }
        } else {
          bb.show = true;
          this.ensureModelLoaded(rec, cartesian, isSelected);
        }
      } else {
        bb.show = true;
        if (modelEntry) {
          this.releaseModel(rec.entityId);
        }
      }

      // Add to detection mesh if in reasonable range
      if (dMeters < 5_000_000) {
        const fl = Math.round((dispAltM * 3.28084) / 100);
        detectionTargets.push({
          entityId: rec.entityId,
          label: rec.callsign,
          sublabel: rec.onGround ? 'GND' : `FL${String(fl).padStart(3, '0')} · ${Math.round(pos.speedMps * 1.94384)}KT`,
          category: rec.military ? 'military' : 'flight',
          lat: dispLat,
          lon: dispLon,
          altM: dispAltM,
          color: rec.emergency ? '#FF3B30' : rec.military ? '#FFB800' : '#00d4ff',
          priority: isSelected ? 10 : rec.military ? 5 : 2,
        });
      }
    }

    // Prune stale models
    for (const entityId of this.models.keys()) {
      if (!modelEligible.has(entityId)) {
        this.releaseModel(entityId);
      }
    }

    nearbyContacts.sort((a, b) => a.distKm - b.distKm);

    return {
      detectionTargets,
      nearbyContacts: nearbyContacts.slice(0, 30),
      selectedInfo,
      trackedCartesian,
      trackedHeadingDeg,
      trackedSpeedMps,
      trackedStale,
    };
  }

  private ensureModelLoaded(
    rec: AircraftRecord,
    pos: CesiumType.Cartesian3,
    isSelected: boolean,
  ) {
    if (this.loadingModels.has(rec.entityId)) return;
    const spec = selectModelSpec(rec);
    this.loadingModels.add(rec.entityId);
    const matrix = this.Cesium.Transforms.headingPitchRollToFixedFrame(
      pos,
      new this.Cesium.HeadingPitchRoll(
        this.Cesium.Math.toRadians((rec.courseDeg || 0) + MODEL_HEADING_OFFSET_DEG),
        0,
        0,
      ),
    );
    this.Cesium.Model.fromGltfAsync({
      url: spec.url,
      modelMatrix: matrix,
      scale: 1,
      minimumPixelSize: isSelected ? 40 : 24,
      color: isSelected
        ? this.Cesium.Color.CYAN
        : rec.military
          ? this.Cesium.Color.fromCssColorString('#FFB800')
          : this.Cesium.Color.WHITE,
      colorBlendMode: this.Cesium.ColorBlendMode.MIX,
      colorBlendAmount: 0.92,
      id: { entityId: rec.entityId, kind: rec.military ? 'military' : 'flights' },
    })
      .then((model) => {
        this.loadingModels.delete(rec.entityId);
        if (
          this.viewer.isDestroyed() ||
          (!this.civilEnabled && !rec.military) ||
          (!this.milEnabled && rec.military) ||
          this.models3dMode === 'off'
        ) {
          return;
        }
        model.show = false;
        this.modelCollection.add(model);
        this.models.set(rec.entityId, {
          model,
          url: spec.url,
          radiusM: spec.radiusM,
          bellyM: spec.bellyM,
          matrix,
          selected: isSelected,
        });
      })
      .catch(() => {
        this.loadingModels.delete(rec.entityId);
      });
  }

  /**
   * Dark-yellow / amber follow-line appearance for aircraft previous paths
   * (past flown waypoints + origin-to-track inbound leg), contrasting against
   * ocean, desert, and urban 3D tiles while dimming gracefully behind terrain.
   */
  private makeDarkYellowFollowStyle() {
    const darkYellow = this.Cesium.Color.fromCssColorString('#D97706');
    const goldYellow = this.Cesium.Color.fromCssColorString('#EAB308');
    const deepGap = this.Cesium.Color.fromCssColorString('#713F12');
    return {
      markerColor: goldYellow,
      material: new this.Cesium.PolylineDashMaterialProperty({
        color: goldYellow.withAlpha(0.95),
        gapColor: deepGap.withAlpha(0.45),
        dashLength: 16,
        dashPattern: 0xffe0,
      }),
      depthFailMaterial: darkYellow.withAlpha(0.42),
    };
  }

  private recordDrawnTrailPoint(
    rec: AircraftRecord,
    currentPos: { lon: number; lat: number; altM: number },
    renderTimeMs: number,
  ) {
    if (rec.onGround && rec.speedMps < 2) return;
    const movedM = this.lastTrailRecordPos
      ? greatCircleKm(this.lastTrailRecordPos.lat, this.lastTrailRecordPos.lon, currentPos.lat, currentPos.lon) * 1000
      : Number.POSITIVE_INFINITY;
    const elapsedMs = renderTimeMs - this.lastTrailRecordMs;
    if (movedM < 5) return;
    if (elapsedMs < 1_000 && movedM < 150) return;

    // Insert chronologically ahead of any buffered future fixes so behind <= renderTimeMs grows smoothly
    let idx = rec.trail.length;
    while (idx > 0 && rec.trail[idx - 1].epochMs > renderTimeMs) idx -= 1;
    const prev = rec.trail[idx - 1];
    if (prev && Math.abs(renderTimeMs - prev.epochMs) < 500) return;

    this.lastTrailRecordMs = renderTimeMs;
    this.lastTrailRecordPos = { lon: currentPos.lon, lat: currentPos.lat };

    rec.trail.splice(idx, 0, {
      lon: currentPos.lon,
      lat: currentPos.lat,
      altM: currentPos.altM,
      epochMs: renderTimeMs,
    });
    if (rec.trail.length > TRAIL_MAX_POINTS) {
      rec.trail.shift();
    }
  }

  private updateTrail(
    rec: AircraftRecord,
    currentPos: { lon: number; lat: number; altM: number },
    renderTimeMs: number,
  ) {
    this.recordDrawnTrailPoint(rec, currentPos, renderTimeMs);

    // Only draw trail waypoints at or behind the delayed display instant so newer
    // buffered fixes never extend ahead of the aircraft icon.
    const behind = rec.trail.filter((p) => p.epochMs <= renderTimeMs);
    const segments = splitTrailIntoSegments(behind);
    const headPt: TrailFixPoint = {
      lon: currentPos.lon,
      lat: currentPos.lat,
      altM: currentPos.altM,
      epochMs: renderTimeMs,
    };

    const lastSeg = segments[segments.length - 1];
    const lastPt = lastSeg?.[lastSeg.length - 1];
    if (
      lastPt &&
      renderTimeMs - lastPt.epochMs <= 48 * 60_000 &&
      greatCircleKm(lastPt.lat, lastPt.lon, currentPos.lat, currentPos.lon) <= 150
    ) {
      lastSeg.push(headPt);
    }

    const validSegs = segments.filter((seg) => seg.length >= 2);
    if (!validSegs.length) {
      this.clearTrail();
      return;
    }

    const style = this.makeDarkYellowFollowStyle();

    while (this.trailEntities.length > validSegs.length) {
      const stale = this.trailEntities.pop();
      if (stale) this.viewer.entities.remove(stale);
    }

    for (let i = 0; i < validSegs.length; i++) {
      const seg = validSegs[i];
      const coords: number[] = [];
      for (const p of seg) {
        coords.push(p.lon, p.lat, p.altM);
      }
      const positions = this.Cesium.Cartesian3.fromDegreesArrayHeights(coords);
      const existing = this.trailEntities[i];
      if (!existing) {
        this.trailEntities.push(
          this.viewer.entities.add({
            show: !this.cockpitActive,
            polyline: {
              positions,
              width: 3,
              material: style.material,
              depthFailMaterial: style.depthFailMaterial,
              arcType: this.Cesium.ArcType.GEODESIC,
            },
          }),
        );
      } else if (existing.polyline) {
        existing.show = !this.cockpitActive;
        existing.polyline.positions = new this.Cesium.ConstantProperty(positions);
      }
    }
  }

  private updateRouteOverlay(
    rec: AircraftRecord,
    currentPos: { lon: number; lat: number; altM: number },
    routeOk: boolean,
    renderTimeMs: number,
  ) {
    const behind = rec.trail.filter((p) => p.epochMs <= renderTimeMs);
    const origin = routeOk && rec.route ? rec.route.origin : null;
    const destination = routeOk && rec.route ? rec.route.destination : null;
    const hasO = Boolean(origin && origin.lat !== null && origin.lon !== null);
    const hasD = Boolean(destination && destination.lat !== null && destination.lon !== null);
    const trailStart = behind.length >= 2 ? behind[0] : null;

    if (!hasO && !hasD && !trailStart) {
      this.clearRouteVisuals();
      return;
    }

    const sig = `${rec.entityId}:${origin?.code || ''}->${destination?.code || ''}:${trailStart ? `${trailStart.lat.toFixed(2)},${trailStart.lon.toFixed(2)}` : 'none'}:${currentPos.lat.toFixed(2)},${currentPos.lon.toFixed(2)}`;
    if (sig === this.lastRouteOverlaySig && this.routeOverlayEntities.length) {
      return;
    }
    this.clearRouteVisuals();
    this.lastRouteOverlaySig = sig;

    const yellowStyle = this.makeDarkYellowFollowStyle();
    const emerald = this.Cesium.Color.fromCssColorString('#34d399');

    const addEndpointMarker = (
      lat: number,
      lon: number,
      altM: number,
      text: string,
      color: CesiumType.Color,
    ) => {
      this.routeOverlayEntities.push(
        this.viewer.entities.add({
          position: this.Cesium.Cartesian3.fromDegrees(lon, lat, altM),
          point: {
            pixelSize: 7,
            color,
            outlineColor: this.Cesium.Color.BLACK,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text,
            font: '600 10px ui-monospace, monospace',
            fillColor: color,
            outlineColor: this.Cesium.Color.BLACK,
            outlineWidth: 2,
            style: this.Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new this.Cesium.Cartesian2(0, -14),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    };

    // Inbound leg ("from where it came to current location"): Origin -> earliest track point (or currentPos)
    if (hasO && origin && origin.lat !== null && origin.lon !== null) {
      const targetAnchor = trailStart ?? currentPos;
      const inboundCoords = [
        origin.lon,
        origin.lat,
        50,
        targetAnchor.lon,
        targetAnchor.lat,
        Math.max(50, targetAnchor.altM),
      ];
      this.routeOverlayEntities.push(
        this.viewer.entities.add({
          polyline: {
            positions: this.Cesium.Cartesian3.fromDegreesArrayHeights(inboundCoords),
            width: 2.8,
            material: yellowStyle.material,
            depthFailMaterial: yellowStyle.depthFailMaterial,
            arcType: this.Cesium.ArcType.GEODESIC,
          },
        }),
      );
      if (origin.code) {
        addEndpointMarker(origin.lat, origin.lon, 80, `${origin.code} (ORIG)`, yellowStyle.markerColor);
      }
    } else if (trailStart) {
      // Anchor where the recorded/backfilled dark-yellow path started
      addEndpointMarker(
        trailStart.lat,
        trailStart.lon,
        Math.max(40, trailStart.altM),
        rec.backfilledTrack ? 'TRACK START' : 'PATH START',
        yellowStyle.markerColor,
      );
    }

    // Remaining scheduled leg: currentPos -> destination airport
    if (hasD && destination && destination.lat !== null && destination.lon !== null) {
      this.routeOverlayEntities.push(
        this.viewer.entities.add({
          polyline: {
            positions: this.Cesium.Cartesian3.fromDegreesArrayHeights([
              currentPos.lon,
              currentPos.lat,
              Math.max(50, currentPos.altM),
              destination.lon,
              destination.lat,
              50,
            ]),
            width: 2,
            material: new this.Cesium.PolylineDashMaterialProperty({
              color: emerald.withAlpha(0.6),
              dashLength: 14,
            }),
            depthFailMaterial: emerald.withAlpha(0.24),
            arcType: this.Cesium.ArcType.GEODESIC,
          },
        }),
      );
      if (destination.code) {
        addEndpointMarker(destination.lat, destination.lon, 80, `${destination.code} (DEST)`, emerald);
      }
    }
  }

  private updatePredictedOverlay(
    rec: AircraftRecord,
    currentPos: { lon: number; lat: number; altM: number },
    prediction: FlightPrediction | null,
  ) {
    if (!prediction || !prediction.waypoints.length) {
      this.clearPredictedVisuals();
      return;
    }

    const sig = `${rec.entityId}:${prediction.generatedAtMs}:${currentPos.lat.toFixed(3)},${currentPos.lon.toFixed(3)}`;
    if (sig === this.lastPredictedOverlaySig && this.predictedPathEntities.length) {
      return;
    }
    this.clearPredictedVisuals();
    this.lastPredictedOverlaySig = sig;

    const violet = this.Cesium.Color.fromCssColorString('#c084fc');
    const coords: number[] = [currentPos.lon, currentPos.lat, Math.max(20, currentPos.altM)];
    for (const wp of prediction.waypoints) {
      coords.push(wp.lon, wp.lat, Math.max(20, wp.altM));
    }

    this.predictedPathEntities.push(
      this.viewer.entities.add({
        polyline: {
          positions: this.Cesium.Cartesian3.fromDegreesArrayHeights(coords),
          width: 3,
          material: new this.Cesium.PolylineDashMaterialProperty({
            color: violet.withAlpha(0.92),
            dashLength: 16,
          }),
          depthFailMaterial: violet.withAlpha(0.35),
          arcType: this.Cesium.ArcType.GEODESIC,
        },
      }),
    );

    for (let i = 0; i < prediction.waypoints.length; i++) {
      const wp = prediction.waypoints[i];
      const isLast = i === prediction.waypoints.length - 1;
      this.predictedPathEntities.push(
        this.viewer.entities.add({
          position: this.Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, Math.max(20, wp.altM)),
          point: {
            pixelSize: isLast ? 7 : 5,
            color: violet,
            outlineColor: this.Cesium.Color.BLACK,
            outlineWidth: 1.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label:
            !this.cockpitActive || isLast
              ? {
                  text: isLast ? `AI · ${wp.label}` : `+${wp.etaMin}m`,
                  font: '600 10px ui-monospace, monospace',
                  fillColor: violet,
                  outlineColor: this.Cesium.Color.BLACK,
                  outlineWidth: 2,
                  style: this.Cesium.LabelStyle.FILL_AND_OUTLINE,
                  pixelOffset: new this.Cesium.Cartesian2(0, -13),
                  disableDepthTestDistance: Number.POSITIVE_INFINITY,
                }
              : undefined,
        }),
      );
    }
  }

  destroy() {
    if (this.civilTimer !== null) clearInterval(this.civilTimer);
    if (this.milTimer !== null) clearInterval(this.milTimer);
    if (this.predictTimer !== null) clearTimeout(this.predictTimer);
    this.clearTrail();
    this.clearRouteVisuals();
    this.clearPredictedVisuals();
    if (!this.viewer.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.billboardCollection);
      this.viewer.scene.primitives.remove(this.modelCollection);
    }
  }
}
