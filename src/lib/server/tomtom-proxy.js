"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTomTomStatus = getTomTomStatus;
exports.getTomTomFlowTile = getTomTomFlowTile;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const env_config_1 = require("./env-config");
const proxy_utils_1 = require("./proxy-utils");
const tomtomTiles_1 = require("@/engine/tomtomTiles");
const TILE_TTL_MS = 120_000;
const DEFAULT_DAILY_BUDGET = 6_000;
const MEM_MAX_ENTRIES = 256;
const UPSTREAM_TIMEOUT_MS = 15_000;
const TOMTOM_TILE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const CACHE_DIR = node_path_1.default.join(/*turbopackIgnore: true*/ process.cwd(), '.gev-cache', 'tomtom');
const BUDGET_PATH = node_path_1.default.join(/*turbopackIgnore: true*/ CACHE_DIR, 'budget.json');
const mem = new Map();
const inflight = new Map();
let budget = null;
let budgetLoaded = false;
function dailyBudgetLimit() {
    const raw = Number.parseInt(process.env.TOMTOM_DAILY_TILE_BUDGET || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_BUDGET;
}
async function loadBudgetOnce() {
    if (budgetLoaded)
        return;
    budgetLoaded = true;
    try {
        const parsed = JSON.parse(await promises_1.default.readFile(BUDGET_PATH, 'utf8'));
        if (parsed && typeof parsed.date === 'string' && typeof parsed.count === 'number') {
            budget = { date: parsed.date, count: parsed.count };
        }
    }
    catch {
        // No persisted budget file yet
    }
}
async function persistBudget() {
    if (!budget)
        return;
    try {
        await promises_1.default.mkdir(CACHE_DIR, { recursive: true });
        await promises_1.default.writeFile(BUDGET_PATH, JSON.stringify(budget), 'utf8');
    }
    catch {
        // Non-fatal persistence failure
    }
}
function currentBudget() {
    budget = (0, tomtomTiles_1.normalizeBudget)(budget, (0, tomtomTiles_1.utcDayKey)());
    return budget;
}
function recordUpstreamFetch() {
    currentBudget().count += 1;
    void persistBudget();
}
function tileDiskPath(key) {
    return node_path_1.default.join(/*turbopackIgnore: true*/ CACHE_DIR, `flow-${key.replaceAll('/', '-')}.pbf`);
}
async function readDiskTile(key) {
    try {
        const filePath = tileDiskPath(key);
        const [stat, fileBuf] = await Promise.all([promises_1.default.stat(filePath), promises_1.default.readFile(filePath)]);
        return {
            at: stat.mtimeMs,
            buf: new Uint8Array(fileBuf.buffer, fileBuf.byteOffset, fileBuf.byteLength),
        };
    }
    catch {
        return null;
    }
}
async function writeDiskTile(key, buf) {
    try {
        await promises_1.default.mkdir(CACHE_DIR, { recursive: true });
        await promises_1.default.writeFile(tileDiskPath(key), buf);
    }
    catch {
        // Ignore cache write error
    }
}
function memSet(key, entry) {
    if (!mem.has(key) && mem.size >= MEM_MAX_ENTRIES) {
        const oldest = mem.keys().next().value;
        if (oldest)
            mem.delete(oldest);
    }
    mem.set(key, entry);
}
async function fetchUpstreamTile(z, x, y, apiKey) {
    const url = 'https://api.tomtom.com/traffic/map/4/tile/flow/relative/' +
        `${z}/${x}/${y}.pbf?key=${encodeURIComponent(apiKey)}`;
    recordUpstreamFetch();
    const upstream = await fetch(url, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) {
        void upstream.body?.cancel().catch(() => { });
        throw new Error(`HTTP ${upstream.status}`);
    }
    const bytes = await (0, proxy_utils_1.readResponseBytesCapped)(upstream, TOMTOM_TILE_MAX_RESPONSE_BYTES);
    if (bytes.byteLength === 0)
        throw new Error('empty tile body');
    return bytes;
}
async function getTomTomStatus() {
    await loadBudgetOnce();
    const apiKey = await (0, env_config_1.readServerSecret)('TOMTOM_API_KEY');
    const b = currentBudget();
    return {
        hasKey: Boolean(apiKey),
        dailyCount: b.count,
        budget: dailyBudgetLimit(),
        date: b.date,
    };
}
async function getTomTomFlowTile(z, x, y) {
    await loadBudgetOnce();
    const apiKey = await (0, env_config_1.readServerSecret)('TOMTOM_API_KEY');
    if (!apiKey) {
        return { ok: false, status: 503, error: 'no_key' };
    }
    const key = `${z}/${x}/${y}`;
    const now = Date.now();
    let entry = mem.get(key) || null;
    if (!entry) {
        entry = await readDiskTile(key);
        if (entry)
            memSet(key, entry);
    }
    if (entry && now - entry.at < TILE_TTL_MS) {
        return { ok: true, buf: entry.buf, cacheStatus: 'HIT', fetchedAt: entry.at };
    }
    if ((0, tomtomTiles_1.isOverBudget)(currentBudget(), dailyBudgetLimit())) {
        if (entry) {
            return { ok: true, buf: entry.buf, cacheStatus: 'STALE-BUDGET', fetchedAt: entry.at };
        }
        return { ok: false, status: 429, error: 'budget' };
    }
    if (!inflight.has(key)) {
        const loader = fetchUpstreamTile(z, x, y, apiKey)
            .then(async (buf) => {
            const fresh = { at: Date.now(), buf };
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
