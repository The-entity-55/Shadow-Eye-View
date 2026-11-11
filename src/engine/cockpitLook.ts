/**
 * Cockpit first-person look-around math ported from upstream src/cockpitLook.js.
 * Yaw is relative to the vehicle's nose heading (-180..180 deg, positive = right/starboard);
 * pitch is horizon-relative elevation (-85..85 deg, positive = up).
 */

export const LOOK_STEP_DEG = 5;
export const LOOK_COARSE_STEP_DEG = 45;
export const LOOK_PITCH_LIMIT_DEG = 85;
export const LOOK_REST_PITCH_DEG = -4;
export const LOOK_EASE_TAU_MS = 60;
const LOOK_SETTLE_DEG = 0.05;

export interface CockpitLookAngles {
  yawDeg: number;
  pitchDeg: number;
}

export interface CockpitLookStep {
  axis: 'yaw' | 'pitch';
  sign: 1 | -1;
  stepDeg: number;
}

const LOOK_KEY_MAP: Record<string, { axis: 'yaw' | 'pitch'; sign: 1 | -1 }> = {
  ArrowLeft: { axis: 'yaw', sign: -1 },
  ArrowRight: { axis: 'yaw', sign: 1 },
  ArrowUp: { axis: 'pitch', sign: 1 },
  ArrowDown: { axis: 'pitch', sign: -1 },
  a: { axis: 'yaw', sign: -1 },
  A: { axis: 'yaw', sign: -1 },
  d: { axis: 'yaw', sign: 1 },
  D: { axis: 'yaw', sign: 1 },
  w: { axis: 'pitch', sign: 1 },
  W: { axis: 'pitch', sign: 1 },
  s: { axis: 'pitch', sign: -1 },
  S: { axis: 'pitch', sign: -1 },
};

export function wrapLookYaw(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const wrapped = (((deg % 360) + 360) % 360) - 360;
  const yaw = wrapped <= -180 ? wrapped + 360 : wrapped;
  return yaw === 0 ? 0 : yaw;
}

export function clampLookPitch(deg: number): number {
  if (!Number.isFinite(deg)) return LOOK_REST_PITCH_DEG;
  const pitch = Math.min(LOOK_PITCH_LIMIT_DEG, Math.max(-LOOK_PITCH_LIMIT_DEG, deg));
  return pitch === 0 ? 0 : pitch;
}

export function lookKeyStep(key: string, coarse = false): CockpitLookStep | null {
  const mapping = LOOK_KEY_MAP[key];
  if (!mapping) return null;
  return {
    axis: mapping.axis,
    sign: mapping.sign,
    stepDeg: coarse ? LOOK_COARSE_STEP_DEG : LOOK_STEP_DEG,
  };
}

function nextOnGrid(value: number, sign: 1 | -1, stepDeg: number): number {
  const cells = value / stepDeg;
  const next = sign > 0 ? Math.floor(cells + 1e-9) + 1 : Math.ceil(cells - 1e-9) - 1;
  return next * stepDeg;
}

export function stepLook(target: CockpitLookAngles, step: CockpitLookStep): CockpitLookAngles {
  const yawDeg = wrapLookYaw(target?.yawDeg ?? 0);
  const pitchDeg = clampLookPitch(target?.pitchDeg ?? LOOK_REST_PITCH_DEG);
  if (step.axis === 'yaw') {
    return {
      yawDeg: wrapLookYaw(nextOnGrid(yawDeg, step.sign, step.stepDeg)),
      pitchDeg,
    };
  }
  return {
    yawDeg,
    pitchDeg: clampLookPitch(nextOnGrid(pitchDeg, step.sign, step.stepDeg)),
  };
}

export function easeLook(
  current: CockpitLookAngles,
  target: CockpitLookAngles,
  dtMs: number,
  immediate = false,
): CockpitLookAngles {
  const goalYaw = wrapLookYaw(target?.yawDeg ?? 0);
  const goalPitch = clampLookPitch(target?.pitchDeg ?? LOOK_REST_PITCH_DEG);
  if (immediate || !current) return { yawDeg: goalYaw, pitchDeg: goalPitch };

  const fraction = Number.isFinite(dtMs) && dtMs > 0 ? 1 - Math.exp(-dtMs / LOOK_EASE_TAU_MS) : 0;
  const fromYaw = wrapLookYaw(current.yawDeg);
  const yawError = wrapLookYaw(goalYaw - fromYaw);
  const fromPitch = clampLookPitch(current.pitchDeg);
  const pitchError = goalPitch - fromPitch;

  const yawDeg =
    Math.abs(yawError * (1 - fraction)) < LOOK_SETTLE_DEG
      ? goalYaw
      : wrapLookYaw(fromYaw + yawError * fraction);
  const pitchDeg =
    Math.abs(pitchError * (1 - fraction)) < LOOK_SETTLE_DEG
      ? goalPitch
      : clampLookPitch(fromPitch + pitchError * fraction);

  return { yawDeg, pitchDeg };
}

export function lookIsOffset(
  look: CockpitLookAngles,
  restPitchDeg = LOOK_REST_PITCH_DEG,
): boolean {
  return (
    Math.abs(wrapLookYaw(look?.yawDeg ?? 0)) > 0.25 ||
    Math.abs(clampLookPitch(look?.pitchDeg ?? restPitchDeg) - clampLookPitch(restPitchDeg)) > 0.25
  );
}

export function formatCockpitLookLabel(
  look: CockpitLookAngles,
  restPitchDeg = LOOK_REST_PITCH_DEG,
): string {
  const yaw = Math.round(wrapLookYaw(look?.yawDeg ?? 0));
  const pitch = Math.round(clampLookPitch(look?.pitchDeg ?? restPitchDeg));
  const parts: string[] = [];

  if (Math.abs(yaw) >= 180) parts.push('ASTERN 180°');
  else if (yaw > 0) parts.push(`RIGHT ${String(yaw).padStart(3, '0')}°`);
  else if (yaw < 0) parts.push(`LEFT ${String(Math.abs(yaw)).padStart(3, '0')}°`);

  if (pitch !== Math.round(restPitchDeg)) {
    parts.push(
      pitch > 0 ? `UP ${pitch}°` : pitch < 0 ? `DOWN ${Math.abs(pitch)}°` : 'LEVEL 0°',
    );
  }

  return parts.length ? parts.join(' · ') : 'AHEAD';
}
