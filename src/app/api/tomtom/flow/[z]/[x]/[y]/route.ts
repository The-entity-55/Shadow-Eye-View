import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite } from '@/lib/server/proxy-utils';
import { getTomTomFlowTile } from '@/lib/server/tomtom-proxy';
import { isValidTileCoord } from '@/engine/tomtomTiles';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ z: string; x: string; y: string }> },
) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const { z: rawZ, x: rawX, y: rawY } = await context.params;
  const cleanY = String(rawY || '').replace(/\.pbf$/i, '');
  const z = Number(rawZ);
  const x = Number(rawX);
  const y = Number(cleanY);

  if (!isValidTileCoord(z, x, y)) {
    return NextResponse.json(
      { error: 'invalid_tile' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    const outcome = await getTomTomFlowTile(z, x, y);
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.error },
        { status: outcome.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const body = new Uint8Array(outcome.buf);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-protobuf',
        'Cache-Control': 'no-store',
        'X-TomTom-Cache': outcome.cacheStatus,
        'X-TomTom-Fetched-At': String(Math.round(outcome.fetchedAt)),
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'proxy' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
