import fs from 'node:fs/promises';
import path from 'node:path';
import { readServerSecret } from './env-config';
import { readResponseBytesCapped } from './proxy-utils';
import {
  isOverBudget,
  normalizeBudget,
  utcDayKey,
  type DailyBudgetState,
} from '@/engine/tomtomTiles';

const TILE_TTL_MS = 120_000;
const DEFAULT_DAILY_BUDGET = 6_000;
const MEM_MAX_ENTRIES = 256;
const UPSTREAM_TIMEOUT_MS = 15_000;
const TOMTOM_TILE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const CACHE_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), '.gev-cache', 'tomtom');
const BUDGET_PATH = path.join(/*turbopackIgnore: true*/ CACHE_DIR, 'budget.json');

interface CachedTileEntry {
  at: number;
  buf: Uint8Array;
}

export type TileFetchOutcome =
  | { ok: true; buf: Uint8Array; cacheStatus: 'HIT' | 'MISS' | 'STALE-BUDGET' | 'STALE-ERROR'; fetchedAt: number }
  | { ok: false; status: 503 | 429 | 502; error: 'no_key' | 'budget' | 'upstream' };

const mem = new Map<string, CachedTileEntry>();
const inflight = new Map<string, Promise<CachedTileEntry | null>>();
let budget: DailyBudgetState | null = null;
let budgetLoaded = false;

function dailyBudgetLimit(): number {
  const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}

async function loadBudgetOnce() {
  if (budgetLoaded) return;
  budgetLoaded = true;
  try {
    const parsed = JSON.parse(await fs.readFile(BUDGET_PATH, 'utf8')) as Partial<DailyBudgetState>;
    if (parsed && typeof parsed.date === 'string' && typeof parsed.count === 'number') {
      budget = { date: parsed.date, count: parsed.count };
    }
  } catch {
    // No persisted budget file yet
  }
}

async function persistBudget() {
  if (!budget) return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(BUDGET_PATH, JSON.stringify(budget), 'utf8');
  } catch {
    // Non-fatal persistence failure
  }
}

function currentBudget(): DailyBudgetState {
  budget = normalizeBudget(budget, utcDayKey());
  return budget;
}

function recordUpstreamFetch() {
  currentBudget().count += 1;
  void persistBudget();
}

function tileDiskPath(key: string): string {
  return path.join(/*turbopackIgnore: true*/ CACHE_DIR, `flow-${key.replaceAll('/', '-')}.pbf`);
}

async function readDiskTile(key: string): Promise<CachedTileEntry | null> {
  try {
    const filePath = tileDiskPath(key);
    const [stat, fileBuf] = await Promise.all([fs.stat(filePath), fs.readFile(filePath)]);
    return {
      at: stat.mtimeMs,
      buf: new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength),
    };
  } catch {
    return null;
  }
}

async function writeDiskTile(key: string, buf: Uint8Array) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(tileDiskPath(key), buf);
  } catch {
    // Ignore cache write error
  }
}

function memSet(key: string, entry: CachedTileEntry) {
  if (!mem.has(key) && mem.size >= MEM_MAX_ENTRIES) {
    const oldest = mem.keys().next().value;
    if (oldest) mem.delete(oldest);
  }
  mem.set(key, entry);
}

async function fetchUpstreamTile(z: number, x: number, y: number, apiKey: string): Promise<Uint8Array> {
  const url =
    'https://api.tomtom.com/traffic/map/4/tile/flow/relative/' +
    `${z}/${x}/${y}.pbf?key=${encodeURIComponent(apiKey)}`;
  recordUpstreamFetch();
  const upstream = await fetch(url, {
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${upstream.status}`);
  }
  const bytes = await readResponseBytesCapped(upstream, TOMTOM_TILE_MAX_RESPONSE_BYTES);
  if (bytes.byteLength === 0) throw new Error('empty tile body');
  return bytes;
}

export async function getTomTomStatus() {
  await loadBudgetOnce();
  const apiKey = await readServerSecret('TOMTOM_API_KEY');
  const b = currentBudget();
  return {
    hasKey: Boolean(apiKey),
    dailyCount: b.count,
    budget: dailyBudgetLimit(),
    date: b.date,
  };
}

export async function getTomTomFlowTile(z: number, x: number, y: number): Promise<TileFetchOutcome> {
  await loadBudgetOnce();
  const apiKey = await readServerSecret('TOMTOM_API_KEY');
  if (!apiKey) {
    return { ok: false, status: 503, error: 'no_key' };
  }

  const key = `${z}/${x}/${y}`;
  const now = Date.now();
  let entry = mem.get(key) || null;
  if (!entry) {
    entry = await readDiskTile(key);
    if (entry) memSet(key, entry);
  }

  if (entry && now - entry.at < TILE_TTL_MS) {
    return { ok: true, buf: entry.buf, cacheStatus: 'HIT', fetchedAt: entry.at };
  }

  if (isOverBudget(currentBudget(), dailyBudgetLimit())) {
    if (entry) {
      return { ok: true, buf: entry.buf, cacheStatus: 'STALE-BUDGET', fetchedAt: entry.at };
    }
    return { ok: false, status: 429, error: 'budget' };
  }

  if (!inflight.has(key)) {
    const loader = fetchUpstreamTile(z, x, y, apiKey)
      .then(async (buf) => {
        const fresh: CachedTileEntry = { at: Date.now(), buf };
        memSet(key, fresh);
        await writeDiskTile(key, buf);
        return fresh;
      })
      .catch(() => null)
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, loader);
  }

  const fresh = await inflight.get(key);
  if (fresh) {
    return { ok: true, buf: fresh.buf, cacheStatus: 'MISS', fetchedAt: fresh.at };
  }
  if (entry) {
    return { ok: true, buf: entry.buf, cacheStatus: 'STALE-ERROR', fetchedAt: entry.at };
  }
  return { ok: false, status: 502, error: 'upstream' };
}
