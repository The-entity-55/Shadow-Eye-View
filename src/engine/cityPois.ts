import type { CityPreset } from '@/types/gev';

export const GLOBE_OVERVIEW = {
  lat: 20,
  lon: -40,
  alt: 18_500_000,
  heading: 0,
  pitch: -89,
};

export const CITY_PRESETS: CityPreset[] = [
  {
    id: 'austin',
    name: 'Austin',
    groundElevation: 150,
    pois: [
      { name: 'Texas State Capitol', lat: 30.2747, lon: -97.7403, alt: 550, pitch: -28, heading: 180, buildingHeight: 35 },
      { name: 'Frost Bank Tower', lat: 30.2674, lon: -97.7434, alt: 550, pitch: -22, heading: 30, buildingHeight: 80 },
      { name: 'Pennybacker Bridge', lat: 30.3451, lon: -97.7951, alt: 500, pitch: -25, heading: 90, buildingHeight: 40 },
      { name: 'The Jenga Tower', lat: 30.2642, lon: -97.75, alt: 500, pitch: -18, heading: 45, buildingHeight: 60 },
      { name: 'UT Tower', lat: 30.2862, lon: -97.7394, alt: 500, pitch: -22, heading: 180, buildingHeight: 50 },
    ],
  },
  {
    id: 'sf',
    name: 'San Francisco',
    groundElevation: 15,
    pois: [
      { name: 'Golden Gate Bridge', lat: 37.8199, lon: -122.4783, alt: 1400, pitch: -20, heading: 45, buildingHeight: 100 },
      { name: 'Transamerica Pyramid', lat: 37.7952, lon: -122.4028, alt: 500, pitch: -25, heading: 30, buildingHeight: 85 },
      { name: 'Salesforce Tower', lat: 37.7897, lon: -122.3972, alt: 680, pitch: -25, heading: 330, buildingHeight: 100 },
      { name: 'Alcatraz Island', lat: 37.8267, lon: -122.423, alt: 800, pitch: -30, heading: 0, buildingHeight: 20 },
      { name: 'Coit Tower', lat: 37.8024, lon: -122.4058, alt: 420, pitch: -30, heading: 45, buildingHeight: 30 },
    ],
  },
  {
    id: 'nyc',
    name: 'New York',
    groundElevation: 10,
    pois: [
      { name: 'Statue of Liberty', lat: 40.6892, lon: -74.0445, alt: 450, pitch: -25, heading: 315, buildingHeight: 45 },
      { name: 'Empire State Building', lat: 40.7484, lon: -73.9857, alt: 850, pitch: -12, heading: 30, buildingHeight: 130 },
      { name: 'One World Trade Center', lat: 40.7127, lon: -74.0134, alt: 850, pitch: -25, heading: 0, buildingHeight: 170 },
      { name: 'Brooklyn Bridge', lat: 40.7061, lon: -73.9969, alt: 850, pitch: -25, heading: 45, buildingHeight: 40 },
      { name: 'Chrysler Building', lat: 40.7516, lon: -73.9755, alt: 700, pitch: -20, heading: 225, buildingHeight: 100 },
    ],
  },
  {
    id: 'tokyo',
    name: 'Tokyo',
    groundElevation: 40,
    pois: [
      { name: 'Tokyo Tower', lat: 35.6586, lon: 139.7454, alt: 850, pitch: -25, heading: 0, buildingHeight: 110 },
      { name: 'Tokyo Skytree', lat: 35.7101, lon: 139.8107, alt: 900, pitch: -25, heading: 30, buildingHeight: 200 },
      { name: 'Imperial Palace', lat: 35.6852, lon: 139.7528, alt: 900, pitch: -35, heading: 0, buildingHeight: 20 },
      { name: 'Senso-ji Temple', lat: 35.7148, lon: 139.7967, alt: 400, pitch: -30, heading: 180, buildingHeight: 25 },
      { name: 'Mode Gakuen Cocoon', lat: 35.6929, lon: 139.6925, alt: 350, pitch: -20, heading: 30, buildingHeight: 70 },
    ],
  },
  {
    id: 'london',
    name: 'London',
    groundElevation: 15,
    pois: [
      { name: 'Tower Bridge', lat: 51.5055, lon: -0.0754, alt: 400, pitch: -25, heading: 270, buildingHeight: 65 },
      { name: 'The Shard', lat: 51.5045, lon: -0.0865, alt: 850, pitch: -20, heading: 0, buildingHeight: 100 },
      { name: 'Big Ben', lat: 51.5007, lon: -0.1246, alt: 600, pitch: -25, heading: 180, buildingHeight: 50 },
      { name: "St. Paul's Cathedral", lat: 51.5138, lon: -0.0984, alt: 400, pitch: -30, heading: 270, buildingHeight: 55 },
      { name: 'The Gherkin', lat: 51.5145, lon: -0.0803, alt: 350, pitch: -20, heading: 30, buildingHeight: 60 },
    ],
  },
  {
    id: 'paris',
    name: 'Paris',
    groundElevation: 35,
    pois: [
      { name: 'Eiffel Tower', lat: 48.8584, lon: 2.2945, alt: 750, pitch: -25, heading: 315, buildingHeight: 150 },
      { name: 'Arc de Triomphe', lat: 48.8738, lon: 2.295, alt: 400, pitch: -28, heading: 45, buildingHeight: 25 },
      { name: 'Notre-Dame', lat: 48.853, lon: 2.3499, alt: 400, pitch: -25, heading: 225, buildingHeight: 35 },
      { name: 'Sacré-Cœur', lat: 48.8867, lon: 2.3431, alt: 400, pitch: -30, heading: 180, buildingHeight: 40 },
      { name: 'Louvre Pyramid', lat: 48.8606, lon: 2.3376, alt: 500, pitch: -35, heading: 0, buildingHeight: 10 },
    ],
  },
  {
    id: 'dubai',
    name: 'Dubai',
    groundElevation: 5,
    pois: [
      { name: 'Burj Khalifa', lat: 25.1972, lon: 55.2744, alt: 600, pitch: -20, heading: 200, buildingHeight: 270 },
      { name: 'Burj Al Arab', lat: 25.1412, lon: 55.1853, alt: 500, pitch: -25, heading: 90, buildingHeight: 100 },
      { name: 'Palm Jumeirah', lat: 25.1124, lon: 55.139, alt: 1200, pitch: -40, heading: 0, buildingHeight: 20 },
      { name: 'Dubai Frame', lat: 25.235, lon: 55.3003, alt: 400, pitch: -25, heading: 270, buildingHeight: 75 },
      { name: 'Museum of the Future', lat: 25.2197, lon: 55.2806, alt: 350, pitch: -20, heading: 30, buildingHeight: 35 },
    ],
  },
  {
    id: 'dc',
    name: 'Washington DC',
    groundElevation: 10,
    pois: [
      { name: 'US Capitol', lat: 38.8897, lon: -77.0091, alt: 550, pitch: -25, heading: 270, buildingHeight: 45 },
      { name: 'Washington Monument', lat: 38.8895, lon: -77.0353, alt: 500, pitch: -30, heading: 0, buildingHeight: 85 },
      { name: 'Lincoln Memorial', lat: 38.8893, lon: -77.0502, alt: 400, pitch: -25, heading: 90, buildingHeight: 20 },
      { name: 'Pentagon', lat: 38.8711, lon: -77.0559, alt: 800, pitch: -40, heading: 0, buildingHeight: 20 },
      { name: 'Jefferson Memorial', lat: 38.8814, lon: -77.0365, alt: 400, pitch: -30, heading: 0, buildingHeight: 25 },
    ],
  },
  {
    id: 'tallinn',
    name: 'Tallinn',
    groundElevation: 15,
    pois: [
      { name: 'Viru Square', lat: 59.4366, lon: 24.7527, alt: 450, pitch: -28, heading: 60, buildingHeight: 25 },
      { name: 'Old Town', lat: 59.4372, lon: 24.7452, alt: 400, pitch: -30, heading: 180, buildingHeight: 20 },
      { name: 'Teatri väljak', lat: 59.4344, lon: 24.7514, alt: 400, pitch: -25, heading: 220, buildingHeight: 25 },
      { name: 'Port of Tallinn', lat: 59.4445, lon: 24.7675, alt: 700, pitch: -30, heading: 90, buildingHeight: 20 },
      { name: 'Ülemiste', lat: 59.421, lon: 24.792, alt: 600, pitch: -28, heading: 45, buildingHeight: 30 },
    ],
  },
];

