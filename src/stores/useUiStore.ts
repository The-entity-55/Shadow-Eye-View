import { create } from 'zustand';

export interface ProviderStatus {
  googleMaps: boolean;
  cesiumIon: boolean;
  opensky: boolean;
  openai: boolean;
  gemini: boolean;
  firms: boolean;
  aisstream: boolean;
  tomtom: boolean;
}

interface UiStoreState {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  locationTrayExpanded: boolean;
  presetsTrayExpanded: boolean;
  welcomeVisible: boolean;
  providerSettingsOpen: boolean;
  loadingVisible: boolean;
  loadingStatus: string;
  loadingError: string | null;
  toast: { text: string; tone: 'info' | 'warn' | 'error'; nonce: number } | null;
  configuredProviders: ProviderStatus;
  clientTokens: { googleApiKey: string; cesiumToken: string };

  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setLocationTrayExpanded: (expanded: boolean) => void;
  setPresetsTrayExpanded: (expanded: boolean) => void;
  setWelcomeVisible: (visible: boolean) => void;
  dismissWelcome: (suppressForever?: boolean) => void;
  setProviderSettingsOpen: (open: boolean) => void;
  setLoading: (visible: boolean, status?: string, error?: string | null) => void;
  showToast: (text: string, tone?: 'info' | 'warn' | 'error') => void;
  setServerConfig: (
    configuredProviders: ProviderStatus,
    clientTokens: { googleApiKey: string; cesiumToken: string },
  ) => void;
}

const FIRST_RUN_SUPPRESS_KEY = 'gev:first-run-suppressed';
let toastNonce = 0;

export const useUiStore = create<UiStoreState>((set) => ({
  leftPanelOpen: true,
  rightPanelOpen: false,
  locationTrayExpanded: false,
  presetsTrayExpanded: false,
  welcomeVisible: true,
  providerSettingsOpen: false,
  loadingVisible: true,
  loadingStatus: 'Initializing photorealistic world...',
  loadingError: null,
  toast: null,
  configuredProviders: {
    googleMaps: false,
    cesiumIon: false,
    opensky: false,
    openai: false,
    gemini: false,
    firms: false,
    aisstream: false,
    tomtom: false,
  },
  clientTokens: { googleApiKey: '', cesiumToken: '' },

  setLeftPanelOpen: (leftPanelOpen) => set({ leftPanelOpen }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  setLocationTrayExpanded: (locationTrayExpanded) => set({ locationTrayExpanded }),
  setPresetsTrayExpanded: (presetsTrayExpanded) => set({ presetsTrayExpanded }),
  setWelcomeVisible: (welcomeVisible) => set({ welcomeVisible }),
  dismissWelcome: (suppressForever = false) => {
    if (suppressForever && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(FIRST_RUN_SUPPRESS_KEY, '1');
      } catch {
        // ignore storage restrictions
      }
    }
    set({ welcomeVisible: false });
  },
  setProviderSettingsOpen: (providerSettingsOpen) => set({ providerSettingsOpen }),
  setLoading: (loadingVisible, loadingStatus, loadingError = null) =>
    set((s) => ({
      loadingVisible,
      loadingStatus: loadingStatus ?? s.loadingStatus,
      loadingError,
    })),
  showToast: (text, tone = 'info') =>
    set({ toast: { text, tone, nonce: ++toastNonce } }),
  setServerConfig: (configuredProviders, clientTokens) =>
    set({ configuredProviders, clientTokens }),
}));

export function isFirstRunSuppressed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(FIRST_RUN_SUPPRESS_KEY) === '1';
  } catch {
    return false;
  }
}
