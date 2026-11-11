import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite, readResponseBytesCapped } from '@/lib/server/proxy-utils';
import { getCctvCatalog } from '@/lib/server/cctv-catalog';

export const dynamic = 'force-dynamic';

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const frameCache = new Map<string, { at: number; contentType: string; bytes: Uint8Array }>();

function buildFallbackSvg(cameraName: string, status: string): string {
  const safeName = cameraName.replace(/[<>&"']/g, '');
  const safeStatus = status.replace(/[<>&"']/g, '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#091018"/>
  <path d="M0 90H640M0 180H640M0 270H640M160 0V360M320 0V360M480 0V360" stroke="#00d4ff" stroke-opacity="0.12"/>
  <rect x="24" y="24" width="592" height="312" fill="none" stroke="#00d4ff" stroke-opacity="0.4"/>
  <text x="44" y="64" fill="#00d4ff" font-family="monospace" font-size="14" letter-spacing="2">CCTV TELEMETRY · OFFLINE / STANDBY</text>
  <text x="44" y="184" fill="#e8eaed" font-family="monospace" font-size="18">${safeName}</text>
  <text x="44" y="214" fill="#9fb2c3" font-family="monospace" font-size="13">${safeStatus}</text>
</svg>`;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const { id } = await context.params;
  const catalog = await getCctvCatalog();
  const camera = catalog.byId.get(id);
  if (!camera) {
    return NextResponse.json({ error: 'Camera not found' }, { status: 404 });
  }

  const cached = frameCache.get(id);
  if (cached && Date.now() - cached.at < 15_000) {
    return new NextResponse(Buffer.from(cached.bytes), {
      status: 200,
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': 'no-store',
        'X-Frame-Cache': 'HIT',
      },
    });
  }

  try {
    const upstream = await fetch(camera.snapshotUrl, {
      headers: { Accept: 'image/*,*/*;q=0.8', 'User-Agent': 'gods-eye-nextjs/0.1' },
      signal: AbortSignal.timeout(8_000),
    });

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    if (!upstream.ok || !contentType.startsWith('image/')) {
      void upstream.body?.cancel().catch(() => {});
      return new NextResponse(
        buildFallbackSvg(camera.name, `Upstream returned HTTP ${upstream.status}`),
        {
          status: 200,
          headers: {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Frame-Fallback': 'true',
          },
        },
      );
    }

    const bytes = await readResponseBytesCapped(upstream, MAX_FRAME_BYTES);
    frameCache.set(id, { at: Date.now(), contentType, bytes });
    if (frameCache.size > 128) {
      const oldest = frameCache.keys().next().value;
      if (oldest) frameCache.delete(oldest);
    }

    return new NextResponse(Buffer.from(bytes), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'X-Frame-Cache': 'MISS',
      },
    });
  } catch (err) {
    return new NextResponse(
      buildFallbackSvg(
        camera.name,
        err instanceof Error ? err.message : 'Camera stream timeout',
      ),
      {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Fallback': 'true',
        },
      },
    );
  }
}
