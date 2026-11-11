import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { greatCircleKmBetween } from './routePlausible';
import type { TileBBox } from './tomtomTiles';

/**
 * TomTom traffic-flow MVT decoder, congestion bucket styling, and viewport fetch-box math
 * ported from upstream src/layers/traffic/flowDecode.js, src/data/trafficFlowStyle.js,
 * src/layers/traffic/roadModes.js, and src/data/trafficBounds.js.
 */

const FLOW_LAYER_NAME = 'Traffic flow';
const EARTH_RADIUS_KM = 6_371.0088;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const FREE_THRESHOLD = 0.85;
const SLOW_THRESHOLD = 0.55;

export type FlowBucket = 'free' | 'slow' | 'jam';

export const FLOW_BUCKET_HEX: Record<FlowBucket, string> = {
  free: '#2ecc71',
  slow: '#f0b23e',
  jam: '#e05252',
};

export const FLOW_ROAD_TYPES: Record<
  string,
  'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential'
> = {
  Motorway: 'motorway',
  'International road': 'trunk',
  'Major road': 'primary',
  'Secondary road': 'secondary',
  'Connecting road': 'tertiary',
  'Major local road': 'tertiary',
  'Local road': 'residential',
  'Minor local road': 'residential',
};

export const SPEED_BY_HIGHWAY_MPS: Record<string, number> = {
  motorway: 26,
  trunk: 21,
  primary: 15,
  secondary: 12,
  tertiary: 9,
  residential: 6,
};

export const DENSITY_BY_HIGHWAY: Record<string, number> = {
  motorway: 2.8,
  trunk: 2.4,
  primary: 1.9,
  secondary: 1.4,
  tertiary: 1.0,
  residential: 0.6,
};

export const PIXEL_SIZE_BY_HIGHWAY: Record<string, number> = {
  motorway: 6,
  trunk: 6,
  primary: 5,
  secondary: 5,
  tertiary: 4,
  residential: 4,
};

const DRIVABLE_CATEGORIES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'street',
]);

export interface TrafficFlowSegment {
  coords: Array<[number, number]>;
  trafficLevel: number;
  roadType: string;
  highway: 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential';
  roadCategory: string | null;
  closure: boolean;
  bucket: FlowBucket;
}

export function flowBucket(level: number): FlowBucket {
  if (!Number.isFinite(level)) return 'free';
  if (level >= FREE_THRESHOLD) return 'free';
  if (level >= SLOW_THRESHOLD) return 'slow';
  return 'jam';
}

export function flowSpeedScale(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(1, Math.max(0.15, level));
}

export function flowDensityMult(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.min(2.5, 1 / Math.max(level, 0.4));
}

export function decodeTomTomFlowTile(
  data: ArrayBuffer | Uint8Array,
  z: number,
  x: number,
  y: number,
  strict = false,
): TrafficFlowSegment[] {
  let layer;
  try {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const tile = new VectorTile(new PbfReader(bytes));
    layer = tile.layers[FLOW_LAYER_NAME];
  } catch {
    if (strict) throw new Error('Malformed TomTom flow tile');
    return [];
  }
  if (!layer) return [];

  const segments: TrafficFlowSegment[] = [];
  for (let i = 0; i < layer.length; i++) {
    let feature;
    let geometry;
    try {
      feature = layer.feature(i);
      geometry = feature.toGeoJSON(x, y, z).geometry;
    } catch {
      continue;
    }
    const props = feature.properties || {};
    const roadType = typeof props.road_type === 'string' ? props.road_type : '';
    const highway = FLOW_ROAD_TYPES[roadType];
    if (!highway) continue;

    const roadCategory = typeof props.road_category === 'string' ? props.road_category : null;
    if (roadCategory && !DRIVABLE_CATEGORIES.has(roadCategory)) continue;

    const closure = props.road_closure === true || props.road_closure === 'true';
    const rawLevel = props.traffic_level;
    const hasLevel = typeof rawLevel === 'number' && Number.isFinite(rawLevel);
    if (!hasLevel && !closure) continue;

    const trafficLevel = hasLevel ? Math.min(1, Math.max(0, rawLevel)) : 0;
    const bucket = flowBucket(trafficLevel);

    const lines =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString'
          ? geometry.coordinates
          : [];

    for (const rawCoords of lines) {
      if (!Array.isArray(rawCoords) || rawCoords.length < 2) continue;
      const coords: Array<[number, number]> = [];
      for (const pt of rawCoords) {
        if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
          coords.push([pt[0], pt[1]]);
        }
      }
      if (coords.length < 2) continue;
      segments.push({
        coords,
        trafficLevel,
        roadType,
        highway,
        roadCategory,
        closure,
        bucket,
      });
    }
  }
  return segments;
}

export function deriveFetchCenter(params: {
  nadirLat: number;
  nadirLon: number;
  hitLat?: number;
  hitLon?: number;
  maxPullKm?: number;
}): { lat: number; lon: number; source: 'hit' | 'nadir' | 'pulled' } {
  const { nadirLat, nadirLon, hitLat, hitLon, maxPullKm = 12 } = params;
  if (
    typeof hitLat !== 'number' ||
    typeof hitLon !== 'number' ||
    !Number.isFinite(hitLat) ||
    !Number.isFinite(hitLon)
  ) {
    return { lat: nadirLat, lon: nadirLon, source: 'nadir' };
  }

  const distKm = greatCircleKmBetween({ lat: nadirLat, lon: nadirLon }, { lat: hitLat, lon: hitLon });
  if (distKm <= maxPullKm) {
    return { lat: hitLat, lon: hitLon, source: 'hit' };
  }

  const p1 = nadirLat * D2R;
  const p2 = hitLat * D2R;
  const dl = (hitLon - nadirLon) * D2R;
  const brng = Math.atan2(
    Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl),
  );
  const delta = maxPullKm / EARTH_RADIUS_KM;
  const l1 = nadirLon * D2R;
  const destLatRad = Math.asin(
    Math.sin(p1) * Math.cos(delta) + Math.cos(p1) * Math.sin(delta) * Math.cos(brng),
  );
  const destLonRad =
    l1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(delta) * Math.cos(p1),
      Math.cos(delta) - Math.sin(p1) * Math.sin(destLatRad),
    );
  return {
    lat: destLatRad * R2D,
    lon: ((((destLonRad * R2D + 180) % 360) + 360) % 360) - 180,
    source: 'pulled',
  };
}

export function clampBoundsAroundCenter(
  centerLat: number,
  centerLon: number,
  halfSpanDeg = 0.025,
): TileBBox {
  const cosLat = Math.max(0.25, Math.cos(centerLat * D2R));
  const halfLon = Math.min(0.1, halfSpanDeg / cosLat);
  return {
    south: Math.max(-85, centerLat - halfSpanDeg),
    north: Math.min(85, centerLat + halfSpanDeg),
    west: Math.max(-180, centerLon - halfLon),
    east: Math.min(180, centerLon + halfLon),
  };
}
