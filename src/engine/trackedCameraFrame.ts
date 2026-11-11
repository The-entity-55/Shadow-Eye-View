import type * as CesiumType from 'cesium';

const MAX_FRAME_ATTEMPTS = 120;
const MIN_TRACKED_RANGE_M = 150;

/**
 * ENU camera offset positioned behind and above the target along `headingDeg`,
 * so the follow camera looks directly along the vehicle's flight/travel heading.
 */
export function behindTargetEnuOffset(
  Cesium: typeof CesiumType,
  headingDeg: number,
  horizontalDistM: number,
  upDistM: number,
): CesiumType.Cartesian3 {
  const rad = Cesium.Math.toRadians(Number.isFinite(headingDeg) ? headingDeg : 0);
  return new Cesium.Cartesian3(
    -Math.sin(rad) * horizontalDistM,
    -Math.cos(rad) * horizontalDistM,
    upDistM,
  );
}

/**
 * Frames `viewer.trackedEntity` once on the next `preUpdate` in its ENU frame
 * with `viewFrom`, then lets Cesium's EntityView own continuous tracking while
 * enforcing a safe minimum zoom distance.
 */
export function acquireTrackedCameraFrame(
  Cesium: typeof CesiumType,
  viewer: CesiumType.Viewer,
  entity: CesiumType.Entity,
  viewFrom: CesiumType.Cartesian3,
  minRangeM = MIN_TRACKED_RANGE_M,
): () => void {
  const controller = viewer.scene.screenSpaceCameraController;
  const origInertiaZoom = controller.inertiaZoom;
  const origMinZoom = controller.minimumZoomDistance;
  controller.inertiaZoom = 0;
  controller.minimumZoomDistance = Math.max(origMinZoom, minRangeM);

  const trackedTransform = new Cesium.Matrix4();
  const trackedPos = new Cesium.Cartesian3();
  const resolvedOffset = new Cesium.Cartesian3();
  const prevCamPos = new Cesium.Cartesian3();
  const clampOffset = new Cesium.Cartesian3();

  let attempts = 0;
  let framed = false;
  let stopped = false;

  const remove = viewer.scene.preUpdate.addEventListener(() => {
    if (stopped || viewer.isDestroyed() || viewer.trackedEntity !== entity) {
      stop();
      return;
    }

    if (!framed) {
      attempts += 1;
      const pos = entity.position?.getValue(viewer.clock.currentTime, trackedPos);
      if (!pos) {
        if (attempts >= MAX_FRAME_ATTEMPTS) stop();
        return;
      }
      Cesium.Transforms.eastNorthUpToFixedFrame(pos, Cesium.Ellipsoid.WGS84, trackedTransform);
      Cesium.Cartesian3.clone(viewFrom, resolvedOffset);
      if (Cesium.Cartesian3.magnitudeSquared(resolvedOffset) < Cesium.Math.EPSILON12) {
        stop();
        return;
      }
      viewer.camera.lookAtTransform(trackedTransform, resolvedOffset);
      Cesium.Cartesian3.clone(viewer.camera.position, prevCamPos);
      framed = true;
      return;
    }

    const cam = viewer.camera;
    const crossedOrigin = Cesium.Cartesian3.dot(cam.position, prevCamPos) <= 0;
    const forwardDistance = -Cesium.Cartesian3.dot(cam.position, cam.direction);
    const rangeSq = Cesium.Cartesian3.magnitudeSquared(cam.position);

    if (crossedOrigin) {
      Cesium.Cartesian3.normalize(prevCamPos, cam.position);
      Cesium.Cartesian3.multiplyByScalar(cam.position, minRangeM, cam.position);
      Cesium.Cartesian3.clone(cam.position, clampOffset);
      cam.lookAtTransform(cam.transform, clampOffset);
    } else if (forwardDistance < minRangeM || rangeSq < minRangeM * minRangeM) {
      Cesium.Cartesian3.multiplyByScalar(cam.direction, -minRangeM, cam.position);
      Cesium.Cartesian3.clone(cam.position, clampOffset);
      cam.lookAtTransform(cam.transform, clampOffset);
    }
    Cesium.Cartesian3.clone(cam.position, prevCamPos);
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    remove();
    if (!viewer.isDestroyed()) {
      controller.inertiaZoom = origInertiaZoom;
      controller.minimumZoomDistance = origMinZoom;
    }
  }

  return stop;
}
