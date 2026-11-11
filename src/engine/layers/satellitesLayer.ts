import type * as CesiumType from 'cesium';
import * as satellite from 'satellite.js';
import type {
  DetectionTarget,
  SatelliteClassKey,
  SelectedEntityInfo,
} from '@/types/gev';

interface SatRecord {
  entityId: string;
  noradId: string;
  name: string;
  satClass: SatelliteClassKey;
  satrec: satellite.SatRec;
  tle1: string;
  tle2: string;
  inclinationDeg: number;
  periodMin: number;
}

const GROUP_MAP: Array<{ group: string; satClass: SatelliteClassKey }> = [
  { group: 'stations', satClass: 'stations' },
  { group: 'visual', satClass: 'probes' },
  { group: 'resource', satClass: 'imaging' },
  { group: 'weather', satClass: 'imaging' },
  { group: 'planet', satClass: 'imaging' },
  { group: 'sar', satClass: 'imaging' },
  { group: 'gps-ops', satClass: 'telecom' },
  { group: 'galileo', satClass: 'telecom' },
  { group: 'geo', satClass: 'telecom' },
  { group: 'science', satClass: 'probes' },
  { group: 'starlink', satClass: 'starlink' },
];

const CLASS_COLORS: Record<SatelliteClassKey, string> = {
  stations: '#00f6ff',
  imaging: '#a78bfa',
  telecom: '#38bdf8',
  starlink: '#94a3b8',
  probes: '#f472b6',
};

function makeSatSvg(color: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect x="2" y="9" width="6" height="6" fill="${color}" stroke="#081018" stroke-width="0.8"/><rect x="16" y="9" width="6" height="6" fill="${color}" stroke="#081018" stroke-width="0.8"/><rect x="9.5" y="7" width="5" height="10" rx="1" fill="#ffffff" stroke="${color}" stroke-width="1"/><line x1="8" y1="12" x2="16" y2="12" stroke="#081018" stroke-width="1"/></svg>`,
  )}`;
}

const SAT_ICONS: Record<SatelliteClassKey, string> = {
  stations: makeSatSvg(CLASS_COLORS.stations),
  imaging: makeSatSvg(CLASS_COLORS.imaging),
  telecom: makeSatSvg(CLASS_COLORS.telecom),
  starlink: makeSatSvg(CLASS_COLORS.starlink),
  probes: makeSatSvg(CLASS_COLORS.probes),
};

export class SatellitesLayerController {
  private viewer: CesiumType.Viewer;
  private Cesium: typeof CesiumType;
  private billboards: CesiumType.BillboardCollection;
  private records = new Map<string, SatRecord>();
  private billboardMap = new Map<string, CesiumType.Billboard>();
  private orbitEntity: CesiumType.Entity | null = null;
  private orbitForId: string | null = null;

