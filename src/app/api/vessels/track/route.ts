import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite } from '@/lib/server/proxy-utils';
import { AISSTREAM_STALE_MS, getAisManager } from '@/lib/server/ais-stream';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const manager = getAisManager();
  manager.ensure();

  const { searchParams } = new URL(req.url);
  const mmsi = String(searchParams.get('mmsi') || '').trim();
  if (!/^\d{5,10}$/.test(mmsi)) {
    return NextResponse.json(
      { error: 'Valid mmsi query param required', samples: [] },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return NextResponse.json(
    {
      mmsi,
      samples: manager.getTrack(mmsi),
      source: 'AISStream (accumulated since server start)',
      retainedSec: Math.floor(AISSTREAM_STALE_MS / 1000),
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
