import { create } from 'zustand';

export interface FlyToRequest {
  lat: number;
  lon: number;
  alt: number;
  heading?: number;
  pitch?: number;
  label?: string;
  nonce: number;
}

interface LocationStoreState {
  activeCityId: string;
  activePoiIndex: number;
  searchQuery: string;
  searching: boolean;
  searchError: string | null;
  flyToRequest: FlyToRequest | null;
  resetGlobeNonce: number;
  tiltMode: 'oblique' | 'nadir';
  northUpNonce: number;

  setActiveCity: (cityId: string, poiIndex?: number) => void;
  setActivePoiIndex: (index: number) => void;
  setSearchQuery: (query: string) => void;
  setSearching: (searching: boolean) => void;
  setSearchError: (error: string | null) => void;
  triggerFlyTo: (req: Omit<FlyToRequest, 'nonce'>) => void;
  triggerResetGlobe: () => void;
  toggleTiltMode: () => void;
  triggerNorthUp: () => void;
}

let flyNonce = 0;

export const useLocationStore = create<LocationStoreState>((set) => ({
  activeCityId: 'austin',
  activePoiIndex: 0,
  searchQuery: '',
  searching: false,
  searchError: null,
  flyToRequest: null,
  resetGlobeNonce: 0,
  tiltMode: 'oblique',
  northUpNonce: 0,

  setActiveCity: (activeCityId, activePoiIndex = 0) =>
    set({ activeCityId, activePoiIndex }),
  setActivePoiIndex: (activePoiIndex) => set({ activePoiIndex }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearching: (searching) => set({ searching }),
  setSearchError: (searchError) => set({ searchError }),
  triggerFlyTo: (req) =>
    set({
      flyToRequest: { ...req, nonce: ++flyNonce },
    }),
  triggerResetGlobe: () =>
    set((s) => ({ resetGlobeNonce: s.resetGlobeNonce + 1 })),
  toggleTiltMode: () =>
    set((s) => ({
      tiltMode: s.tiltMode === 'oblique' ? 'nadir' : 'oblique',
    })),
  triggerNorthUp: () => set((s) => ({ northUpNonce: s.northUpNonce + 1 })),
}));