  private enabled = false;
  private classes: Record<SatelliteClassKey, boolean> = {
    stations: true,
    imaging: true,
    telecom: true,
    starlink: false,
    probes: true,
  };
  private loadedGroups = new Set<string>();
  private selectedEntityId: string | null = null;
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
    onStats: SatellitesLayerController['onStats'],
  ) {
    this.viewer = viewer;
    this.Cesium = Cesium;
    this.onStats = onStats;
    this.billboards = new Cesium.BillboardCollection({ scene: viewer.scene });
    viewer.scene.primitives.add(this.billboards);
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      void this.loadEnabledGroups();
    } else {
      this.billboards.removeAll();
      this.billboardMap.clear();
      this.clearOrbit();
      this.onStats({ loading: false, count: 0, status: 'IDLE', error: null });
    }
  }

  setClasses(classes: Record<SatelliteClassKey, boolean>) {
    this.classes = { ...classes };
    if (this.enabled) {
      void this.loadEnabledGroups();
    }
  }

  setSelectedEntityId(entityId: string | null) {
    this.selectedEntityId = entityId;
    if (!entityId || !entityId.startsWith('sat:')) {
      this.clearOrbit();
    }
  }

  getTrackedLivePosition(
    nowMs = Date.now(),
    result?: CesiumType.Cartesian3,
  ): CesiumType.Cartesian3 | undefined {
    if (!this.selectedEntityId?.startsWith('sat:')) return undefined;
    const rec = this.records.get(this.selectedEntityId);
    if (!rec) return undefined;
    const now = new Date(nowMs);
    const prop = satellite.propagate(rec.satrec, now);
    if (!prop || !prop.position || typeof prop.position === 'boolean') return undefined;
    const geodetic = satellite.eciToGeodetic(prop.position, satellite.gstime(now));
    const lat = satellite.degreesLat(geodetic.latitude);
    const lon = satellite.degreesLong(geodetic.longitude);
    const altM = geodetic.height * 1000;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altM)) {
      return undefined;
    }
    return this.Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      altM,
      this.Cesium.Ellipsoid.WGS84,
      result,
    );
  }

  private clearOrbit() {
    if (this.orbitEntity) {
      this.viewer.entities.remove(this.orbitEntity);
      this.orbitEntity = null;
    }
    this.orbitForId = null;
  }

  private async loadEnabledGroups() {
    const needed = GROUP_MAP.filter(
      (entry) => this.classes[entry.satClass] && !this.loadedGroups.has(entry.group),
    );
    if (needed.length === 0) {
      this.syncStats();
      return;
    }

    this.onStats({ loading: true, status: this.records.size ? 'LIVE' : 'LOADING' });
    let anyStale = false;
    let errors = 0;

    await Promise.all(
      needed.map(async ({ group, satClass }) => {
        try {
          const resp = await fetch(`/api/celestrak/${group}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          if (resp.headers.get('x-tle-cache') === 'STALE-ERROR') anyStale = true;
          const text = await resp.text();
          this.parseTle(text, satClass, group === 'starlink' ? 350 : 250);
          this.loadedGroups.add(group);
        } catch {
          errors++;
        }
      }),
    );

    if (!this.enabled) return;
    this.syncStats(anyStale ? 'STALE' : errors === needed.length && this.records.size === 0 ? 'ERROR' : 'LIVE');
  }

  private parseTle(tleText: string, satClass: SatelliteClassKey, cap: number) {
    const lines = tleText
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean);
    let added = 0;
    for (let i = 0; i + 2 < lines.length && added < cap; ) {
      const nameLine = lines[i];
      const l1 = lines[i + 1];
      const l2 = lines[i + 2];
      if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) {
        i += 1;
        continue;
      }
      i += 3;
      const noradId = l1.slice(2, 7).trim();
      const entityId = `sat:${noradId}`;
      if (this.records.has(entityId)) continue;
      try {
        const satrec = satellite.twoline2satrec(l1, l2);
        const revPerDay = Number(l2.slice(52, 63)) || 15;
        const periodMin = 1440 / Math.max(0.1, revPerDay);
        const inclinationDeg = Number(l2.slice(8, 16)) || 0;
        this.records.set(entityId, {
          entityId,
          noradId,
          name: nameLine.trim() || `NORAD ${noradId}`,
          satClass,
          satrec,
          tle1: l1,
          tle2: l2,
          inclinationDeg,
          periodMin,
        });
        added++;
      } catch {
        // skip invalid TLE
      }
    }
  }

  private syncStats(forceStatus?: 'LIVE' | 'STALE' | 'ERROR') {
    let visibleCount = 0;
    for (const rec of this.records.values()) {
      if (this.classes[rec.satClass]) visibleCount++;
    }
    this.onStats({
      loading: false,
      count: visibleCount,
      status: forceStatus || (visibleCount > 0 ? 'LIVE' : 'IDLE'),
      sourceLabel: 'CelesTrak · SGP4',
      error: forceStatus === 'ERROR' ? 'CelesTrak unavailable' : null,
    });
  }

  tick(nowMs: number): {
    detectionTargets: DetectionTarget[];
    selectedInfo: SelectedEntityInfo | null;
    trackedCartesian: CesiumType.Cartesian3 | null;
  } {
    if (!this.enabled) {
      return { detectionTargets: [], selectedInfo: null, trackedCartesian: null };
    }

    const now = new Date(nowMs);
    const gmst = satellite.gstime(now);
    const detectionTargets: DetectionTarget[] = [];
    let selectedInfo: SelectedEntityInfo | null = null;
    let trackedCartesian: CesiumType.Cartesian3 | null = null;

    for (const rec of this.records.values()) {
      const showClass = this.classes[rec.satClass];
      let bb = this.billboardMap.get(rec.entityId);

      if (!showClass) {
        if (bb) bb.show = false;
        continue;
      }

      const prop = satellite.propagate(rec.satrec, now);
      if (!prop || !prop.position || typeof prop.position === 'boolean') {
        if (bb) bb.show = false;
        continue;
      }

      const geodetic = satellite.eciToGeodetic(prop.position, gmst);
      const lat = satellite.degreesLat(geodetic.latitude);
      const lon = satellite.degreesLong(geodetic.longitude);
      const altM = geodetic.height * 1000;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altM)) continue;

      const cartesian = this.Cesium.Cartesian3.fromDegrees(lon, lat, altM);
      const isSelected = rec.entityId === this.selectedEntityId;

      if (!bb) {
        bb = this.billboards.add({
          id: { entityId: rec.entityId, kind: 'satellites' },
          position: cartesian,
          image: SAT_ICONS[rec.satClass],
          scale: rec.satClass === 'stations' ? 0.95 : 0.7,
          color: isSelected ? this.Cesium.Color.CYAN : this.Cesium.Color.WHITE,
        });
        this.billboardMap.set(rec.entityId, bb);
      } else {
        bb.show = true;
        bb.position = cartesian;
        bb.scale = isSelected ? 1.15 : rec.satClass === 'stations' ? 0.95 : 0.7;
        bb.color = isSelected ? this.Cesium.Color.CYAN : this.Cesium.Color.WHITE;
      }

      let speedKms = 0;
      if (prop.velocity && typeof prop.velocity !== 'boolean') {
        speedKms = Math.hypot(prop.velocity.x, prop.velocity.y, prop.velocity.z);
      }

      if (isSelected) {
        trackedCartesian = cartesian;
        this.ensureOrbitRing(rec, now);
        selectedInfo = {
          entityId: rec.entityId,
          kind: 'satellite',
          title: rec.name,
          subtitle: `NORAD ${rec.noradId} · ${rec.satClass.toUpperCase()}`,
          lat,
          lon,
          altM,
          telemetry: [
            { label: 'ALTITUDE', value: `${(altM / 1000).toFixed(1)} km` },
            { label: 'ORBITAL VELOCITY', value: `${speedKms.toFixed(2)} km/s` },
            { label: 'INCLINATION', value: `${rec.inclinationDeg.toFixed(2)}°` },
            { label: 'PERIOD', value: `${rec.periodMin.toFixed(1)} min` },
            { label: 'SUB-SAT LAT/LON', value: `${lat.toFixed(3)}°, ${lon.toFixed(3)}°` },
          ],
        };
      }

      detectionTargets.push({
        entityId: rec.entityId,
        label: rec.name,
        sublabel: `${Math.round(altM / 1000)}KM · ${rec.noradId}`,
        category: 'satellite',
        lat,
        lon,
        altM,
        color: CLASS_COLORS[rec.satClass],
        priority: isSelected ? 10 : rec.satClass === 'stations' ? 7 : 3,
      });
    }

    return { detectionTargets, selectedInfo, trackedCartesian };
  }

  private ensureOrbitRing(rec: SatRecord, now: Date) {
    if (this.orbitForId === rec.entityId && this.orbitEntity) return;
    this.clearOrbit();
    this.orbitForId = rec.entityId;

    const steps = 96;
    const periodMs = rec.periodMin * 60_000;
    const coords: number[] = [];
    const gmstNow = satellite.gstime(now);

    for (let i = 0; i <= steps; i++) {
      const t = new Date(now.getTime() + (i / steps) * periodMs);
      const prop = satellite.propagate(rec.satrec, t);
      if (!prop || !prop.position || typeof prop.position === 'boolean') continue;
      // Rotate into current Earth-fixed frame so the orbital ring locks cleanly onto Earth
      const geo = satellite.eciToGeodetic(prop.position, gmstNow);
      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);
      const altM = geo.height * 1000;
      if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(altM)) {
        coords.push(lon, lat, altM);
      }
    }

    if (coords.length < 6) return;
    this.orbitEntity = this.viewer.entities.add({
      polyline: {
        positions: this.Cesium.Cartesian3.fromDegreesArrayHeights(coords),
        width: 1.8,
        material: new this.Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.25,
          color: this.Cesium.Color.fromCssColorString(CLASS_COLORS[rec.satClass]).withAlpha(0.75),
        }),
      },
    });
  }

  destroy() {
    this.clearOrbit();
    if (!this.viewer.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.billboards);
    }
  }
}
