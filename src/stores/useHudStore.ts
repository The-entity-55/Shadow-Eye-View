import { create } from 'zustand';
import type { CockpitLookAngles } from '@/engine/cockpitLook';
import type { NearbyContact, SelectedEntityInfo } from '@/types/gev';

interface HudStoreState {
  lat: number;
  lon: number;
  altM: number;
  mgrs: string;
  latlonText: string;
  gsdText: string;
  altText: string;
  collText: string;
  onaText: string;
  utcTimestamp: string;
  regionLabel: string;
  localityLabel: string;
  fps: number;
  showFps: boolean;
  selectedEntity: SelectedEntityInfo | null;
  nearbyContacts: NearbyContact[];
  trackTargetNonce: { entityId: string; cockpit: boolean; nonce: number } | null;
  routeOverviewActive: boolean;
  cockpitLook: CockpitLookAngles;

  updateTelemetry: (
    patch: Partial<
      Omit<
        HudStoreState,
        | 'updateTelemetry'
        | 'toggleShowFps'
        | 'setSelectedEntity'
        | 'setNearbyContacts'
        | 'requestTrackEntity'
        | 'setRouteOverviewActive'
        | 'setCockpitLook'
      >
    >,
  ) => void;
  toggleShowFps: () => void;
  setSelectedEntity: (entity: SelectedEntityInfo | null) => void;
  setNearbyContacts: (contacts: NearbyContact[]) => void;
  requestTrackEntity: (entityId: string, cockpit?: boolean) => void;
  setRouteOverviewActive: (active: boolean) => void;
  setCockpitLook: (look: CockpitLookAngles) => void;
}

let trackNonce = 0;

export const useHudStore = create<HudStoreState>((set) => ({
  lat: 30.2747,
  lon: -97.7403,
  altM: 550,
  mgrs: '14RPU21150489',
  latlonText: '30°16\'29"N  097°44\'25"W',
  gsdText: 'GSD 0.05M  NIIRS 9.0',
  altText: 'ALT 0.6 KM MSL',
  collText: 'COLL --:--:--Z',
  onaText: 'ONA 28.0°  SUN --°',
  utcTimestamp: '00:00:00Z',
  regionLabel: 'NORTH AMERICA',
  localityLabel: 'AUSTIN',
  fps: 60,
  showFps: false,
  selectedEntity: null,
  nearbyContacts: [],
  trackTargetNonce: null,
  routeOverviewActive: false,
  cockpitLook: { yawDeg: 0, pitchDeg: -4 },

  updateTelemetry: (patch) => set((s) => ({ ...s, ...patch })),
  toggleShowFps: () => set((s) => ({ showFps: !s.showFps })),
  setSelectedEntity: (selectedEntity) => set({ selectedEntity }),
  setNearbyContacts: (nearbyContacts) => set({ nearbyContacts }),
  requestTrackEntity: (entityId, cockpit = false) =>
    set({
      trackTargetNonce: { entityId, cockpit, nonce: ++trackNonce },
    }),
  setRouteOverviewActive: (routeOverviewActive) => set({ routeOverviewActive }),
  setCockpitLook: (cockpitLook) => set({ cockpitLook }),
}));
