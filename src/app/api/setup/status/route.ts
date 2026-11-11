import fs from 'node:fs/promises';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite } from '@/lib/server/proxy-utils';

export const dynamic = 'force-dynamic';

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

async function readLocalEnv(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(process.cwd(), '.env.local'), 'utf8');
    return parseEnvFile(raw);
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  const gate = checkSameSite(req);
  if (gate) return gate;

  const fileEnv = await readLocalEnv();
  const read = (name: string) =>
    (process.env[name] || fileEnv[name] || '').trim();

  const googleApiKey = read('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY') || read('GOOGLE_MAPS_API_KEY');
  const cesiumToken = read('NEXT_PUBLIC_CESIUM_ION_TOKEN') || read('CESIUM_ION_TOKEN');
  const opensky = Boolean(read('OPENSKY_CLIENT_ID') && read('OPENSKY_CLIENT_SECRET'));
  const openai = Boolean(read('OPENAI_API_KEY'));
  const gemini = Boolean(read('GEMINI_API_KEY'));
  const firms = Boolean(read('NASA_FIRMS_KEY'));
  const aisstream = Boolean(read('AISSTREAM_API_KEY'));
  const tomtom = Boolean(read('TOMTOM_API_KEY'));

  return NextResponse.json(
    {
      configured: {
        googleMaps: Boolean(googleApiKey),
        cesiumIon: Boolean(cesiumToken),
        opensky,
        openai,
        gemini,
        firms,
        aisstream,
        tomtom,
      },
      // Client-intended map tokens only; server secrets are never returned.
      clientTokens: {
        googleApiKey,
        cesiumToken,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
