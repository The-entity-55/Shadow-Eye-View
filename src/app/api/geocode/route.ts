import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite, readResponseTextCapped } from '@/lib/server/proxy-utils';

export const dynamic = 'force-dynamic';

const cache = new Map<string, { at: number; data: unknown }>();
const CACHE_TTL_MS = 24 * 3600_000;
let nextAllowedAt = 0;
let queue: Promise<void> = Promise.resolve();

function enqueueNominatim<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = Math.max(0, nextAllowedAt - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAllowedAt = Date.now() + 1100;
    return fn();
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const lat = searchParams.get('lat');
  const lon = searchParams.get('lon');

  let targetUrl: string;
  let cacheKey: string;

  if (q) {
    if (q.length > 200) {
      return NextResponse.json({ error: 'Query too long' }, { status: 400 });
    }
    cacheKey = `search:${q.toLowerCase()}`;
    targetUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&q=${encodeURIComponent(q)}`;
  } else if (lat !== null && lon !== null) {
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum) || Math.abs(latNum) > 90 || Math.abs(lonNum) > 180) {
      return NextResponse.json({ error: 'Invalid coordinates' }, { status: 400 });
    }
    cacheKey = `rev:${latNum.toFixed(3)},${lonNum.toFixed(3)}`;
    targetUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${latNum.toFixed(5)}&lon=${lonNum.toFixed(5)}`;
  } else {
    return NextResponse.json({ error: 'Provide q or lat/lon' }, { status: 400 });
  }

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.data, { headers: { 'X-Cache': 'HIT' } });
  }

  try {
    const data = await enqueueNominatim(async () => {
      const resp = await fetch(targetUrl, {
        headers: {
          Accept: 'application/json',
          'User-Agent': "GodsEyeViewNextJS/0.1 (local development geocode proxy)",
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) {
        void resp.body?.cancel().catch(() => {});
        throw new Error(`Nominatim HTTP ${resp.status}`);
      }
      const text = await readResponseTextCapped(resp, 512 * 1024);
      return JSON.parse(text);
    });

    cache.set(cacheKey, { at: Date.now(), data });
    if (cache.size > 256) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }

    return NextResponse.json(data, { headers: { 'X-Cache': 'MISS' } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Geocoder unavailable' },
      { status: 502 },
    );
  }
}
