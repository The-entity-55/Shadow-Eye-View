import type * as CesiumType from 'cesium';
import type { MapStackId } from '@/types/gev';

export interface MapStackDescriptor {
  id: MapStackId;
  label: string;
  shortLabel: string;
  requiresCredentials: boolean;
  requirementBadge?: string;
}

export const MAP_STACK_DESCRIPTORS: MapStackDescriptor[] = [
  {
    id: 'photoreal',
    label: 'Google 3D',
    shortLabel: '3D',
    requiresCredentials: true,
    requirementBadge: 'KEY / ION',
  },
  {
    id: 'bing-aerial',
    label: 'Bing Aerial',
    shortLabel: 'Aerial',
    requiresCredentials: true,
    requirementBadge: 'ION',
  },
  {
    id: 'bing-labels',
    label: 'Bing Labels',
    shortLabel: 'Labels',
    requiresCredentials: true,
    requirementBadge: 'ION',
  },
  {
    id: 'esri-imagery',
    label: 'Esri Satellite',
    shortLabel: 'SAT',
    requiresCredentials: false,
  },
  {
    id: 'osm',
    label: 'OSM',
    shortLabel: 'OSM',
    requiresCredentials: false,
  },
];

const KEYLESS_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';

export async function loadPhotorealisticTileset(
  Cesium: typeof CesiumType,
  { googleApiKey = '', cesiumToken = '' }: { googleApiKey?: string; cesiumToken?: string },
): Promise<{ tileset: CesiumType.Cesium3DTileset | null; route: string }> {
  const gKey = googleApiKey.trim();
  const ion = cesiumToken.trim();

  if (gKey) {
    try {
      const tileset = await Cesium.createGooglePhotorealistic3DTileset(
        { key: gKey, onlyUsingWithGoogleGeocoder: true },
        { asynchronouslyLoadImagery: true },
      );
      return { tileset, route: 'google-direct' };
    } catch (err) {
      console.warn('[MapStack] Google direct 3D tiles unavailable:', err);
    }
  }

  if (ion) {
    try {
      const resource = await Cesium.IonResource.fromAssetId(2275207, {
        accessToken: ion,
      });
      const tileset = await Cesium.Cesium3DTileset.fromUrl(resource, {
        cacheBytes: 1536 * 1024 * 1024,
        maximumCacheOverflowBytes: 1024 * 1024 * 1024,
        enableCollision: true,
        asynchronouslyLoadImagery: true,
      });
      return { tileset, route: 'google-ion' };
    } catch (err) {
      console.warn('[MapStack] Cesium ion Google 3D tiles unavailable:', err);
    }
  }

  return { tileset: null, route: 'keyless' };
}

export async function createTerrainForCredentials(
  Cesium: typeof CesiumType,
  cesiumToken?: string,
): Promise<CesiumType.TerrainProvider> {
  const ion = (cesiumToken || '').trim();
  if (ion) {
    try {
      const resource = await Cesium.IonResource.fromAssetId(1, { accessToken: ion });
      return await Cesium.CesiumTerrainProvider.fromUrl(resource, {
        requestVertexNormals: true,
        requestWaterMask: false,
        ellipsoid: Cesium.Ellipsoid.WGS84,
      });
    } catch (err) {
      console.warn('[MapStack] Cesium World Terrain failed, trying keyless terrain:', err);
    }
  }

  try {
    return await Cesium.CesiumTerrainProvider.fromUrl(KEYLESS_TERRAIN_URL);
  } catch (err) {
    console.warn('[MapStack] Re:Earth keyless terrain failed, falling back to flat ellipsoid:', err);
    return new Cesium.EllipsoidTerrainProvider();
  }
}

export async function createImageryForStack(
  Cesium: typeof CesiumType,
  stackId: Exclude<MapStackId, 'photoreal'>,
  cesiumToken?: string,
): Promise<CesiumType.ImageryProvider> {
  if (stackId === 'osm') {
    return new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
      credit: '© OpenStreetMap contributors',
    });
  }

  if (stackId === 'bing-aerial' || stackId === 'bing-labels') {
    const token = (cesiumToken || '').trim();
    if (!token) throw new Error('Cesium ion token required');
    const style =
      stackId === 'bing-aerial'
        ? Cesium.IonWorldImageryStyle.AERIAL
        : Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS;
    const endpoint = await new Cesium.Resource({
      url: `https://api.cesium.com/v1/assets/${style}/endpoint`,
      queryParameters: { access_token: token },
    }).fetchJson();
    const { url, ...options } = endpoint.options || {};
    return Cesium.BingMapsImageryProvider.fromUrl(url, {
      ...options,
      tileProtocol: 'https',
    });
  }

  return Cesium.ArcGisMapServerImageryProvider.fromUrl(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
    {
      credit: 'Powered by Esri — Maxar, Earthstar Geographics, GIS User Community',
      enablePickFeatures: false,
    },
  );
}
