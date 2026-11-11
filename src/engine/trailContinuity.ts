import { greatCircleKmBetween } from './routePlausible';

/**
 * Aircraft track-history continuity & backfill helpers ported from upstream
 * src/data/trailContinuity.js and src/layers/flights/tracking.js.
 */

export const TRAIL_MAX_POINTS = 2000;
export const TRAIL_CONTINUITY_MAX_GAP_MS = 48 * 60_000;
export const TRAIL_CONTINUITY_MAX_SPEED_KT = 1_500;
export const TRAIL_STATIONARY_HOLD_MAX_GAP_MS = 3 * 60 * 60_000;
export const TRAIL_STATIONARY_HOLD_MAX_DISTANCE_NM = 0.1;
export const TRAIL_HEAD_JOIN_MAX_M = 150_000;

const METRES_PER_NM = 1852;

export interface TrailFixPoint {
  lon: number;
  lat: number;
  altM: number;
  epochMs: number;
  breakBefore?: boolean;
  backfilled?: boolean;
}

export function trailPairBreaks(deltaMs: number, distanceM: number): boolean {
  if (!(deltaMs > 0) || !Number.isFinite(distanceM)) return true;
  const distanceNm = distanceM / METRES_PER_NM;
  if (
    deltaMs <= TRAIL_STATIONARY_HOLD_MAX_GAP_MS &&
    distanceNm <= TRAIL_STATIONARY_HOLD_MAX_DISTANCE_NM
  ) {
    return false;
  }
  return (
    deltaMs > TRAIL_CONTINUITY_MAX_GAP_MS ||
    distanceNm / (deltaMs / 3_600_000) > TRAIL_CONTINUITY_MAX_SPEED_KT
  );
}

export function parseOpenSkyTrackWaypoints(
  rows: unknown[],
  oldestLiveEpochMs: number,
  geoidHeightFn: (lat: number, lon: number) => number,
): TrailFixPoint[] {
  if (!Array.isArray(rows) || !rows.length) return [];

  const out: TrailFixPoint[] = [];
  let pendingBreak = false;

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      pendingBreak = true;
      continue;
    }
    const timeSec = Number(row[0]);
    const lat = Number(row[1]);
    const lon = Number(row[2]);
    const onGround = row[5] === true;
    const rawBaro = row[3] !== null && row[3] !== undefined ? Number(row[3]) : NaN;
    const epochMs = Math.round(timeSec * 1000);

    if (
      !Number.isFinite(timeSec) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      pendingBreak = true;
      continue;
    }

    if (Number.isFinite(oldestLiveEpochMs) && epochMs >= oldestLiveEpochMs) {
      continue;
    }

    // Missing altitude in a track tuple lifts the pen rather than dropping down to 0
    const knownAlt = Number.isFinite(rawBaro) ? Math.max(0, rawBaro) : onGround ? 3 : null;
    if (knownAlt === null) {
      pendingBreak = true;
      continue;
    }

    const altM = Math.max(0, knownAlt + geoidHeightFn(lat, lon));
    const prev = out[out.length - 1];
    let breakBefore = pendingBreak;
    if (!breakBefore && prev) {
      const distM = greatCircleKmBetween(prev, { lat, lon }) * 1000;
      breakBefore = trailPairBreaks(epochMs - prev.epochMs, distM);
    }

    out.push({
      lon,
      lat,
      altM,
      epochMs,
      breakBefore,
      backfilled: true,
    });
    pendingBreak = false;
  }

  return out;
}

export function mergeBackfillTrailPoints(
  backfill: TrailFixPoint[],
  livePoints: TrailFixPoint[],
  maxPoints = TRAIL_MAX_POINTS,
): TrailFixPoint[] {
  if (!backfill.length) return livePoints.slice(-maxPoints);
  const oldestBackfill = backfill[backfill.length - 1];
  const tailLive = livePoints.filter((p) => p.epochMs > oldestBackfill.epochMs);
  if (tailLive.length > 0) {
    const firstLive = { ...tailLive[0] };
    const distM = greatCircleKmBetween(oldestBackfill, firstLive) * 1000;
    firstLive.breakBefore =
      Boolean(firstLive.breakBefore) ||
      trailPairBreaks(firstLive.epochMs - oldestBackfill.epochMs, distM);
    tailLive[0] = firstLive;
  }
  const merged = backfill.concat(tailLive);
  if (merged.length <= maxPoints) return merged;
  return merged.slice(merged.length - maxPoints);
}

export function splitTrailIntoSegments(points: TrailFixPoint[]): TrailFixPoint[][] {
  const segments: TrailFixPoint[][] = [];
  for (const pt of points) {
    const currentSeg = segments[segments.length - 1];
    if (!currentSeg) {
      segments.push([pt]);
      continue;
    }
    const prev = currentSeg[currentSeg.length - 1];
    const distM = greatCircleKmBetween(prev, pt) * 1000;
    if (pt.breakBefore || trailPairBreaks(pt.epochMs - prev.epochMs, distM)) {
      segments.push([pt]);
    } else {
      currentSeg.push(pt);
    }
  }
  return segments;
}
