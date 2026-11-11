import fs from 'node:fs/promises';
import path from 'node:path';

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

/**
 * Read a server-side secret/env var from process.env or .env.local/.env.
 */
export async function readServerSecret(name: string): Promise<string> {
  const direct = (process.env[name] || '').trim();
  if (direct) return direct;

  for (const fileName of ['.env.local', '.env']) {
    try {
      const raw = await fs.readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), fileName), 'utf8');
      const parsed = parseEnvFile(raw);
      const val = (parsed[name] || '').trim();
      if (val) return val;
    } catch {
      // Optional env file not present
    }
  }
  return '';
}
