import { bearingBetweenDeg, greatCircleKmBetween } from './routePlausible';

const EARTH_RADIUS_M = 6_371_008.8;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const MAX_PLAUSIBLE_SPEED_MPS = 670; // ~1,300 kt ceiling for AI waypoint sanity

export interface PredictionRecentFix {
  lat: number;
  lon: number;
  altM: number;
  epochMs: number;
  speedMps?: number;
  courseDeg?: number;
}

export interface PredictionEndpoint {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
}

export interface FlightPredictInput {
  icao24: string;
  callsign: string;
  military?: boolean;
  typeCode?: string | null;
  typeName?: string | null;
  airline?: string | null;
  lat: number;
  lon: number;
  altM: number;
  speedMps: number;
  courseDeg: number;
  verticalRateMps: number;
  onGround: boolean;
  recentFixes?: PredictionRecentFix[];
  route?: {
    origin?: PredictionEndpoint | null;
    destination?: PredictionEndpoint | null;
  } | null;
}

export interface PredictedWaypointMath {
  lat: number;
  lon: number;
  altM: number;
  etaMin: number;
  label: string;
}

export type FlightPhase =
  | 'GROUND'
  | 'TAKEOFF'
  | 'CLIMB'
  | 'CRUISE'
  | 'DESCENT'
  | 'APPROACH';

export function advanceGeoPoint(
  latDeg: number,
  lonDeg: number,
  bearingDeg: number,
  distanceM: number,
): { lat: number; lon: number } {
  const angular = Math.max(0, distanceM) / EARTH_RADIUS_M;
  if (angular === 0) return { lat: latDeg, lon: lonDeg };
  const lat1 = latDeg * D2R;
  const lon1 = lonDeg * D2R;
  const brng = bearingDeg * D2R;

  const sinLat2 =
    Math.sin(lat1) * Math.cos(angular) +
    Math.cos(lat1) * Math.sin(angular) * Math.cos(brng);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return {
    lat: lat2 * R2D,
    lon: ((((lon2 * R2D + 180) % 360) + 360) % 360) - 180,
  };
}

export function interpolateGreatCirclePoint(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  fraction: number,
): { lat: number; lon: number } {
  const t = Math.max(0, Math.min(1, fraction));
  const distM = greatCircleKmBetween({ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 }) * 1000;
  if (distM < 1) return { lat: lat2, lon: lon2 };
  const bearing = bearingBetweenDeg(lat1, lon1, lat2, lon2);
  return advanceGeoPoint(lat1, lon1, bearing, distM * t);
}

function estimateTurnRateDegPerSec(fixes: PredictionRecentFix[] | undefined): number {
  if (!fixes || fixes.length < 2) return 0;
  const tail = fixes.slice(-4);
  const first = tail[0];
  const last = tail[tail.length - 1];
  const dtSec = (last.epochMs - first.epochMs) / 1000;
  if (
    !Number.isFinite(dtSec) ||
    dtSec < 3 ||
    typeof first.courseDeg !== 'number' ||
    typeof last.courseDeg !== 'number'
  ) {
    return 0;
  }
  const delta = ((((last.courseDeg - first.courseDeg) % 360) + 540) % 360) - 180;
  return Math.max(-2.2, Math.min(2.2, delta / dtSec));
}

export function inferFlightPhase(input: FlightPredictInput): FlightPhase {
  if (input.onGround) return input.speedMps > 25 ? 'TAKEOFF' : 'GROUND';
  if (input.altM < 2_500 && input.verticalRateMps < -1.2) return 'APPROACH';
  if (input.altM < 3_500 && input.verticalRateMps > 2.5) return 'TAKEOFF';
  if (input.verticalRateMps > 2.0) return 'CLIMB';
  if (input.verticalRateMps < -2.0) return 'DESCENT';
  return 'CRUISE';
}

