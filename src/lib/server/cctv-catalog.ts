import fs from 'node:fs/promises';
import path from 'node:path';
import { coalesceRequest, readResponseTextCapped } from './proxy-utils';

export interface CctvSource {
  id: string;
  name: string;
  city: string;
  cityId: string;
  provider: string;
  lat: number;
  lon: number;
  headingDeg: number;
  pitchDeg: number;
  fovDeg: number;
  rangeM: number;
  mountHeightM: number;
  groundElevationM: number;
  feedType: 'image' | 'hls';
  url: string;
  snapshotUrl: string;
  license?: string;
}

export interface CctvCatalog {
  at: number;
  sources: CctvSource[];
  byId: Map<string, CctvSource>;
}

const CACHE_TTL_MS = 10 * 60_000;
const CATALOG_CAP = 1200;

let catalogCache: CctvCatalog | null = null;
const inFlight = new Map<string, Promise<CctvCatalog>>();

function hashHeading(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) % 360;
  }
  return Math.abs(h);
}

async function fetchAustinCameras(): Promise<CctvSource[]> {
  try {
    const resp = await fetch(
      'https://data.austintexas.gov/api/views/b4k4-adkb/rows.json?accessType=DOWNLOAD',
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      },
    );
    if (!resp.ok) {
      void resp.body?.cancel().catch(() => {});
      return [];
    }
    const text = await readResponseTextCapped(resp, 8 * 1024 * 1024);
    const json = JSON.parse(text) as {
      meta?: { view?: { columns?: Array<{ fieldName?: string }> } };
      data?: unknown[][];
    };
    const cols = json?.meta?.view?.columns?.map((c) => c.fieldName || '') || [];
    const rows = Array.isArray(json?.data) ? json.data : [];
    const idIdx = cols.indexOf('camera_id');
    const nameIdx = cols.indexOf('location_name');
    const statusIdx = cols.indexOf('camera_status');
    const locIdx = cols.indexOf('location');
    if (idIdx < 0 || locIdx < 0) return [];

    const out: CctvSource[] = [];
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const status = statusIdx >= 0 ? String(row[statusIdx] || '').trim().toUpperCase() : '';
      if (status && status !== 'TURNED_ON') continue;
      const cameraId = String(row[idIdx] || '').trim();
      if (!cameraId || !/^[a-zA-Z0-9_-]{1,32}$/.test(cameraId)) continue;
      const loc = row[locIdx] as { coordinates?: [number, number] } | null;
      const coords = loc?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const [lon, lat] = coords.map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 29.8 || lat > 30.7 || lon < -98.2 || lon > -97.3) {
        continue;
      }
      const imageUrl = `https://cctv.austinmobility.io/image/${encodeURIComponent(cameraId)}.jpg`;
      out.push({
        id: `aus-${cameraId}`,
        name: String((nameIdx >= 0 ? row[nameIdx] : '') || `Austin Cam ${cameraId}`).trim(),
        city: 'Austin',
        cityId: 'austin',
        provider: 'Austin Transportation & Public Works',
        lat,
        lon,
        headingDeg: hashHeading(cameraId),
        pitchDeg: -20,
        fovDeg: 52,
        rangeM: 180,
        mountHeightM: 9,
        groundElevationM: 150,
        feedType: 'image',
        url: imageUrl,
        snapshotUrl: imageUrl,
        license: 'City of Austin Open Data (CC0 / Public)',
      });
      if (out.length >= 250) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchTflJamCams(): Promise<CctvSource[]> {
  try {
    const resp = await fetch('https://api.tfl.gov.uk/Place/Type/JamCam', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      void resp.body?.cancel().catch(() => {});
      return [];
    }
    const text = await readResponseTextCapped(resp, 6 * 1024 * 1024);
    const items = JSON.parse(text) as Array<{
      id?: string;
      commonName?: string;
      lat?: number;
      lon?: number;
      additionalProperties?: Array<{ key?: string; value?: string }>;
    }>;
    if (!Array.isArray(items)) return [];

    const out: CctvSource[] = [];
    for (const item of items) {
      const id = String(item?.id || '').trim();
      const lat = Number(item?.lat);
      const lon = Number(item?.lon);
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const props = Array.isArray(item.additionalProperties) ? item.additionalProperties : [];
      const available = props.find((p) => p.key === 'available')?.value;
      if (available && available !== 'true') continue;
      const imgProp = props.find((p) => p.key === 'imageUrl')?.value;
      const safeUrl =
        imgProp && imgProp.startsWith('https://')
          ? imgProp
          : `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${encodeURIComponent(id.replace(/^JamCam_?/, ''))}.jpg`;
      out.push({
        id: `tfl-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`,
        name: String(item.commonName || id).trim(),
        city: 'London',
        cityId: 'london',
        provider: 'Transport for London (TfL JamCams)',
        lat,
        lon,
        headingDeg: hashHeading(id),
        pitchDeg: -18,
        fovDeg: 50,
        rangeM: 160,
        mountHeightM: 8,
        groundElevationM: 15,
        feedType: 'image',
        url: safeUrl,
        snapshotUrl: safeUrl,
        license: 'Powered by TfL Open Data',
      });
      if (out.length >= 250) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchBundledCctvPack(filename: string, limit: number): Promise<CctvSource[]> {
  try {
    const filePath = path.join(process.cwd(), 'data', 'cctv', filename);
    const raw = await fs.readFile(filePath, 'utf8');
    const items = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(items)) return [];
    const out: CctvSource[] = [];
    for (const row of items) {
      const id = String(row.id || '').trim();
      const lat = Number(row.lat);
      const lon = Number(row.lon);
      const snapshotUrl = String(row.snapshotUrl || row.url || '').trim();
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || !snapshotUrl.startsWith('https://')) {
        continue;
      }
      out.push({
        id,
        name: String(row.name || id),
        city: String(row.city || 'World'),
        cityId: String(row.cityId || 'world'),
        provider: String(row.provider || 'Public Traffic Camera'),
        lat,
        lon,
        headingDeg: Number.isFinite(Number(row.headingDeg)) ? Number(row.headingDeg) : hashHeading(id),
        pitchDeg: Number.isFinite(Number(row.pitchDeg)) ? Number(row.pitchDeg) : -20,
        fovDeg: Number.isFinite(Number(row.fovDeg)) ? Number(row.fovDeg) : 48,
        rangeM: Number.isFinite(Number(row.rangeM)) ? Number(row.rangeM) : 170,
        mountHeightM: Number.isFinite(Number(row.mountHeightM)) ? Number(row.mountHeightM) : 8,
        groundElevationM: Number.isFinite(Number(row.groundElevationM)) ? Number(row.groundElevationM) : 20,
        feedType: 'image',
        url: snapshotUrl,
        snapshotUrl,
        license: typeof row.license === 'string' ? row.license : undefined,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function getCctvCatalog(): Promise<CctvCatalog> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CACHE_TTL_MS) {
    return catalogCache;
  }

  return coalesceRequest(inFlight, 'cctv-catalog', async () => {
    const [austin, london, tallinn, romania, world] = await Promise.all([
      fetchAustinCameras(),
      fetchTflJamCams(),
      fetchBundledCctvPack('cctv_sources.tallinn.json', 120),
      fetchBundledCctvPack('cctv_sources.romania.json', 10),
      fetchBundledCctvPack('cctv_sources.world-image-cameras.json', 350),
    ]);

    const combined = [...austin, ...london, ...tallinn, ...romania, ...world].slice(0, CATALOG_CAP);
    const byId = new Map<string, CctvSource>();
    for (const cam of combined) {
      byId.set(cam.id, cam);
    }
    const next: CctvCatalog = { at: Date.now(), sources: combined, byId };
    if (combined.length > 0 || !catalogCache) {
      catalogCache = next;
    }
    return catalogCache ?? next;
  });
}
