let egm96MeanSeaLevel: ((latDeg: number, lonDeg: number) => number) | null = null;
let readyPromise: Promise<void> | null = null;

/**
 * Lazily loads the EGM96 15' geoid grid (~2.7 MB) so it stays out of the eager
 * client bundle while giving sea-level layers accurate ellipsoidal height (h = H + N).
 */
export function ensureGeoidReady(onReady?: () => void): Promise<void> {
  if (egm96MeanSeaLevel) {
    onReady?.();
    return Promise.resolve();
  }
  if (!readyPromise) {
    readyPromise = import('egm96-universal')
      .then((mod) => {
        egm96MeanSeaLevel = mod.meanSeaLevel;
      })
      .catch(() => {
        readyPromise = null;
      });
  }
  if (onReady) {
    return readyPromise.then(() => {
      if (egm96MeanSeaLevel) onReady();
    });
  }
  return readyPromise;
}

export function isGeoidReady(): boolean {
  return egm96MeanSeaLevel !== null;
}

/**
 * Local EGM96 geoid undulation N in metres relative to the WGS84 ellipsoid
 * (roughly -106..+85 m worldwide), or 0 while the grid is still loading.
 */
export function geoidHeightOrZero(latDeg: number, lonDeg: number): number {
  if (!egm96MeanSeaLevel || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) {
    return 0;
  }
  const n = egm96MeanSeaLevel(latDeg, lonDeg);
  return Number.isFinite(n) ? n : 0;
}
