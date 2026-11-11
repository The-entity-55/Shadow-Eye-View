import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite } from '@/lib/server/proxy-utils';
import { getCctvCatalog } from '@/lib/server/cctv-catalog';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const catalog = await getCctvCatalog();
  // Strip raw upstream URLs if desired or expose safe public metadata; keep snapshotUrl omitted
  // from client reliance — client fetches via /api/cctv/frame/:id.
  const publicSources = catalog.sources.map((cam) => ({
    id: cam.id,
    name: cam.name,
    city: cam.city,
    cityId: cam.cityId,
    provider: cam.provider,
    lat: cam.lat,
    lon: cam.lon,
    headingDeg: cam.headingDeg,
    pitchDeg: cam.pitchDeg,
    fovDeg: cam.fovDeg,
    rangeM: cam.rangeM,
    mountHeightM: cam.mountHeightM,
    groundElevationM: cam.groundElevationM,
    feedType: cam.feedType,
    license: cam.license,
  }));

  return NextResponse.json({
    count: publicSources.length,
    sources: publicSources,
  });
}
