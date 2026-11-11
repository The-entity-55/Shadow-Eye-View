import type * as CesiumType from 'cesium';
import type { DetectionTarget, SelectedEntityInfo } from '@/types/gev';

interface EqRow {
  id: string;
  lon: number;
  lat: number;
  depthKm: number | null;
  mag: number;
  place: string | null;
  time: number | null;
}

export class EarthquakesLayerController {
  private viewer: CesiumType.Viewer;
  private Cesium: typeof CesiumType;
  private dataSource: CesiumType.CustomDataSource;
  private rows = new Map<string, EqRow>();
  private enabled = false;
  private selectedEntityId: string | null = null;
  private timer: number | null = null;
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
    onStats: EarthquakesLayerController['onStats'],
  ) {
    this.viewer = viewer;
    this.Cesium = Cesium;
    this.onStats = onStats;
    this.dataSource = new Cesium.CustomDataSource('earthquakes');
    void viewer.dataSources.add(this.dataSource);
  }

  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.dataSource.show = enabled;
    if (enabled) {
      void this.poll();
      this.timer = window.setInterval(() => void this.poll(), 90_000);
    } else {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      this.dataSource.entities.removeAll();
      this.rows.clear();
      this.onStats({ loading: false, count: 0, status: 'IDLE', error: null });
    }
  }

  setSelectedEntityId(entityId: string | null) {
    this.selectedEntityId = entityId;
  }

  private async poll() {
    if (!this.enabled) return;
    this.onStats({ loading: true, status: this.rows.size ? 'LIVE' : 'LOADING' });
    try {
      const resp = await fetch('/api/earthquakes');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = (await resp.json()) as { source?: string; stale?: boolean; rows?: EqRow[] };
      const list = Array.isArray(json.rows) ? json.rows : [];
      if (!this.enabled) return;

      this.dataSource.entities.removeAll();
      this.rows.clear();

      for (const row of list) {
        const entityId = `eq:${row.id}`;
        this.rows.set(entityId, row);
        const colorHex =
          row.mag >= 6
            ? '#ff2d55'
            : row.mag >= 5
              ? '#ff6b35'
              : row.mag >= 4
                ? '#ffb800'
                : '#ffd60a';
        const color = this.Cesium.Color.fromCssColorString(colorHex);
        const radiusM = Math.max(12_000, Math.pow(2.1, row.mag) * 2200);

        this.dataSource.entities.add({
          id: entityId,
          position: this.Cesium.Cartesian3.fromDegrees(row.lon, row.lat, 500),
          point: {
            pixelSize: Math.max(7, Math.min(20, row.mag * 3.1)),
            color,
            outlineColor: this.Cesium.Color.BLACK,
            outlineWidth: 1.5,
          },
          ellipse: {
            semiMajorAxis: radiusM,
            semiMinorAxis: radiusM,
            material: color.withAlpha(0.18),
            outline: true,
            outlineColor: color.withAlpha(0.72),
            outlineWidth: 1.2,
            height: 0,
          },
        });
      }

      this.onStats({
        loading: false,
        count: list.length,
        status: json.stale ? 'STALE' : 'LIVE',
        sourceLabel: json.source || 'USGS M2.5+',
        error: null,
      });
    } catch (err) {
      this.onStats({
        loading: false,
        status: this.rows.size ? 'STALE' : 'ERROR',
        error: err instanceof Error ? err.message : 'USGS feed unavailable',
      });
    }
  }

  getTickData(): {
    detectionTargets: DetectionTarget[];
    selectedInfo: SelectedEntityInfo | null;
  } {
    if (!this.enabled) return { detectionTargets: [], selectedInfo: null };
    const detectionTargets: DetectionTarget[] = [];
    let selectedInfo: SelectedEntityInfo | null = null;

    for (const [entityId, row] of this.rows.entries()) {
      const isSelected = entityId === this.selectedEntityId;
      detectionTargets.push({
        entityId,
        label: `M${row.mag.toFixed(1)}`,
        sublabel: row.place || `${row.lat.toFixed(2)}, ${row.lon.toFixed(2)}`,
        category: 'earthquake',
        lat: row.lat,
        lon: row.lon,
        altM: 500,
        color: row.mag >= 5 ? '#ff5533' : '#ffb800',
        priority: isSelected ? 10 : Math.round(row.mag),
      });

      if (isSelected) {
        selectedInfo = {
          entityId,
          kind: 'earthquake',
          title: `M${row.mag.toFixed(1)} EARTHQUAKE`,
          subtitle: row.place || 'Seismic Event',
          lat: row.lat,
          lon: row.lon,
          altM: 500,
          telemetry: [
            { label: 'MAGNITUDE', value: `M ${row.mag.toFixed(1)}` },
            { label: 'DEPTH', value: row.depthKm != null ? `${row.depthKm.toFixed(1)} km` : '--' },
            { label: 'TIME (UTC)', value: row.time ? new Date(row.time).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '--' },
            { label: 'COORDINATES', value: `${row.lat.toFixed(3)}°, ${row.lon.toFixed(3)}°` },
          ],
        };
      }
    }

    return { detectionTargets, selectedInfo };
  }

  destroy() {
    if (this.timer !== null) clearInterval(this.timer);
    if (!this.viewer.isDestroyed()) {
      void this.viewer.dataSources.remove(this.dataSource, true);
    }
  }
}
