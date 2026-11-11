import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite, readResponseTextCapped } from '@/lib/server/proxy-utils';
import { getOpenSkyAuthHeaders } from '@/lib/server/opensky-auth';

export const dynamic = 'force-dynamic';

const TRACK_CACHE_MS = 60_000;
const TRACK_CACHE_MAX = 200;
const RESPONSE_CAP_BYTES = 5 * 1024 * 1024;

interface TrackCacheEntry {
  at: number;
  status: number;
  body: string;
}

const trackCache = new Map<string, TrackCacheEntry>();

function cachePut(key: string, entry: TrackCacheEntry) {
  trackCache.set(key, entry);
  if (trackCache.size > TRACK_CACHE_MAX) {
    const oldest = [...trackCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) trackCache.delete(oldest[0]);
  }
}

/**
 * OpenSky track-history backfill proxy modeled on upstream server/providers/aircraft/tracks.js.
 * GET /api/flights/track?icao24=<hex6>
 */
export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const { searchParams } = new URL(req.url);
  const icao24 = String(searchParams.get('icao24') || '').trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(icao24)) {
    return NextResponse.json(
      { error: 'icao24 must be a 6-char hex string' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const cacheKey = `osky:${icao24}`;
  const cached = trackCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRACK_CACHE_MS) {
    return new NextResponse(cached.body, {
      status: cached.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Track-Cache': 'HIT',
      },
    });
  }

  try {
    const headers = await getOpenSkyAuthHeaders();
    const upstream = await fetch(
      `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`,
      {
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(12_000),
      },
    );

    let status = upstream.status;
    let body: string;

    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      body = JSON.stringify({ error: `Track source HTTP ${upstream.status}` });
    } else {
      try {
        body = await readResponseTextCapped(upstream, RESPONSE_CAP_BYTES);
      } catch {
        status = 502;
        body = JSON.stringify({ error: 'Upstream track response too large' });
      }
    }

    // Cache non-ok status codes too so repeated clicks inside 60s don't re-spend OpenSky credits.
    cachePut(cacheKey, { at: Date.now(), status, body });

    return new NextResponse(body, {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Track-Cache': 'MISS',
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'OpenSky track fetch failed' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
