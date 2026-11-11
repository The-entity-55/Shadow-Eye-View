'use client';

import { useDisplayStore } from '@/stores/useDisplayStore';
import { useHudStore } from '@/stores/useHudStore';
import { useLayerStore } from '@/stores/useLayerStore';
import { hudPaletteForStyle } from '@/engine/hudMath';
import { SHADER_PRESETS } from '@/engine/shaders';

export default function IntelHud() {
  const hudVisible = useDisplayStore((s) => s.hudVisible);
  const hudVariant = useDisplayStore((s) => s.hudVariant);
  const style = useDisplayStore((s) => s.style);
  const cleanView = useDisplayStore((s) => s.cleanView);

  const mgrs = useHudStore((s) => s.mgrs);
  const latlonText = useHudStore((s) => s.latlonText);
  const gsdText = useHudStore((s) => s.gsdText);
  const altText = useHudStore((s) => s.altText);
  const collText = useHudStore((s) => s.collText);
  const onaText = useHudStore((s) => s.onaText);
  const utcTimestamp = useHudStore((s) => s.utcTimestamp);
  const regionLabel = useHudStore((s) => s.regionLabel);
  const selectedEntity = useHudStore((s) => s.selectedEntity);

  const layers = useLayerStore((s) => s.layers);

  if (!hudVisible || cleanView) return null;

  const palette = hudPaletteForStyle(style);
  const modeLabel =
    style === 'normal' ? 'NORMAL' : SHADER_PRESETS[style].label;
  const activeCount = Object.values(layers).filter((l) => l.enabled).length;
  const liveSignals = Object.values(layers)
    .filter((l) => l.enabled && l.count > 0)
    .map((l) => `${l.name.split(' ')[0].toUpperCase()} ${l.count}`)
    .slice(0, 3)
    .join(' · ');

  const hudStyleVars = {
    color: palette.color,
    textShadow: `0 0 6px ${palette.glow}`,
  };

  return (
    <div
      id="intel-hud"
      className="pointer-events-none fixed inset-0 z-[2] font-mono uppercase transition-opacity duration-300"
      style={hudStyleVars}
    >
      {/* Top-Left Corner */}
      <div className="absolute left-3.5 top-16 flex items-start gap-2 text-[10px] leading-relaxed tracking-[0.14em]">
        <span className="text-lg leading-none opacity-80">┌</span>
        <div className="space-y-0.5">
          {hudVariant === 'tactical' && (
            <>
              <div className="font-semibold tracking-[0.18em]">
                UNCLASSIFIED // OSINT TELEMETRY
              </div>
              <div className="opacity-75">GEV-ORB // LIVE SENSOR FEED</div>
            </>
          )}
          <div>
            OPTICS: {modeLabel} · {activeCount} ACTIVE FEEDS
          </div>
          {hudVariant !== 'minimal' && (
            <div className="max-w-[340px] truncate opacity-80">
              {selectedEntity
                ? `LOCK: ${selectedEntity.title} · ${selectedEntity.subtitle}`
                : liveSignals || `${regionLabel} · STANDBY`}
            </div>
          )}
        </div>
      </div>

      {/* Top-Right Corner */}
      <div className="absolute right-3.5 top-16 flex items-start gap-2 text-right text-[10px] leading-relaxed tracking-[0.14em]">
        <div className="space-y-0.5">
          <div className="flex items-center justify-end gap-1.5 font-semibold">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500 shadow-[0_0_8px_#ef4444]" />
            <span>REC</span>
            <span className="ml-1">{utcTimestamp}</span>
          </div>
          {hudVariant === 'tactical' && (
            <div className="opacity-75">{regionLabel}</div>
          )}
        </div>
        <span className="text-lg leading-none opacity-80">┐</span>
      </div>

      {/* Bottom-Left Corner */}
      <div className="absolute bottom-7 left-3.5 flex items-end gap-2 text-[10px] leading-relaxed tracking-[0.14em]">
        <span className="text-lg leading-none opacity-80">└</span>
        <div className="space-y-0.5">
          <div className="font-semibold">MGRS {mgrs}</div>
          <div className="opacity-85">{latlonText}</div>
        </div>
      </div>

      {/* Bottom-Right Corner */}
      <div className="absolute bottom-7 right-3.5 flex items-end gap-2 text-right text-[10px] leading-relaxed tracking-[0.14em]">
        <div className="space-y-0.5">
          <div className="opacity-85">{gsdText}</div>
          <div className="font-semibold">{altText}</div>
        </div>
        <span className="text-lg leading-none opacity-80">┘</span>
      </div>

      {/* Left & Right Vertical Edge Telemetry (Tactical & Cyber variants) */}
      {hudVariant !== 'minimal' && (
        <>
          <div
            className="absolute left-3 top-1/2 hidden -translate-y-1/2 text-[9px] tracking-[0.18em] opacity-65 md:block"
            style={{ writingMode: 'vertical-rl', transform: 'translateY(-50%) rotate(180deg)' }}
          >
            {collText} · {onaText}
          </div>
          <div
            className="absolute right-3 top-1/2 hidden -translate-y-1/2 text-[9px] tracking-[0.18em] opacity-65 md:block"
            style={{ writingMode: 'vertical-rl' }}
          >
            WGS84 // SGP4 // ADS-B // BAND EO-IR
          </div>
        </>
      )}
    </div>
  );
}
