import type * as CesiumType from 'cesium';

const FORWARD_PROBE_M = 2_000;
const MIN_SCREEN_COMPONENT_M2 = 0.25;

interface EllipsoidalOccluderLike {
  cameraPosition: CesiumType.Cartesian3;
  isPointVisible: (point: CesiumType.Cartesian3) => boolean;
}

export function shortestAngleDelta(fromRad: number, toRad: number): number {
  return Math.atan2(Math.sin(toRad - fromRad), Math.cos(toRad - fromRad));
}

export function slewHeadingDeg(
  currentDeg: number,
  targetDeg: number,
  maxStepDeg: number,
): number {
  const diff = ((((targetDeg - currentDeg) % 360) + 540) % 360) - 180;
  if (Math.abs(diff) <= maxStepDeg) return ((targetDeg % 360) + 360) % 360;
  return (((currentDeg + Math.sign(diff) * maxStepDeg) % 360) + 360) % 360;
}

export function lerpAngleDeg(fromDeg: number, toDeg: number, t: number): number {
  const diff = ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
  return (((fromDeg + diff * t) % 360) + 360) % 360;
}

/**
 * Bounded cockpit anchor convergence step (<= 22% of forward speed) so delayed
 * feed adjustments never snap or reverse the first-person cockpit camera.
 */
export function cockpitAnchorCorrectionStep(
  distanceM: number,
  speedMps: number,
  dtSec: number,
): number {
  if (!Number.isFinite(distanceM) || distanceM <= 0 || !Number.isFinite(dtSec) || dtSec <= 0) {
    return 0;
  }
  const dt = Math.min(0.1, dtSec);
  const speed = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;
  const eased = distanceM * (1 - Math.exp(-1.25 * dt));
  const correctionRateMps = Math.max(0.75, speed * 0.22);
  return Math.min(distanceM, eased, correctionRateMps * dt);
}

export class HorizonOccluder {
  private Cesium: typeof CesiumType;
  private ellipsoid: CesiumType.Ellipsoid;
  private occluder: EllipsoidalOccluderLike | null = null;
  private scratchPoint: CesiumType.Cartesian3;

  constructor(Cesium: typeof CesiumType, cameraPosition: CesiumType.Cartesian3) {
    this.Cesium = Cesium;
    this.ellipsoid = Cesium.Ellipsoid.WGS84;
    this.scratchPoint = new Cesium.Cartesian3();
    const Ctor = (
      Cesium as unknown as {
        EllipsoidalOccluder?: new (
          ellipsoid: CesiumType.Ellipsoid,
          cameraPosition: CesiumType.Cartesian3,
        ) => EllipsoidalOccluderLike;
      }
    ).EllipsoidalOccluder;
    if (Ctor) {
      this.occluder = new Ctor(this.ellipsoid, cameraPosition);
    }
  }

  updateCamera(cameraPosition: CesiumType.Cartesian3) {
    if (this.occluder) {
      this.occluder.cameraPosition = cameraPosition;
    }
  }

  isCartesianVisible(point: CesiumType.Cartesian3): boolean {
    return this.occluder ? this.occluder.isPointVisible(point) : true;
  }

  isLatLonVisible(latDeg: number, lonDeg: number, heightM = 0): boolean {
    if (!this.occluder) return true;
    this.Cesium.Cartesian3.fromDegrees(
      lonDeg,
      latDeg,
      heightM,
      this.ellipsoid,
      this.scratchPoint,
    );
    return this.occluder.isPointVisible(this.scratchPoint);
  }
}

export class ScreenHeadingProjector {
  private Cesium: typeof CesiumType;
  private scratchEnu: CesiumType.Matrix4;
  private scratchForward: CesiumType.Cartesian3;
  private scratchWorldForward: CesiumType.Cartesian3;

  constructor(Cesium: typeof CesiumType) {
    this.Cesium = Cesium;
    this.scratchEnu = new Cesium.Matrix4();
    this.scratchForward = new Cesium.Cartesian3();
    this.scratchWorldForward = new Cesium.Cartesian3();
  }

  compute(
    camera: CesiumType.Camera | undefined,
    position: CesiumType.Cartesian3,
    courseDeg: number,
    previous: number,
  ): number {
    if (!camera?.rightWC || !camera?.upWC) return previous;
    const courseRad = ((courseDeg || 0) * Math.PI) / 180;
    this.Cesium.Cartesian3.fromElements(
      Math.sin(courseRad) * FORWARD_PROBE_M,
      Math.cos(courseRad) * FORWARD_PROBE_M,
      0,
      this.scratchForward,
    );
    this.Cesium.Transforms.eastNorthUpToFixedFrame(
      position,
      this.Cesium.Ellipsoid.WGS84,
      this.scratchEnu,
    );
    this.Cesium.Matrix4.multiplyByPointAsVector(
      this.scratchEnu,
      this.scratchForward,
      this.scratchWorldForward,
    );

    const dx = this.Cesium.Cartesian3.dot(this.scratchWorldForward, camera.rightWC);
    const dy = -this.Cesium.Cartesian3.dot(this.scratchWorldForward, camera.upWC);
    if (dx * dx + dy * dy < MIN_SCREEN_COMPONENT_M2) return previous;
    return Math.atan2(-dx, -dy);
  }
}

export function trackedModelScaleForPixelCap({
  baseScale,
  nativeRadiusM,
  rangeM,
  viewportHeightPx,
  fovyRad,
  maximumPixelSize,
}: {
  baseScale: number;
  nativeRadiusM: number;
  rangeM: number;
  viewportHeightPx: number;
  fovyRad: number;
  maximumPixelSize: number;
}): number {
  if (
    !Number.isFinite(baseScale) ||
    baseScale <= 0 ||
    !Number.isFinite(nativeRadiusM) ||
    nativeRadiusM <= 0 ||
    !Number.isFinite(rangeM) ||
    rangeM <= 0 ||
    !Number.isFinite(viewportHeightPx) ||
    viewportHeightPx <= 0 ||
    !Number.isFinite(fovyRad) ||
    fovyRad <= 0 ||
    !Number.isFinite(maximumPixelSize) ||
    maximumPixelSize <= 0
  ) {
    return baseScale;
  }
  const focalLengthPx = viewportHeightPx / (2 * Math.tan(fovyRad / 2));
  const projectedDiameterPx = (2 * nativeRadiusM * baseScale * focalLengthPx) / rangeM;
  if (projectedDiameterPx <= maximumPixelSize) return baseScale;
  return baseScale * (maximumPixelSize / projectedDiameterPx);
}