export function computeKinematicPrediction(input: FlightPredictInput): {
  phase: FlightPhase;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  etaMin: number | null;
  summary: string;
  waypoints: PredictedWaypointMath[];
} {
  const phase = inferFlightPhase(input);
  const dest = input.route?.destination;
  const hasDest =
    !!dest &&
    typeof dest.lat === 'number' &&
    typeof dest.lon === 'number' &&
    Number.isFinite(dest.lat) &&
    Number.isFinite(dest.lon);

  const effectiveSpeedMps =
    input.speedMps >= 25
      ? input.speedMps
      : input.onGround
        ? 110 // typical initial departure acceleration if about to rotate
        : 130;

  if (hasDest && dest && dest.lat !== null && dest.lon !== null) {
    const destCoord = { lat: dest.lat, lon: dest.lon };
    const distKm = greatCircleKmBetween({ lat: input.lat, lon: input.lon }, destCoord);
    const totalMinutes = Math.max(2, Math.round((distKm * 1000) / Math.max(70, effectiveSpeedMps) / 60));

    // Smooth initial intercept over first leg, then great-circle arrival curve into destination
    const interceptKm = Math.min(distKm * 0.25, (effectiveSpeedMps * 180) / 1000);
    const leadPt =
      interceptKm > 1
        ? advanceGeoPoint(input.lat, input.lon, input.courseDeg, interceptKm * 1000)
        : { lat: input.lat, lon: input.lon };
    const directDestBearing = bearingBetweenDeg(leadPt.lat, leadPt.lon, dest.lat, dest.lon);
    const courseDelta = ((((directDestBearing - input.courseDeg) % 360) + 540) % 360) - 180;

    // If aligned reasonably toward destination (within 110 deg), project to destination corridor
    if (Math.abs(courseDelta) <= 115 || distKm < 120) {
      const steps = distKm > 600 ? [0.1, 0.25, 0.45, 0.7, 0.9, 1] : [0.2, 0.45, 0.75, 1];
      const waypoints: PredictedWaypointMath[] = [];
      let prevPt = { lat: input.lat, lon: input.lon };
      let prevEta = 0;

      for (let i = 0; i < steps.length; i++) {
        const frac = steps[i];
        const pt =
          i === 0 && Math.abs(courseDelta) > 12 && distKm > 40
            ? advanceGeoPoint(
                input.lat,
                input.lon,
                input.courseDeg + Math.sign(courseDelta) * Math.min(25, Math.abs(courseDelta) * 0.5),
                Math.min(distKm * 0.15, (effectiveSpeedMps * 180) / 1000) * 1000,
              )
            : frac >= 1
              ? destCoord
              : interpolateGreatCirclePoint(leadPt.lat, leadPt.lon, dest.lat, dest.lon, frac);

        const segDistKm = greatCircleKmBetween(prevPt, pt);
        const segEta = Math.max(1, Math.round((segDistKm * 1000) / Math.max(65, effectiveSpeedMps) / 60));
        prevEta += segEta;
        prevPt = pt;

        const cruiseTarget = Math.max(input.altM, input.onGround ? 9000 : input.altM);
        const waypointAlt =
          frac >= 0.99
            ? 80
            : frac > 0.78
              ? Math.max(600, Math.round(cruiseTarget * (1 - (frac - 0.78) / 0.22)))
              : Math.round(Math.max(300, Math.min(13_100, input.altM + input.verticalRateMps * Math.min(prevEta * 30, 300))));

        const fl = Math.round((waypointAlt * 3.28084) / 100);
        waypoints.push({
          lat: Number(pt.lat.toFixed(4)),
          lon: Number(pt.lon.toFixed(4)),
          altM: waypointAlt,
          etaMin: prevEta,
          label: frac >= 0.99 ? dest.code || 'DEST' : `FL${String(fl).padStart(3, '0')}`,
        });
      }

      const finalEta = waypoints[waypoints.length - 1]?.etaMin ?? totalMinutes;
      return {
        phase,
        confidence: 'MEDIUM',
        etaMin: finalEta,
        summary: `Routing via heading ${Math.round(input.courseDeg)}° toward ${dest.code || dest.name} (~${Math.round(distKm)} km remaining, ETA ~${finalEta} min).`,
        waypoints,
      };
    }
  }

  // Fallback kinematic horizon (+3, +6, +10, +15, +22 min) using decayed turn rate
  const turnRate = estimateTurnRateDegPerSec(input.recentFixes);
  const intervalsMin = input.onGround ? [2, 5, 10] : [3, 6, 10, 15, 22];
  const waypoints: PredictedWaypointMath[] = [];
  let curLat = input.lat;
  let curLon = input.lon;
  let curAlt = Math.max(input.onGround ? 150 : 50, input.altM);
  let curHeading = input.courseDeg;
  let prevMin = 0;

  for (const targetMin of intervalsMin) {
    const dtMin = targetMin - prevMin;
    const dtSec = dtMin * 60;
    // Exponentially decay turn rate after first 60s so aircraft settles onto new course
    const turnSec = Math.min(dtSec, 60 * Math.exp(-prevMin * 0.25));
    curHeading = ((((curHeading + turnRate * turnSec) % 360) + 360) % 360);
    const step = advanceGeoPoint(curLat, curLon, curHeading, effectiveSpeedMps * dtSec);
    curLat = step.lat;
    curLon = step.lon;
    const altDecay = Math.exp(-targetMin * 0.12);
    curAlt = Math.max(
      120,
      Math.min(13_400, Math.round(curAlt + input.verticalRateMps * dtSec * altDecay)),
    );
    const fl = Math.round((curAlt * 3.28084) / 100);
    waypoints.push({
      lat: Number(curLat.toFixed(4)),
      lon: Number(curLon.toFixed(4)),
      altM: curAlt,
      etaMin: targetMin,
      label: `+${targetMin}m · FL${String(fl).padStart(3, '0')}`,
    });
    prevMin = targetMin;
  }

  return {
    phase,
    confidence: input.recentFixes && input.recentFixes.length >= 3 ? 'MEDIUM' : 'LOW',
    etaMin: null,
    summary: `Kinematic projection along track ${Math.round(input.courseDeg)}° at ${Math.round(effectiveSpeedMps * 1.94384)} kts (no filed route endpoints resolved).`,
    waypoints,
  };
}