export function getCityPreset(cityId: string): CityPreset {
  return CITY_PRESETS.find((c) => c.id === cityId) || CITY_PRESETS[0];
}

/**
 * Parse decimal coordinates ("30.27, -97.74") or geo: URI ("geo:39.7392,-104.9903").
 */
export function parseDirectCoordinates(
  raw: string,
): { lat: number; lon: number; label: string } | null {
  const trimmed = raw.trim();
  const geoMatch = /^geo:\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)(?:[?;].*)?$/i.exec(
    trimmed,
  );
  const coordMatch =
    geoMatch ||
    /^([-+]?\d+(?:\.\d+)?)\s*[,\s]\s*([-+]?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (!coordMatch) return null;
  const lat = Number(coordMatch[1]);
  const lon = Number(coordMatch[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
}

/**
 * Keyless match against bundled preset cities and landmarks.
 */
export function matchBundledLocation(
  raw: string,
): { cityId?: string; poiIndex?: number; lat: number; lon: number; alt: number; heading?: number; pitch?: number; label: string } | null {
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  for (const city of CITY_PRESETS) {
    if (city.name.toLowerCase() === q || city.id === q) {
      const first = city.pois[0];
      return {
        cityId: city.id,
        poiIndex: 0,
        lat: first.lat,
        lon: first.lon,
        alt: first.alt + city.groundElevation,
        heading: first.heading,
        pitch: first.pitch,
        label: city.name,
      };
    }
    for (let i = 0; i < city.pois.length; i++) {
      const poi = city.pois[i];
      if (poi.name.toLowerCase().includes(q)) {
        return {
          cityId: city.id,
          poiIndex: i,
          lat: poi.lat,
          lon: poi.lon,
          alt: poi.alt + city.groundElevation,
          heading: poi.heading,
          pitch: poi.pitch,
          label: `${poi.name}, ${city.name}`,
        };
      }
    }
  }
  return null;
}
