export type VisualStyleId =
  | 'normal'
  | 'retro'
  | 'surveillance'
  | 'thermal'
  | 'anime'
  | 'noir';

export type HudLayoutVariant = 'tactical' | 'minimal' | 'cyber';

export type DetectionMode = 'OFF' | 'SPARSE' | 'DENSE';

export type MapStackId =
  | 'photoreal'
  | 'bing-aerial'
  | 'bing-labels'
  | 'esri-imagery'
  | 'osm';

export type LayerId =
  | 'flights'
  | 'military'
  | 'vessels'
  | 'traffic'
  | 'satellites'
  | 'earthquakes'
  | 'cctv';

export type LayerCategory = 'Movement' | 'Space' | 'Cameras' | 'Events';

export interface LayerState {
  id: LayerId;
  name: string;
  category: LayerCategory;
  enabled: boolean;
  loading: boolean;
  status: 'IDLE' | 'LOADING' | 'LIVE' | 'STALE' | 'ERROR';
  sourceLabel: string;
  count: number;
  error: string | null;
}

export type SatelliteClassKey =
  | 'stations'
  | 'imaging'
  | 'telecom'
  | 'starlink'
  | 'probes';

export type CctvCoverageMode = 'off' | 'on' | 'viewshed';

export type Models3dMode = 'proximity' | 'all' | 'off';

export interface PoiPreset {
  name: string;
  lat: number;
  lon: number;
  alt: number;
  pitch: number;
  heading: number;
  buildingHeight: number;
}

export interface CityPreset {
  id: string;
  name: string;
  groundElevation: number;
  pois: PoiPreset[];
}

export interface AirportEndpoint {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
}

export interface FlightRouteInfo {
  airline?: string | null;
  registration?: string | null;
  typeCode?: string | null;
  typeName?: string | null;
  origin?: AirportEndpoint | null;
  destination?: AirportEndpoint | null;
  plausible: boolean;
  destBearingDeg?: number | null;
  relBearingDeg?: number | null;
  trailPoints: number;
  backfilled: boolean;
}

export interface PredictedWaypoint {
  lat: number;
  lon: number;
  altM: number;
  etaMin: number;
  label: string;
}

export interface FlightPrediction {
  provider: 'gemini' | 'openai' | 'kinematic';
  model: string;
  phase: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  etaMin: number | null;
  summary: string;
  waypoints: PredictedWaypoint[];
  generatedAtMs: number;
  loading?: boolean;
}

export interface SelectedEntityInfo {
  entityId: string;
  kind: 'flight' | 'military' | 'vessel' | 'satellite' | 'earthquake' | 'cctv';
  title: string;
  subtitle: string;
  lat: number;
  lon: number;
  altM: number;
  telemetry: Array<{ label: string; value: string }>;
  cctvId?: string;
  cctvProvider?: string;
  cctvLicense?: string;
  canCockpit?: boolean;
  flightRoute?: FlightRouteInfo | null;
  flightPrediction?: FlightPrediction | null;
}

export interface NearbyContact {
  entityId: string;
  id: string;
  callsign: string;
  kind: 'flight' | 'military';
  altM: number;
  speedKts: number;
  headingDeg: number;
  distKm: number;
}

export interface DetectionTarget {
  entityId: string;
  label: string;
  sublabel?: string;
  category: 'flight' | 'military' | 'vessel' | 'traffic' | 'satellite' | 'earthquake' | 'cctv';
  lat: number;
  lon: number;
  altM: number;
  color: string;
  priority: number;
}
