import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite } from '@/lib/server/proxy-utils';
import { getTomTomStatus } from '@/lib/server/tomtom-proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  try {
    const status = await getTomTomStatus();
    return NextResponse.json(status, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { error: 'proxy' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
