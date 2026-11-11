import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  checkSameSite,
  coalesceRequest,
  readResponseTextCapped,
} from '@/lib/server/proxy-utils';

export const dynamic = 'force-dynamic';

const USGS_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const CACHE_MS = 60_000;
const MAX_BYTES = 4 * 1024 * 1024;

export interface EarthquakeRecord {
  id: string;
  lon: number;
  lat: number;
  depthKm: number | null;
  mag: number;
  place: string | null;
  time: number | null;
}

let cached: { at: number; rows: EarthquakeRecord[] } | null = null;
const inFlight = new Map<string, Promise<EarthquakeRecord[] | null>>();

function normalizeUsgs(geojson: { features?: Array<Record<string, unknown>> }): EarthquakeRecord[] | null {
  if (!Array.isArray(geojson?.features)) return null;
  const rows: EarthquakeRecord[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < geojson.features.length; i++) {
    const feat = geojson.features[i] as {
      id?: unknown;
      geometry?: { type?: unknown; coordinates?: unknown };
      properties?: { mag?: unknown; place?: unknown; time?: unknown };
    };
    const coords = feat?.geometry?.coordinates;
    const props = feat?.properties;
    if (!Array.isArray(coords) || coords.length < 2 || !props || typeof props !== 'object') {
      continue;
    }
    const [lon, lat, depthKm] = coords as [number, number, number | undefined];
    const mag = Number(props.mag);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(mag) || mag < 2.5) {
      continue;
    }
    const id = feat.id != null && feat.id !== '' ? String(feat.id) : `eq-${i + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      lon,
      lat,
      depthKm: typeof depthKm === 'number' && Number.isFinite(depthKm) ? depthKm : null,
      mag,
      place: typeof props.place === 'string' ? props.place : null,
      time: typeof props.time === 'number' && Number.isFinite(props.time) ? props.time : null,
    });
  }
  return rows;
}

export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) {
    return NextResponse.json(
      { source: 'USGS', stale: false, rows: cached.rows },
      { headers: { 'X-Cache': 'HIT' } },
    );
  }

  const rows = await coalesceRequest(inFlight, 'earthquakes', async () => {
    try {
      const resp = await fetch(USGS_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        void resp.body?.cancel().catch(() => {});
        return null;
      }
      const text = await readResponseTextCapped(resp, MAX_BYTES);
      const normalized = normalizeUsgs(JSON.parse(text));
      if (!normalized) return null;
      cached = { at: Date.now(), rows: normalized };
      return normalized;
    } catch {
      return null;
    }
  });

  if (rows) {
    return NextResponse.json(
      { source: 'USGS', stale: false, rows },
      { headers: { 'X-Cache': 'MISS' } },
    );
  }

  if (cached) {
    return NextResponse.json(
      { source: 'USGS (Stale)', stale: true, rows: cached.rows },
      { headers: { 'X-Cache': 'STALE' } },
    );
  }

  return NextResponse.json({ error: 'USGS feed unavailable', rows: [] }, { status: 502 });
}
