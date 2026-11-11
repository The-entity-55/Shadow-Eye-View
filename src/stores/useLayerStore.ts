import { create } from 'zustand';
import type {
  CctvCoverageMode,
  LayerId,
  LayerState,
  SatelliteClassKey,
} from '@/types/gev';

const INITIAL_LAYERS: Record<LayerId, LayerState> = {
  flights: {
    id: 'flights',
    name: 'Live Flights',
    category: 'Movement',
    enabled: false,
    loading: false,
    status: 'IDLE',
    sourceLabel: 'OpenSky · adsb.lol',
    count: 0,
    error: null,
  },
  military: {
    id: 'military',
    name: 'Military Flights',
    category: 'Movement',
    enabled: false,
    loading: false,
    status: 'IDLE',
    sourceLabel: 'adsb.lol Military',
    count: 0,
    error: null,
  },
  vessels: {
    id: 'vessels',
    name: 'Live Vessels',
    category: 'Movement',
    enabled: false,
    loading: false,
    status: 'IDLE',
    sourceLabel: 'AISStream',
    count: 0,
    error: null,
  },
  traffic: {
    id: 'traffic',
    name: 'Live Traffic',
    category: 'Movement',
    enabled: false,
    loading: false,
    status: 'IDLE',
    sourceLabel: 'TomTom Flow',
    count: 0,
    error: null,
  },
  satellites: {
    id: 'satellites',
    name: 'Satellites',
    category: 'Space',
    enabled: false,
    loading: false,
    status: 'IDLE',
    sourceLabel: 'CelesTrak · SGP4',
    count: 0,
    error: null,
  },
  cctv: {
    id: 'cctv',
    name: 'CCTV Mesh',
    category: 'Cameras',
    enabled: false,
    loading: false,
    status: 'IDLE',
    sourceLabel: 'Austin · TfL · World',
    count: 0,
    error: null,
  },
  earthquakes: {
    id: 'earthquakes',
    name: 'Earthquakes (24h)',
    category: 'Events',
    enabled: false,
    loading: false,
    status: 'IDLE',
    sourceLabel: 'USGS M2.5+',
    count: 0,
    error: null,
  },
};

interface LayerStoreState {
  layers: Record<LayerId, LayerState>;
  trafficLines: boolean;
  cctvCoverageMode: CctvCoverageMode;
  satelliteClasses: Record<SatelliteClassKey, boolean>;
  toggleLayer: (id: LayerId) => void;
  setLayerEnabled: (id: LayerId, enabled: boolean) => void;
  setLayersEnabled: (updates: Partial<Record<LayerId, boolean>>) => void;
  updateLayerState: (id: LayerId, patch: Partial<LayerState>) => void;
  setTrafficLines: (enabled: boolean) => void;
  setCctvCoverageMode: (mode: CctvCoverageMode) => void;
  cycleCctvCoverageMode: () => void;
  toggleSatelliteClass: (key: SatelliteClassKey) => void;
}

export const useLayerStore = create<LayerStoreState>((set) => ({
  layers: INITIAL_LAYERS,
  trafficLines: false,
  cctvCoverageMode: 'on',
  satelliteClasses: {
    stations: true,
    imaging: true,
    telecom: true,
    starlink: false,
    probes: true,
  },
  toggleLayer: (id) =>
    set((s) => ({
      layers: {
        ...s.layers,
        [id]: { ...s.layers[id], enabled: !s.layers[id].enabled },
      },
    })),
  setLayerEnabled: (id, enabled) =>
    set((s) => ({
      layers: {
        ...s.layers,
        [id]: { ...s.layers[id], enabled },
      },
    })),
  setLayersEnabled: (updates) =>
    set((s) => {
      const next = { ...s.layers };
      for (const [id, enabled] of Object.entries(updates) as Array<
        [LayerId, boolean]
      >) {
        if (next[id]) {
          next[id] = { ...next[id], enabled };
        }
      }
      return { layers: next };
    }),
  updateLayerState: (id, patch) =>
    set((s) => ({
      layers: {
        ...s.layers,
        [id]: { ...s.layers[id], ...patch },
      },
    })),
  setTrafficLines: (trafficLines) => set({ trafficLines }),
  setCctvCoverageMode: (cctvCoverageMode) => set({ cctvCoverageMode }),
  cycleCctvCoverageMode: () =>
    set((s) => ({
      cctvCoverageMode:
        s.cctvCoverageMode === 'off'
          ? 'on'
          : s.cctvCoverageMode === 'on'
            ? 'viewshed'
            : 'off',
    })),
  toggleSatelliteClass: (key) =>
    set((s) => ({
      satelliteClasses: {
        ...s.satelliteClasses,
        [key]: !s.satelliteClasses[key],
      },
    })),
}));
