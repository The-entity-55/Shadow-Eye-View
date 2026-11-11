"use strict";
/**
 * Pure Web Mercator slippy-tile math & daily budget helpers ported from
 * upstream src/data/tomtomTiles.js and src/data/tileBudget.js.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_TILE_ZOOM = exports.MIN_TILE_ZOOM = void 0;
exports.isValidTileCoord = isValidTileCoord;
exports.lonLatToTile = lonLatToTile;
exports.tileToBBox = tileToBBox;
exports.tilesForBounds = tilesForBounds;
exports.utcDayKey = utcDayKey;
exports.normalizeBudget = normalizeBudget;
exports.isOverBudget = isOverBudget;
exports.MIN_TILE_ZOOM = 8;
exports.MAX_TILE_ZOOM = 16;
const MERCATOR_LAT_LIMIT = 85.05112878;
function isValidTileCoord(z, x, y, minZoom = exports.MIN_TILE_ZOOM, maxZoom = exports.MAX_TILE_ZOOM) {
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y))
        return false;
    if (z < minZoom || z > maxZoom)
        return false;
    const n = 2 ** z;
    return x >= 0 && x < n && y >= 0 && y < n;
}
function lonLatToTile(lon, lat, z) {
    const n = 2 ** z;
    const clampedLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat));
    const latRad = (clampedLat * Math.PI) / 180;
    const x = Math.floor(((lon + 180) / 360) * n);
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
    return {
        x: Math.max(0, Math.min(n - 1, x)),
        y: Math.max(0, Math.min(n - 1, y)),
    };
}
function tileToBBox(z, x, y) {
    const n = 2 ** z;
    const lonAt = (col) => (col / n) * 360 - 180;
    const latAt = (row) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
    return {
        west: lonAt(x),
        east: lonAt(x + 1),
        north: latAt(y),
        south: latAt(y + 1),
    };
}
function tilesForBounds(bounds, zoom = 12, maxTiles = 16) {
    const { south, west, north, east } = bounds;
    if (![south, west, north, east].every(Number.isFinite))
        return [];
    const nw = lonLatToTile(Math.min(west, east), Math.max(south, north), zoom);
    const se = lonLatToTile(Math.max(west, east), Math.min(south, north), zoom);
    const tiles = [];
    for (let y = nw.y; y <= se.y; y++) {
        for (let x = nw.x; x <= se.x; x++) {
            if (tiles.length >= maxTiles)
                return tiles;
            tiles.push({ z: zoom, x, y });
        }
    }
    return tiles;
}
function utcDayKey(epochMs = Date.now()) {
    return new Date(epochMs).toISOString().slice(0, 10);
}
function normalizeBudget(state, periodKey) {
    const valid = Boolean(state) &&
        state?.date === periodKey &&
        typeof state?.count === 'number' &&
        Number.isFinite(state.count) &&
        state.count >= 0;
    return valid ? { date: periodKey, count: state.count } : { date: periodKey, count: 0 };
}
function isOverBudget(state, limit) {
    if (!Number.isFinite(limit) || limit <= 0)
        return false;
    return state.count >= limit;
}
