import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  checkSameSite,
  coalesceRequest,
  readResponseTextCapped,
} from '@/lib/server/proxy-utils';
import { getOpenSkyAuthHeaders } from '@/lib/server/opensky-auth';

export const dynamic = 'force-dynamic';

const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all?extended=1';
const CACHE_MS = 10_000;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 8 * 1024 * 1024;
const KNOT_TO_MPS = 0.514444;
const FOOT_TO_M = 0.3048;
const FPM_TO_MPS = 0.00508;

const openSkyState = {
  body: null as string | null,
  cachedAt: 0,
  cooldownUntil: 0,
  cooldownStatus: 0,
};

const regionalCache = new Map<string, { body: string; at: number }>();
const inFlight = new Map<string, Promise<Response>>();

function finiteNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const EMITTER_CATS: Record<string, number> = {
  A1: 2,
  A2: 3,
  A3: 4,
  A4: 5,
  A5: 6,
  A6: 7,
  A7: 8,
  B1: 9,
  B2: 10,
  B3: 11,
  B4: 12,
  B6: 14,
  B7: 15,
};

/**
 * Convert adsb.lol v2 point response into OpenSky state-vector array format.
 */
function normalizeAdsbLolPoint(payload: { now?: unknown; ac?: Array<Record<string, unknown>> }) {
  const nowSec = finiteNumber(payload?.now) ?? Math.floor(Date.now() / 1000);
  const ac = Array.isArray(payload?.ac) ? payload.ac : [];
  const states: unknown[][] = [];

  for (const row of ac) {
    const hex = String(row?.hex || '').trim().toLowerCase();
    const lat = finiteNumber(row?.lat);
    const lon = finiteNumber(row?.lon);
    if (!hex || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      continue;
    }
    const seenPos = Math.max(0, finiteNumber(row?.seen_pos) ?? finiteNumber(row?.seen) ?? 0);
    const seen = Math.max(0, finiteNumber(row?.seen) ?? seenPos);
    const onGround = row?.alt_baro === 'ground';
    const baroFt = onGround ? null : finiteNumber(row?.alt_baro);
    const geomFt = finiteNumber(row?.alt_geom);
    const gsKt = finiteNumber(row?.gs);
    const vrateFpm = finiteNumber(row?.baro_rate) ?? finiteNumber(row?.geom_rate);
    const track = finiteNumber(row?.track);
    const cat = String(row?.category || '').trim().toUpperCase();

    states.push([
      hex,
      String(row?.flight || row?.r || '').trim() || null,
      null,
      Math.max(0, nowSec - seenPos),
      Math.max(0, nowSec - seen),
      lon,
      lat,
      baroFt === null ? null : baroFt * FOOT_TO_M,
      onGround,
      gsKt === null ? null : gsKt * KNOT_TO_MPS,
      track,
      vrateFpm === null ? null : vrateFpm * FPM_TO_MPS,
      null,
      geomFt === null ? null : geomFt * FOOT_TO_M,
      row?.squawk || null,
      row?.spi === 1,
      0,
      EMITTER_CATS[cat] || 0,
    ]);
  }

  return { time: Math.floor(nowSec), states };
}

async function fetchAdsbLolRegional(lat: number, lon: number): Promise<Response | null> {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const now = Date.now();
  const cached = regionalCache.get(key);
  if (cached && now - cached.at < CACHE_MS) {
    return new NextResponse(cached.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Feed-Source': 'adsb.lol Regional (Cached)',
        'X-Flight-Coverage': '250 NM around camera',
      },
    });
  }

  try {
    const url = `https://api.adsb.lol/v2/point/${lat.toFixed(4)}/${lon.toFixed(4)}/250`;
    const upstream = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readResponseTextCapped(upstream, MAX_BYTES);
    const parsed = JSON.parse(text);
    const normalized = JSON.stringify(normalizeAdsbLolPoint(parsed));
    regionalCache.set(key, { body: normalized, at: Date.now() });
    if (regionalCache.size > 64) {
      const oldest = regionalCache.keys().next().value;
      if (oldest) regionalCache.delete(oldest);
    }
    return new NextResponse(normalized, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Feed-Source': 'adsb.lol Regional',
        'X-Flight-Coverage': '250 NM around camera',
      },
    });
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get('lat') ?? 30.2672);
  const lon = Number(searchParams.get('lon') ?? -97.7431);
  const safeLat = Number.isFinite(lat) ? Math.max(-90, Math.min(90, lat)) : 30.2672;
  const safeLon = Number.isFinite(lon) ? Math.max(-180, Math.min(180, lon)) : -97.7431;

  const now = Date.now();
  if (openSkyState.body && now - openSkyState.cachedAt < CACHE_MS) {
    return new NextResponse(openSkyState.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'HIT',
        'X-Feed-Source': 'OpenSky Network',
        'X-Flight-Coverage': 'global',
      },
    });
  }

  return coalesceRequest(inFlight, `flights:${safeLat.toFixed(1)}:${safeLon.toFixed(1)}`, async () => {
    if (Date.now() >= openSkyState.cooldownUntil) {
      try {
        const headers = await getOpenSkyAuthHeaders();
        const upstream = await fetch(OPENSKY_STATES_URL, {
          headers: { Accept: 'application/json', ...headers },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (upstream.ok) {
          const text = await readResponseTextCapped(upstream, MAX_BYTES);
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed?.states)) {
            openSkyState.body = text;
            openSkyState.cachedAt = Date.now();
            openSkyState.cooldownUntil = 0;
            return new NextResponse(text, {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'X-Cache': 'MISS',
                'X-Feed-Source': Object.keys(headers).length
                  ? 'OpenSky Network (OAuth)'
                  : 'OpenSky Network',
                'X-Flight-Coverage': 'global',
              },
            });
          }
        } else {
          if (upstream.status === 429 || upstream.status >= 500) {
            const retrySec = Number(upstream.headers.get('x-rate-limit-retry-after-seconds'));
            const cd = Number.isFinite(retrySec) && retrySec > 0 ? retrySec * 1000 : 120_000;
            openSkyState.cooldownUntil = Date.now() + Math.min(1_800_000, Math.max(30_000, cd));
            openSkyState.cooldownStatus = upstream.status;
          }
          void upstream.body?.cancel().catch(() => {});
        }
      } catch {
        // Fall through to stale cache or regional adsb.lol fallback
      }
    }

    if (openSkyState.body && Date.now() - openSkyState.cachedAt < 120_000) {
      return new NextResponse(openSkyState.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'STALE',
          'X-Feed-Source': 'OpenSky Network (Stale)',
          'X-Flight-Coverage': 'global',
        },
      });
    }

    const regional = await fetchAdsbLolRegional(safeLat, safeLon);
    if (regional) return regional;

    return NextResponse.json(
      { error: 'Flight feeds temporarily unavailable', time: Math.floor(Date.now() / 1000), states: [] },
      { status: 503 },
    );
  });
}
