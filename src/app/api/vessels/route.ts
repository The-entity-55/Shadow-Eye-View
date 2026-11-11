import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite } from '@/lib/server/proxy-utils';
import { AISSTREAM_CACHE_MAX, getAisManager } from '@/lib/server/ais-stream';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  try {
    const manager = getAisManager();
    manager.ensure();

    const { searchParams } = new URL(req.url);
    const rawMax = Number(searchParams.get('maxRows') ?? 12000);
    const maxRows = Number.isFinite(rawMax)
      ? Math.max(1, Math.min(AISSTREAM_CACHE_MAX, Math.round(rawMax)))
      : 12000;

    const rows = manager.getRows(maxRows);
    const feed = manager.getSnapshot();

    return NextResponse.json(
      {
        rows,
        source: 'AISStream',
        status: feed.status,
        error: feed.error,
        refreshing: feed.status !== 'live',
        newestPositionAt: rows[0]?.last_position_UTC || null,
        lastMessageAt: feed.lastMessageAt,
        silentForMs: feed.silentForMs,
        reconnectAttempt: feed.reconnectAttempt,
        nextAttemptAt: feed.nextAttemptAt,
        staleAfterMs: feed.staleAfterMs,
      },
      {
        status: feed.hasKey ? 200 : 503,
        headers: {
          'Cache-Control': 'no-store',
          'X-Feed-Source': 'AISStream',
        },
      },
    );
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : 'AIS live stream error',
        rows: [],
      },
      {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      },
    );
  }
}
