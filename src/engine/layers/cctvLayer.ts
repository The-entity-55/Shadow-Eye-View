import type * as CesiumType from 'cesium';
import type {
  CctvCoverageMode,
  DetectionTarget,
  SelectedEntityInfo,
} from '@/types/gev';
import { greatCircleKm } from '../hudMath';

export interface CctvCameraRecord {
  id: string;
  name: string;
  city: string;
  cityId: string;
  provider: string;
  lat: number;
  lon: number;
  headingDeg: number;
  pitchDeg: number;
  fovDeg: number;
  rangeM: number;
  mountHeightM: number;
  groundElevationM: number;
  license?: string;
}

function makeCamSvg(): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#091522" stroke="#00d4ff" stroke-width="1.6"/><polygon points="9,8 16,12 9,16" fill="#00d4ff"/></svg>`,
  )}`;
}

const CAM_ICON = makeCamSvg();

export class CctvLayerController {
  private viewer: CesiumType.Viewer;
  private Cesium: typeof CesiumType;
  private billboards: CesiumType.BillboardCollection;
  private viewshedSource: CesiumType.CustomDataSource;
  private cameras = new Map<string, CctvCameraRecord>();
  private enabled = false;
  private coverageMode: CctvCoverageMode = 'on';
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
    onStats: CctvLayerController['onStats'],
  ) {
    this.viewer = viewer;
    this.Cesium = Cesium;
    this.onStats = onStats;
    this.billboards = new Cesium.BillboardCollection({ scene: viewer.scene });
    this.viewshedSource = new Cesium.CustomDataSource('cctv-viewsheds');
    viewer.scene.primitives.add(this.billboards);
    void viewer.dataSources.add(this.viewshedSource);
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.billboards.show = enabled;
    this.viewshedSource.show = enabled && this.coverageMode !== 'off';
    if (enabled && this.cameras.size === 0) {
      void this.loadCatalog();
    } else if (!enabled) {
      this.onStats({ loading: false, count: 0, status: 'IDLE', error: null });
    } else {
      this.onStats({ loading: false, count: this.cameras.size, status: 'LIVE', error: null });
    }
  }

  setCoverageMode(mode: CctvCoverageMode) {
    this.coverageMode = mode;
    this.viewshedSource.show = this.enabled && mode !== 'off';
    if (this.enabled) {
      this.rebuildViewsheds();
    }
  }

  setSelectedEntityId(entityId: string | null) {
    this.selectedEntityId = entityId;
  }

  private async loadCatalog() {
    this.onStats({ loading: true, status: 'LOADING' });
    try {
      const resp = await fetch('/api/cctv/sources');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as { sources?: CctvCameraRecord[] };
      const list = Array.isArray(json.sources) ? json.sources : [];
      if (!this.enabled) return;

      this.cameras.clear();
      this.billboards.removeAll();

      for (const cam of list) {
        const entityId = `cctv:${cam.id}`;
        this.cameras.set(entityId, cam);
        const altM = cam.groundElevationM + cam.mountHeightM;
        this.billboards.add({
          id: { entityId, kind: 'cctv' },
          position: this.Cesium.Cartesian3.fromDegrees(cam.lon, cam.lat, altM),
          image: CAM_ICON,
          scale: 0.72,
          scaleByDistance: new this.Cesium.NearFarScalar(1500, 1.0, 2_500_000, 0.35),
        });
      }

      this.rebuildViewsheds();
      this.onStats({
        loading: false,
        count: list.length,
        status: 'LIVE',
        sourceLabel: 'Austin · TfL · World',
        error: null,
      });
    } catch (err) {
      this.onStats({
        loading: false,
        status: 'ERROR',
        error: err instanceof Error ? err.message : 'CCTV catalog failed',
      });
    }
  }

  private rebuildViewsheds() {
    this.viewshedSource.entities.removeAll();
    if (this.coverageMode !== 'viewshed') return;

    // Render frustum cones for city cameras with known/estimated headings (capped for smooth FPS)
    let drawn = 0;
    for (const [entityId, cam] of this.cameras.entries()) {
      if (drawn >= 300) break;
      drawn++;
      const altM = cam.groundElevationM + 2;
      const halfFov = (cam.fovDeg / 2) * (Math.PI / 180);
      const headingRad = (cam.headingDeg * Math.PI) / 180;
      const cosLat = Math.max(0.2, Math.cos((cam.lat * Math.PI) / 180));
      const range = Math.min(250, Math.max(80, cam.rangeM));

      const coords: number[] = [cam.lon, cam.lat, altM];
      const arcSteps = 6;
      for (let i = 0; i <= arcSteps; i++) {
        const angle = headingRad - halfFov + (2 * halfFov * i) / arcSteps;
        const dLat = (range * Math.cos(angle)) / 111_320;
        const dLon = (range * Math.sin(angle)) / (111_320 * cosLat);
        coords.push(cam.lon + dLon, cam.lat + dLat, altM);
      }

      const isSelected = entityId === this.selectedEntityId;
      this.viewshedSource.entities.add({
        polygon: {
          hierarchy: this.Cesium.Cartesian3.fromDegreesArrayHeights(coords),
          perPositionHeight: true,
          material: this.Cesium.Color.fromCssColorString('#00d4ff').withAlpha(
            isSelected ? 0.34 : 0.14,
          ),
          outline: true,
          outlineColor: this.Cesium.Color.fromCssColorString('#00d4ff').withAlpha(
            isSelected ? 0.85 : 0.35,
          ),
        },
      });
    }
  }

  findNearestCamera(lat: number, lon: number): CctvCameraRecord | null {
    let best: CctvCameraRecord | null = null;
    let bestDist = Infinity;
    for (const cam of this.cameras.values()) {
      const d = greatCircleKm(lat, lon, cam.lat, cam.lon);
      if (d < bestDist) {
        bestDist = d;
        best = cam;
      }
    }
    return best;
  }

  getTickData(): {
    detectionTargets: DetectionTarget[];
    selectedInfo: SelectedEntityInfo | null;
  } {
    if (!this.enabled) return { detectionTargets: [], selectedInfo: null };

    const camCarto = this.viewer.camera.positionCartographic;
    const camAltM = camCarto?.height ?? 10_000_000;
    const camLat = camCarto ? this.Cesium.Math.toDegrees(camCarto.latitude) : 30.27;
    const camLon = camCarto ? this.Cesium.Math.toDegrees(camCarto.longitude) : -97.74;

    const detectionTargets: DetectionTarget[] = [];
    let selectedInfo: SelectedEntityInfo | null = null;

    for (const [entityId, cam] of this.cameras.entries()) {
      const isSelected = entityId === this.selectedEntityId;
      if (isSelected) {
        selectedInfo = {
          entityId,
          kind: 'cctv',
          title: cam.name,
          subtitle: `${cam.city.toUpperCase()} · LIVE CCTV`,
          lat: cam.lat,
          lon: cam.lon,
          altM: cam.groundElevationM + cam.mountHeightM,
          cctvId: cam.id,
          cctvProvider: cam.provider,
          cctvLicense: cam.license,
          telemetry: [
            { label: 'PROVIDER', value: cam.provider },
            { label: 'HEADING / FOV', value: `${Math.round(cam.headingDeg)}° · ${cam.fovDeg}°` },
            { label: 'COORDINATES', value: `${cam.lat.toFixed(4)}°, ${cam.lon.toFixed(4)}°` },
          ],
        };
      }

      if (camAltM < 350_000 && greatCircleKm(camLat, camLon, cam.lat, cam.lon) < 100) {
        detectionTargets.push({
          entityId,
          label: cam.name.slice(0, 22),
          sublabel: cam.city.toUpperCase(),
          category: 'cctv',
          lat: cam.lat,
          lon: cam.lon,
          altM: cam.groundElevationM + cam.mountHeightM,
          color: '#00d4ff',
          priority: isSelected ? 10 : 4,
        });
      }
    }

    return { detectionTargets, selectedInfo };
  }

  destroy() {
    if (!this.viewer.isDestroyed()) {
      this.viewer.scene.primitives.remove(this.billboards);
      void this.viewer.dataSources.remove(this.viewshedSource, true);
    }
  }
}
