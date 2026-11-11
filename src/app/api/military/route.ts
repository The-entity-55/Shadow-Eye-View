import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import {
  checkSameSite,
  coalesceRequest,
  readResponseTextCapped,
} from '@/lib/server/proxy-utils';

export const dynamic = 'force-dynamic';

const ADSBLOL_MIL_URL = 'https://api.adsb.lol/v2/mil';
const CACHE_MS = 12_000;
const UPSTREAM_TIMEOUT_MS = 12_000;
const MAX_BYTES = 8 * 1024 * 1024;
const RATE_LIMIT_COOLDOWN_MS = 30_000;
const SERVER_ERROR_COOLDOWN_MS = 15_000;

interface CacheState {
  body: string | null;
  cachedAt: number;
  cooldownUntil: number;
  cooldownStatus: number;
}

const state: CacheState = {
  body: null,
  cachedAt: 0,
  cooldownUntil: 0,
  cooldownStatus: 0,
};

const inFlight = new Map<string, Promise<Response>>();

function clampCooldown(ms: number): number {
  return Math.min(120_000, Math.max(5_000, ms));
}

function cooldownFor(upstream: Response, now: number): number {
  const raw = upstream.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return clampCooldown(seconds * 1000);
    const at = Date.parse(raw);
    if (Number.isFinite(at) && at > now) return clampCooldown(at - now);
  }
  return upstream.status === 429 ? RATE_LIMIT_COOLDOWN_MS : SERVER_ERROR_COOLDOWN_MS;
}

export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const now = Date.now();
  if (state.body && now - state.cachedAt < CACHE_MS) {
    return new NextResponse(state.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'HIT',
        'X-Feed-Source': 'adsb.lol Military',
      },
    });
  }

  if (now < state.cooldownUntil) {
    if (state.body) {
      return new NextResponse(state.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'STALE',
          'X-Feed-Source': 'adsb.lol Military (Cached)',
          'X-Upstream-Status': String(state.cooldownStatus),
        },
      });
    }
    return NextResponse.json(
      { error: `adsb.lol rate limited (${state.cooldownStatus})`, ac: [] },
      { status: state.cooldownStatus || 503 },
    );
  }

  return coalesceRequest(inFlight, 'military', async () => {
    try {
      const upstream = await fetch(ADSBLOL_MIL_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      if (!upstream.ok) {
        if (upstream.status === 429 || upstream.status >= 500) {
          state.cooldownUntil = Date.now() + cooldownFor(upstream, Date.now());
          state.cooldownStatus = upstream.status;
        }
        void upstream.body?.cancel().catch(() => {});
        if (state.body) {
          return new NextResponse(state.body, {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'X-Cache': 'STALE',
              'X-Feed-Source': 'adsb.lol Military (Stale)',
              'X-Upstream-Status': String(upstream.status),
            },
          });
        }
        return NextResponse.json(
          { error: `adsb.lol HTTP ${upstream.status}`, ac: [] },
          { status: upstream.status },
        );
      }

      const text = await readResponseTextCapped(upstream, MAX_BYTES);
      JSON.parse(text);
      state.body = text;
      state.cachedAt = Date.now();
      state.cooldownUntil = 0;

      return new NextResponse(text, {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
          'X-Feed-Source': 'adsb.lol Military',
        },
      });
    } catch (error) {
      if (state.body) {
        return new NextResponse(state.body, {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'STALE',
            'X-Feed-Source': 'adsb.lol Military (Stale)',
          },
        });
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Military feed unavailable', ac: [] },
        { status: 502 },
      );
    }
  });
}
