import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'gods-eye-nextjs',
    timestamp: new Date().toISOString(),
  });
}
