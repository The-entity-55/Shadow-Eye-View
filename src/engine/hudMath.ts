import { forward as toMGRS } from 'mgrs';
import type { VisualStyleId } from '@/types/gev';

export function toMgrsSafe(lat: number, lon: number): string {
  try {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -80 || lat > 84) {
      return 'POLAR GRID';
    }
    return toMGRS([lon, lat], 4);
  } catch {
    return '--';
  }
}

function toDmsPart(val: number, posHem: string, negHem: string, padDeg: number): string {
  const hem = val >= 0 ? posHem : negHem;
  const abs = Math.abs(val);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60);
  const adjSec = sec === 60 ? 0 : sec;
  const adjMin = sec === 60 ? min + 1 : min;
  return `${String(deg).padStart(padDeg, '0')}°${String(adjMin).padStart(2, '0')}'${String(adjSec).padStart(2, '0')}"${hem}`;
}

export function formatDms(lat: number, lon: number): string {
  return `${toDmsPart(lat, 'N', 'S', 2)}  ${toDmsPart(lon, 'E', 'W', 3)}`;
}

export function estimateGsdAndNiirs(altM: number): { gsdText: string } {
  const clamped = Math.max(10, altM);
  const gsdM = clamped * 0.00009;
  const niirs = Math.max(1.0, Math.min(9.0, 9.0 - Math.log10(Math.max(gsdM, 0.05)) * 2.2));
  const gsdFormatted = gsdM < 1 ? `${gsdM.toFixed(2)}M` : gsdM < 100 ? `${gsdM.toFixed(1)}M` : `${Math.round(gsdM)}M`;
  return { gsdText: `GSD ${gsdFormatted}  NIIRS ${niirs.toFixed(1)}` };
}

export function formatAltMsl(altM: number): string {
  if (altM >= 100_000) return `ALT ${Math.round(altM / 1000).toLocaleString()} KM MSL`;
  if (altM >= 1_000) return `ALT ${(altM / 1000).toFixed(1)} KM MSL`;
  return `ALT ${Math.round(altM)} M MSL`;
}

export function classifyRegion(lat: number, lon: number): string {
  if (lat > 66.5) return 'ARCTIC';
  if (lat < -60) return 'ANTARCTIC';
  if (lon >= -170 && lon <= -30 && lat >= 15) return 'NORTH AMERICA';
  if (lon >= -90 && lon <= -30 && lat < 15) return 'SOUTH AMERICA';
  if (lon > -25 && lon <= 45 && lat >= 35) return 'EUROPE';
  if (lon > -20 && lon <= 55 && lat < 35 && lat >= -35) return 'AFRICA';
  if (lon > 45 && lon <= 180 && lat >= 0) return 'ASIA';
  if (lon > 105 && lon <= 180 && lat < 0) return 'OCEANIA';
  return lat >= 0 ? 'NORTHERN OCEANIC GRID' : 'SOUTHERN OCEANIC GRID';
}

export function greatCircleKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function estimateSunElevationDeg(lat: number, lon: number, date: Date): number {
  const utcHours =
    date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const solarHourAngle = ((utcHours + lon / 15 - 12) * 15 * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000);
  const decl = (23.44 * Math.PI) / 180 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear - 81));
  const sinAlt =
    Math.sin(latRad) * Math.sin(decl) +
    Math.cos(latRad) * Math.cos(decl) * Math.cos(solarHourAngle);
  return Math.round((Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180) / Math.PI);
}

export function hudPaletteForStyle(style: VisualStyleId): {
  color: string;
  glow: string;
  border: string;
} {
  switch (style) {
    case 'surveillance':
      return {
        color: 'rgba(51, 255, 51, 0.84)',
        glow: 'rgba(51, 255, 51, 0.45)',
        border: 'rgba(51, 255, 51, 0.24)',
      };
    case 'thermal':
      return {
        color: 'rgba(255, 255, 255, 0.82)',
        glow: 'rgba(255, 255, 255, 0.35)',
        border: 'rgba(255, 255, 255, 0.2)',
      };
    case 'retro':
      return {
        color: 'rgba(255, 178, 36, 0.88)',
        glow: 'rgba(255, 170, 0, 0.45)',
        border: 'rgba(255, 170, 0, 0.24)',
      };
    default:
      return {
        color: 'rgba(0, 232, 255, 0.78)',
        glow: 'rgba(0, 212, 255, 0.4)',
        border: 'rgba(0, 212, 255, 0.2)',
      };
  }
}
