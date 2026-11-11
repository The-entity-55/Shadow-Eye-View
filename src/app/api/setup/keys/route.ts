import fs from 'node:fs/promises';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { checkSameSite } from '@/lib/server/proxy-utils';
import { getAisManager } from '@/lib/server/ais-stream';

export const dynamic = 'force-dynamic';

const ALLOWED_KEYS = new Set([
  'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY',
  'NEXT_PUBLIC_CESIUM_ION_TOKEN',
  'GOOGLE_MAPS_API_KEY',
  'CESIUM_ION_TOKEN',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
  'NASA_FIRMS_KEY',
  'AISSTREAM_API_KEY',
  'TOMTOM_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
]);

function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n]/g, '').trim();
}

export async function POST(req: NextRequest) {
  const gate = checkSameSite(req, { allowProxied: false });
  if (gate) return gate;

  let body: { keys?: Record<string, string> };
  try {
    body = (await req.json()) as { keys?: Record<string, string> };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body?.keys || typeof body.keys !== 'object') {
    return NextResponse.json({ error: 'Missing keys object' }, { status: 400 });
  }

  const envPath = path.join(process.cwd(), '.env.local');
  let existingLines: string[] = [];
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    existingLines = raw.split(/\r?\n/);
  } catch {
    // new .env.local
  }

  const updates = new Map<string, string>();
  for (const [key, rawVal] of Object.entries(body.keys)) {
    if (!ALLOWED_KEYS.has(key) || typeof rawVal !== 'string') continue;
    const val = sanitizeEnvValue(rawVal);
    updates.set(key, val);
    // Keep server process env warm during dev
    if (val) {
      process.env[key] = val;
    } else {
      delete process.env[key];
    }
    // Mirror browser keys to NEXT_PUBLIC_* as well
    if (key === 'GOOGLE_MAPS_API_KEY') {
      updates.set('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', val);
      if (val) process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = val;
      else delete process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    }
    if (key === 'CESIUM_ION_TOKEN') {
      updates.set('NEXT_PUBLIC_CESIUM_ION_TOKEN', val);
      if (val) process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN = val;
      else delete process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN;
    }
  }

  const seen = new Set<string>();
  const nextLines = existingLines
    .filter((line, idx) => idx < existingLines.length - 1 || line.trim() !== '')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return line;
      const k = trimmed.slice(0, eq).trim();
      if (updates.has(k)) {
        seen.add(k);
        const v = updates.get(k)!;
        return v ? `${k}=${v}` : '';
      }
      return line;
    })
    .filter((line) => line !== '');

  for (const [k, v] of updates.entries()) {
    if (!seen.has(k) && v) {
      nextLines.push(`${k}=${v}`);
    }
  }

  await fs.writeFile(envPath, nextLines.join('\n') + (nextLines.length ? '\n' : ''), {
    encoding: 'utf8',
    mode: 0o600,
  });

  if (updates.has('AISSTREAM_API_KEY')) {
    getAisManager().notifyKeyChanged();
  }

  return NextResponse.json(
    { ok: true, saved: [...updates.keys()] },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
