import fs from 'node:fs/promises';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  checkSameSite,
  coalesceRequest,
  readResponseTextCapped,
} from '@/lib/server/proxy-utils';

export const dynamic = 'force-dynamic';

const TTL_MS = 24 * 3600_000;
const ADSBDB_MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_PATH = path.join(process.cwd(), '.gev-cache', 'adsbdb.json');

interface RouteAirport {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
}

export interface AdsbdbRouteData {
  airline: string | null;
  origin: RouteAirport;
  destination: RouteAirport;
}

export interface AdsbdbAircraftData {
  typeCode: string | null;
  typeName: string | null;
  registration: string | null;
}

interface CacheEntry<T> {
  at: number;
  data: T | null;
}

const memCache: {
  routes: Record<string, CacheEntry<AdsbdbRouteData>>;
  aircraft: Record<string, CacheEntry<AdsbdbAircraftData>>;
} = {
  routes: {},
  aircraft: {},
};

let cacheLoaded = false;
let diskDirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const inflight = new Map<string, Promise<unknown>>();

async function loadDiskCacheOnce() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<typeof memCache>;
    if (parsed.routes && typeof parsed.routes === 'object') {
      memCache.routes = parsed.routes;
    }
    if (parsed.aircraft && typeof parsed.aircraft === 'object') {
      memCache.aircraft = parsed.aircraft;
    }
  } catch {
    // First run without disk cache
  }
}

function scheduleDiskFlush() {
  diskDirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    if (!diskDirty) return;
    diskDirty = false;
    try {
      await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
      await fs.writeFile(CACHE_PATH, JSON.stringify(memCache), 'utf8');
    } catch {
      diskDirty = true;
    }
  }, 15_000);
  flushTimer.unref?.();
}

function isFresh<T>(entry: CacheEntry<T> | undefined): entry is CacheEntry<T> {
  return Boolean(entry && Date.now() - entry.at < TTL_MS);
}

function parseRoute(json: Record<string, unknown>): AdsbdbRouteData | null {
  const response = json?.response as Record<string, unknown> | undefined;
  const fr = response?.flightroute as Record<string, unknown> | undefined;
  const originRaw = fr?.origin as Record<string, unknown> | undefined;
  const destRaw = fr?.destination as Record<string, unknown> | undefined;
  if (!originRaw || !destRaw) return null;

  const parseAirport = (a: Record<string, unknown>): RouteAirport => ({
    code: String(a.iata_code || a.icao_code || '').trim(),
    name: String(a.municipality || a.name || '').trim(),
    lat: typeof a.latitude === 'number' && Number.isFinite(a.latitude) ? a.latitude : null,
    lon: typeof a.longitude === 'number' && Number.isFinite(a.longitude) ? a.longitude : null,
  });

  const airlineObj = fr?.airline as Record<string, unknown> | undefined;
  return {
    airline: airlineObj?.name ? String(airlineObj.name) : null,
    origin: parseAirport(originRaw),
    destination: parseAirport(destRaw),
  };
}

function parseAircraft(json: Record<string, unknown>): AdsbdbAircraftData | null {
  const response = json?.response as Record<string, unknown> | undefined;
  const a = response?.aircraft as Record<string, unknown> | undefined;
  if (!a) return null;
  const manufacturer = a.manufacturer ? String(a.manufacturer) : '';
  const type = a.type ? String(a.type) : '';
  return {
    typeCode: a.icao_type ? String(a.icao_type) : null,
    typeName: manufacturer && type ? `${manufacturer} ${type}` : type || null,
    registration: a.registration ? String(a.registration) : null,
  };
}

async function lookupAdsbdb<T>(
  kind: 'route' | 'type',
  key: string,
  parser: (json: Record<string, unknown>) => T | null,
): Promise<T | null> {
  await loadDiskCacheOnce();
  const store = (kind === 'route' ? memCache.routes : memCache.aircraft) as Record<
    string,
    CacheEntry<T>
  >;
  if (isFresh(store[key])) return store[key].data;

  const flightKey = `${kind}:${key}`;
  return coalesceRequest(inflight as Map<string, Promise<T | null>>, flightKey, async () => {
    try {
      const url =
        kind === 'route'
          ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
          : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
      const upstream = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (upstream.ok) {
        const text = await readResponseTextCapped(upstream, ADSBDB_MAX_RESPONSE_BYTES);
        const payload = JSON.parse(text) as Record<string, unknown>;
        const data = parser(payload);
        store[key] = { at: Date.now(), data };
        scheduleDiskFlush();
        return data;
      }
      if (upstream.status === 404) {
        store[key] = { at: Date.now(), data: null };
        scheduleDiskFlush();
      } else {
        void upstream.body?.cancel().catch(() => {});
      }
      return isFresh(store[key]) ? store[key].data : null;
    } catch {
      return isFresh(store[key]) ? store[key].data : null;
    }
  });
}

/**
 * adsbdb.com enrichment proxy modeled on upstream server/providers/aircraft/enrichment.js:
 * - GET /api/adsbdb/route/<callsign>
 * - GET /api/adsbdb/type/<hex6>
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ kind: string; key: string }> },
) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const { kind, key } = await context.params;

  if (kind === 'route') {
    const cs = String(key || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(cs)) {
      return NextResponse.json({ error: 'invalid callsign' }, { status: 400 });
    }
    const data = await lookupAdsbdb('route', cs, parseRoute);
    return NextResponse.json(data ? { found: true, ...data } : { found: false });
  }

  if (kind === 'type') {
    const hex = String(key || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) {
      return NextResponse.json({ error: 'invalid hex' }, { status: 400 });
    }
    const data = await lookupAdsbdb('type', hex, parseAircraft);
    return NextResponse.json(data ? { found: true, ...data } : { found: false });
  }

  return NextResponse.json({ error: 'unknown endpoint' }, { status: 404 });
}
