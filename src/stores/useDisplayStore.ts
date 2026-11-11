import { create } from 'zustand';
import type {
  DetectionMode,
  HudLayoutVariant,
  MapStackId,
  Models3dMode,
  VisualStyleId,
} from '@/types/gev';

export interface StyleUniformValues {
  retro: { pixelation: number; distortion: number; instability: number };
  surveillance: {
    gain: number;
    bloom: number;
    scanlineStr: number;
    pixelation: number;
  };
  thermal: {
    sensitivity: number;
    bloom: number;
    mode: number;
    pixelation: number;
    palette: number;
  };
  anime: { saturation: number; edgeThick: number };
  noir: { contrastAmt: number; grainAmt: number; vignetteAmt: number };
}

export const DEFAULT_STYLE_PARAMS: StyleUniformValues = {
  retro: { pixelation: 1.0, distortion: 0, instability: 0.42 },
  surveillance: {
    gain: 0.18,
    bloom: 0.22,
    scanlineStr: 0.96,
    pixelation: 1.0,
  },
  thermal: {
    sensitivity: 0.85,
    bloom: 0.2,
    mode: 0.33,
    pixelation: 1.0,
    palette: 0.0,
  },
  anime: { saturation: 1.0, edgeThick: 0.5 },
  noir: { contrastAmt: 1.2, grainAmt: 0.5, vignetteAmt: 0.5 },
};

export interface StackAvailability {
  available: boolean;
  reason?: string;
}

interface DisplayStoreState {
  style: VisualStyleId;
  styleParams: StyleUniformValues;
  sharpenEnabled: boolean;
  sharpenIntensity: number;
  bloomEnabled: boolean;
  bloomIntensity: number;
  hudVisible: boolean;
  hudVariant: HudLayoutVariant;
  detectionMode: DetectionMode;
  detectionDensity: number;
  models3dMode: Models3dMode;
  cleanView: boolean;
  autoOrbit: boolean;
  cockpitMode: boolean;
  mapStack: MapStackId;
  mapStackStatus: string;
  mapStackWarn: boolean;
  stackAvailability: Record<MapStackId, StackAvailability>;

  setStyle: (style: VisualStyleId) => void;
  setStyleParam: <K extends keyof StyleUniformValues>(
    style: K,
    key: keyof StyleUniformValues[K],
    value: number,
  ) => void;
  setSharpenEnabled: (enabled: boolean) => void;
  setSharpenIntensity: (intensity: number) => void;
  setBloomEnabled: (enabled: boolean) => void;
  setBloomIntensity: (intensity: number) => void;
  setHudVisible: (visible: boolean) => void;
  setHudVariant: (variant: HudLayoutVariant) => void;
  setDetectionMode: (mode: DetectionMode) => void;
  cycleDetectionMode: () => void;
  setDetectionDensity: (density: number) => void;
  setModels3dMode: (mode: Models3dMode) => void;
  setCleanView: (clean: boolean) => void;
  setAutoOrbit: (orbit: boolean) => void;
  setCockpitMode: (cockpit: boolean) => void;
  setMapStack: (stack: MapStackId) => void;
  setMapStackStatus: (status: string, warn?: boolean) => void;
  setStackAvailability: (
    availability: Record<MapStackId, StackAvailability>,
  ) => void;
}

const MILITARY_STYLES = new Set<VisualStyleId>([
  'retro',
  'surveillance',
  'thermal',
]);

export const useDisplayStore = create<DisplayStoreState>((set) => ({
  style: 'normal',
  styleParams: structuredClone(DEFAULT_STYLE_PARAMS),
  sharpenEnabled: true,
  sharpenIntensity: 49,
  bloomEnabled: false,
  bloomIntensity: 50,
  hudVisible: true,
  hudVariant: 'tactical',
  detectionMode: 'DENSE',
  detectionDensity: 75,
  models3dMode: 'proximity',
  cleanView: false,
  autoOrbit: false,
  cockpitMode: false,
  mapStack: 'esri-imagery',
  mapStackStatus: 'SAT',
  mapStackWarn: false,
  stackAvailability: {
    photoreal: {
      available: false,
      reason: 'Needs Google Maps API key or Cesium ion token (POWER UP)',
    },
    'bing-aerial': {
      available: false,
      reason: 'Needs Cesium ion token (POWER UP)',
    },
    'bing-labels': {
      available: false,
      reason: 'Needs Cesium ion token (POWER UP)',
    },
    'esri-imagery': { available: true },
    osm: { available: true },
  },

  setStyle: (style) =>
    set((s) => ({
      style,
      hudVisible: MILITARY_STYLES.has(style) ? true : s.hudVisible,
    })),
  setStyleParam: (style, key, value) =>
    set((s) => ({
      styleParams: {
        ...s.styleParams,
        [style]: {
          ...s.styleParams[style],
          [key]: value,
        },
      },
    })),
  setSharpenEnabled: (sharpenEnabled) => set({ sharpenEnabled }),
  setSharpenIntensity: (sharpenIntensity) => set({ sharpenIntensity }),
  setBloomEnabled: (bloomEnabled) => set({ bloomEnabled }),
  setBloomIntensity: (bloomIntensity) => set({ bloomIntensity }),
  setHudVisible: (hudVisible) => set({ hudVisible }),
  setHudVariant: (hudVariant) => set({ hudVariant }),
  setDetectionMode: (detectionMode) => set({ detectionMode }),
  cycleDetectionMode: () =>
    set((s) => ({
      detectionMode:
        s.detectionMode === 'OFF'
          ? 'SPARSE'
          : s.detectionMode === 'SPARSE'
            ? 'DENSE'
            : 'OFF',
    })),
  setDetectionDensity: (detectionDensity) => set({ detectionDensity }),
  setModels3dMode: (models3dMode) => set({ models3dMode }),
  setCleanView: (cleanView) => set({ cleanView }),
  setAutoOrbit: (autoOrbit) => set({ autoOrbit }),
  setCockpitMode: (cockpitMode) => set({ cockpitMode }),
  setMapStack: (mapStack) => set({ mapStack }),
  setMapStackStatus: (mapStackStatus, mapStackWarn = false) =>
    set({ mapStackStatus, mapStackWarn }),
  setStackAvailability: (stackAvailability) => set({ stackAvailability }),
}));
