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

const ALLOWED_GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
  'resource',
  'weather',
  'planet',
  'sar',
  'science',
  'active',
]);

const TLE_TTL_MS = 6 * 3600_000;
const MAX_BYTES = 16 * 1024 * 1024;
const CACHE_DIR = path.join(process.cwd(), '.gev-cache');

interface TleEntry {
  at: number;
  body: string;
}

const memoryCache = new Map<string, TleEntry>();
const inFlight = new Map<string, Promise<TleEntry | null>>();
let cooldownUntil = 0;

function diskPath(group: string): string {
  return path.join(CACHE_DIR, `celestrak-${group}.json`);
}

async function readDisk(group: string): Promise<TleEntry | null> {
  try {
    const raw = await fs.readFile(diskPath(group), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TleEntry>;
    if (typeof parsed.body === 'string' && Number.isFinite(parsed.at)) {
      return { at: parsed.at!, body: parsed.body };
    }
  } catch {
    // no disk cache yet
  }
  return null;
}

async function writeDisk(group: string, entry: TleEntry): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(diskPath(group), JSON.stringify(entry), 'utf8');
  } catch {
    // non-fatal
  }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ group: string }> },
) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const { group } = await context.params;
  if (!ALLOWED_GROUPS.has(group)) {
    return NextResponse.json({ error: 'Unknown satellite group' }, { status: 400 });
  }

  const now = Date.now();
  let cached = memoryCache.get(group) || null;
  if (!cached) {
    cached = await readDisk(group);
    if (cached) memoryCache.set(group, cached);
  }

  if (cached && now - cached.at < TLE_TTL_MS) {
    return new NextResponse(cached.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-TLE-Cache': 'HIT',
        'X-TLE-Cached-At': new Date(cached.at).toISOString(),
      },
    });
  }

  if (now < cooldownUntil) {
    if (cached) {
      return new NextResponse(cached.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-TLE-Cache': 'STALE-ERROR',
          'X-TLE-Cached-At': new Date(cached.at).toISOString(),
        },
      });
    }
    return NextResponse.json({ error: 'CelesTrak cooldown active' }, { status: 503 });
  }

  const fresh = await coalesceRequest(inFlight, group, async () => {
    try {
      const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
      const upstream = await fetch(url, {
        headers: { Accept: 'text/plain', 'User-Agent': 'gods-eye-nextjs/0.1' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!upstream.ok) {
        if (upstream.status === 403 || upstream.status === 429) {
          cooldownUntil = Date.now() + 15 * 60_000;
        }
        void upstream.body?.cancel().catch(() => {});
        return null;
      }
      const body = await readResponseTextCapped(upstream, MAX_BYTES);
      if (!/^1 /m.test(body)) {
        return null;
      }
      const entry: TleEntry = { at: Date.now(), body };
      memoryCache.set(group, entry);
      void writeDisk(group, entry);
      return entry;
    } catch {
      return null;
    }
  });

  if (fresh) {
    return new NextResponse(fresh.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-TLE-Cache': 'MISS',
        'X-TLE-Cached-At': new Date(fresh.at).toISOString(),
      },
    });
  }

  if (cached) {
    return new NextResponse(cached.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-TLE-Cache': 'STALE-ERROR',
        'X-TLE-Cached-At': new Date(cached.at).toISOString(),
      },
    });
  }

  return NextResponse.json({ error: 'CelesTrak TLE fetch failed' }, { status: 502 });
}