/**
 * Validate AI-generated trajectory waypoints against speed/coordinate continuity bounds.
 */
export function validatePredictedWaypoints(
  origin: { lat: number; lon: number; altM: number },
  raw: unknown,
): PredictedWaypointMath[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;

  const validated: PredictedWaypointMath[] = [];
  let prevLat = origin.lat;
  let prevLon = origin.lon;
  let prevEta = 0;

  for (const item of raw.slice(0, 10)) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const lat = Number(row.lat);
    const lon = Number(row.lon);
    const altM = Number(row.altM);
    const etaMin = Number(row.etaMin);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(altM) ||
      !Number.isFinite(etaMin) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      altM < 0 ||
      altM > 20_000 ||
      etaMin <= prevEta ||
      etaMin > 720
    ) {
      return null;
    }

    const segDistM = greatCircleKmBetween({ lat: prevLat, lon: prevLon }, { lat, lon }) * 1000;
    const dtSec = (etaMin - prevEta) * 60;
    const impliedSpeed = segDistM / Math.max(1, dtSec);
    if (impliedSpeed > MAX_PLAUSIBLE_SPEED_MPS) {
      return null;
    }

    validated.push({
      lat: Number(lat.toFixed(4)),
      lon: Number(lon.toFixed(4)),
      altM: Math.round(altM),
      etaMin: Math.round(etaMin),
      label: String(row.label || `+${Math.round(etaMin)}m`).slice(0, 24),
    });

    prevLat = lat;
    prevLon = lon;
    prevEta = etaMin;
  }

  return validated.length >= 2 ? validated : null;
}
