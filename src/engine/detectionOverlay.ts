import type * as CesiumType from 'cesium';
import type { DetectionMode, DetectionTarget, VisualStyleId } from '@/types/gev';
import { hudPaletteForStyle } from './hudMath';

export function renderDetectionOverlay(
  canvas: HTMLCanvasElement,
  viewer: CesiumType.Viewer,
  Cesium: typeof CesiumType,
  targets: DetectionTarget[],
  options: {
    mode: DetectionMode;
    densityPct: number;
    style: VisualStyleId;
    selectedEntityId: string | null;
  },
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return;

  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (options.mode === 'OFF' || targets.length === 0) return;

  const camPos = viewer.camera.positionWC;
  const ellip = Cesium.Ellipsoid.WGS84;
  const occluder = new (Cesium as unknown as {
    EllipsoidalOccluder: new (
      e: CesiumType.Ellipsoid,
      c: CesiumType.Cartesian3,
    ) => { isPointVisible: (p: CesiumType.Cartesian3) => boolean };
  }).EllipsoidalOccluder(ellip, camPos);

  const maxCap = options.mode === 'SPARSE' ? 24 : 95;
  const budget = Math.max(1, Math.round((maxCap * Math.max(5, options.densityPct)) / 100));

  const visible: Array<{ target: DetectionTarget; x: number; y: number; dist: number }> = [];
  const scratchCart = new Cesium.Cartesian3();

  for (const target of targets) {
    Cesium.Cartesian3.fromDegrees(target.lon, target.lat, target.altM, ellip, scratchCart);
    if (target.altM < 120_000 && !occluder.isPointVisible(scratchCart)) continue;

    const screen = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, scratchCart);
    if (!screen || screen.x < 16 || screen.x > w - 16 || screen.y < 16 || screen.y > h - 16) {
      continue;
    }
    const dist = Cesium.Cartesian3.distance(camPos, scratchCart);
    visible.push({ target, x: screen.x, y: screen.y, dist });
  }

  visible.sort((a, b) => {
    if (a.target.entityId === options.selectedEntityId) return -1;
    if (b.target.entityId === options.selectedEntityId) return 1;
    if (a.target.priority !== b.target.priority) return b.target.priority - a.target.priority;
    return a.dist - b.dist;
  });

  const palette = hudPaletteForStyle(options.style);
  const placedBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const chosen = visible.slice(0, budget);

  ctx.font = '500 10px "JetBrains Mono", monospace';
  ctx.textBaseline = 'top';

  for (const item of chosen) {
    const { target, x, y } = item;
    const isSelected = target.entityId === options.selectedEntityId;
    const boxSize = isSelected ? 28 : 18;
    const half = boxSize / 2;
    const br = 5;

    const stroke = isSelected ? '#00f6ff' : target.color || palette.color;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = isSelected ? 1.6 : 1.1;

    // 4 tactical corner brackets
    ctx.beginPath();
    // Top-left
    ctx.moveTo(x - half, y - half + br);
    ctx.lineTo(x - half, y - half);
    ctx.lineTo(x - half + br, y - half);
    // Top-right
    ctx.moveTo(x + half - br, y - half);
    ctx.lineTo(x + half, y - half);
    ctx.lineTo(x + half, y - half + br);
    // Bottom-right
    ctx.moveTo(x + half, y + half - br);
    ctx.lineTo(x + half, y + half);
    ctx.lineTo(x + half - br, y + half);
    // Bottom-left
    ctx.moveTo(x - half + br, y + half);
    ctx.lineTo(x - half, y + half);
    ctx.lineTo(x - half, y + half - br);
    ctx.stroke();

    // Label collision avoidance
    const labelText = target.label;
    const textWidth = Math.min(130, ctx.measureText(labelText).width + 8);
    const lx = x + half + 5;
    const ly = y - half - 1;
    const lh = target.sublabel ? 24 : 13;

    const overlaps =
      !isSelected &&
      placedBoxes.some(
        (b) => lx < b.x2 && lx + textWidth > b.x1 && ly < b.y2 && ly + lh > b.y1,
      );
    if (overlaps && options.mode === 'SPARSE') continue;
    if (!overlaps) {
      placedBoxes.push({ x1: lx, y1: ly, x2: lx + textWidth, y2: ly + lh });
      ctx.fillStyle = 'rgba(8, 14, 22, 0.72)';
      ctx.fillRect(lx - 2, ly - 1, textWidth, lh);

      ctx.fillStyle = stroke;
      ctx.fillText(labelText, lx + 2, ly + 1);
      if (target.sublabel) {
        ctx.fillStyle = 'rgba(232, 234, 237, 0.74)';
        ctx.font = '400 9px "JetBrains Mono", monospace';
        ctx.fillText(target.sublabel, lx + 2, ly + 12);
        ctx.font = '500 10px "JetBrains Mono", monospace';
      }
    }
  }
}
