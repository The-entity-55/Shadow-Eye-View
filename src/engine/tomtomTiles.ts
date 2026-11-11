/**
 * Pure Web Mercator slippy-tile math & daily budget helpers ported from
 * upstream src/data/tomtomTiles.js and src/data/tileBudget.js.
 */

export const MIN_TILE_ZOOM = 8;
export const MAX_TILE_ZOOM = 16;
const MERCATOR_LAT_LIMIT = 85.05112878;

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface TileBBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface DailyBudgetState {
  date: string;
  count: number;
}

export function isValidTileCoord(
  z: number,
  x: number,
  y: number,
  minZoom = MIN_TILE_ZOOM,
  maxZoom = MAX_TILE_ZOOM,
): boolean {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (z < minZoom || z > maxZoom) return false;
  const n = 2 ** z;
  return x >= 0 && x < n && y >= 0 && y < n;
}

export function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const clampedLat = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

export function tileToBBox(z: number, x: number, y: number): TileBBox {
  const n = 2 ** z;
  const lonAt = (col: number) => (col / n) * 360 - 180;
  const latAt = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return {
    west: lonAt(x),
    east: lonAt(x + 1),
    north: latAt(y),
    south: latAt(y + 1),
  };
}

export function tilesForBounds(
  bounds: TileBBox,
  zoom = 12,
  maxTiles = 16,
): TileCoord[] {
  const { south, west, north, east } = bounds;
  if (![south, west, north, east].every(Number.isFinite)) return [];
  const nw = lonLatToTile(Math.min(west, east), Math.max(south, north), zoom);
  const se = lonLatToTile(Math.max(west, east), Math.min(south, north), zoom);
  const tiles: TileCoord[] = [];
  for (let y = nw.y; y <= se.y; y++) {
    for (let x = nw.x; x <= se.x; x++) {
      if (tiles.length >= maxTiles) return tiles;
      tiles.push({ z: zoom, x, y });
    }
  }
  return tiles;
}

export function utcDayKey(epochMs = Date.now()): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function normalizeBudget(
  state: Partial<DailyBudgetState> | null | undefined,
  periodKey: string,
): DailyBudgetState {
  const valid =
    Boolean(state) &&
    state?.date === periodKey &&
    typeof state?.count === 'number' &&
    Number.isFinite(state.count) &&
    state.count >= 0;
  return valid ? { date: periodKey, count: state!.count! } : { date: periodKey, count: 0 };
}

export function isOverBudget(state: DailyBudgetState, limit: number): boolean {
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return state.count >= limit;
}
