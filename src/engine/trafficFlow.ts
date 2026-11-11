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

/** Liang-Barsky viewport/tile bbox clipper ported from upstream src/sources/openFreeMap.js. */
export function clipLineToBounds(
  coords: Array<[number, number]>,
  box: TileBBox,
): Array<Array<[number, number]>> {
  const lines: Array<Array<[number, number]>> = [];
  let line: Array<[number, number]> = [];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    let lo = 0;
    let hi = 1;
    const p = [-dx, dx, -dy, dy];
    const q = [a[0] - box.west, box.east - a[0], a[1] - box.south, box.north - a[1]];
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) {
        if (q[k] < 0) hi = -1;
      } else if (p[k] < 0) {
        lo = Math.max(lo, q[k] / p[k]);
      } else {
        hi = Math.min(hi, q[k] / p[k]);
      }
    }
    if (lo > hi) {
      if (line.length > 1) lines.push(line);
      line = [];
      continue;
    }
    const start: [number, number] = [a[0] + lo * dx, a[1] + lo * dy];
    const end: [number, number] = [a[0] + hi * dx, a[1] + hi * dy];
    const last = line[line.length - 1];
    if (!last || Math.abs(last[0] - start[0]) + Math.abs(last[1] - start[1]) > 1e-10) {
      if (line.length > 1) lines.push(line);
      line = [start];
    }
    if (Math.abs(end[0] - start[0]) + Math.abs(end[1] - start[1]) > 1e-10) {
      line.push(end);
    }
    if (hi < 1) {
      if (line.length > 1) lines.push(line);
      line = [];
    }
  }
  if (line.length > 1) lines.push(line);
  return lines;
}

/** Decimate densely vertices along bends while preserving endpoints and road extent. */
export function simplifyRoadCoords(
  coords: Array<[number, number]>,
  minStepM = 18,
  maxPoints = 48,
): Array<[number, number]> {
  if (coords.length <= 2) return coords;
  const out: Array<[number, number]> = [coords[0]];
  let last = coords[0];
  for (let i = 1; i < coords.length - 1; i++) {
    const pt = coords[i];
    const metres =
      Math.hypot((pt[0] - last[0]) * Math.cos(pt[1] * D2R), pt[1] - last[1]) * 111_320;
    if (metres >= minStepM) {
      out.push(pt);
      last = pt;
    }
  }
  out.push(coords[coords.length - 1]);
  if (out.length <= maxPoints) return out;
  const sampled: Array<[number, number]> = [];
  const stride = (out.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints - 1; i++) {
    sampled.push(out[Math.round(i * stride)]);
  }
  sampled.push(out[out.length - 1]);
  return sampled;
}

/** Height stations spaced >= 150 m apart, matching upstream src/layers/traffic/surface.js. */
export function roadHeightStations(
  coords: Array<[number, number]>,
  maxSpacingM = 150,
): { indices: number[]; distances: number[] } {
  const distances = [0];
  const indices = [0];
  let anchor = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const metres =
      Math.hypot((b[0] - a[0]) * Math.cos(a[1] * D2R), b[1] - a[1]) * 111_320;
    distances.push(distances[i - 1] + metres);
    if (distances[i] - distances[anchor] > maxSpacingM + 0.001 && i - 1 > anchor) {
      anchor = i - 1;
      indices.push(anchor);
    }
  }
  if (indices[indices.length - 1] !== coords.length - 1) {
    indices.push(coords.length - 1);
  }
  return { indices, distances };
}

/** Altitude-scaled vehicle dot cap matching upstream src/layers/traffic/policy.js. */
export function roadDotBudget(altitudeM: number, maxDots = 1_000): number {
  const safeAlt = Number.isFinite(altitudeM) ? Math.max(1_000, altitudeM) : 4_000;
  return Math.max(250, Math.min(maxDots, Math.round(maxDots * Math.pow(1_000 / safeAlt, 1.5))));
}

/** Intersection-over-reference overlap test matching upstream src/layers/traffic/viewport.js. */
export function boundsOverlap(a: TileBBox, b: TileBBox, threshold = 0.6): boolean {
  const overlapS = Math.max(a.south, b.south);
  const overlapN = Math.min(a.north, b.north);
  const overlapW = Math.max(a.west, b.west);
  const overlapE = Math.min(a.east, b.east);
  if (overlapN <= overlapS || overlapE <= overlapW) return false;
  const overlapArea = (overlapN - overlapS) * (overlapE - overlapW);
  const aArea = (a.north - a.south) * (a.east - a.west);
  return aArea > 0 && overlapArea / aArea >= threshold;
}
