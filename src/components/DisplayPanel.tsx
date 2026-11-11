'use client';

import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { useDisplayStore } from '@/stores/useDisplayStore';
import { useUiStore } from '@/stores/useUiStore';
import { SHADER_PRESETS } from '@/engine/shaders';
import type { DetectionMode, HudLayoutVariant } from '@/types/gev';

export default function DisplayPanel() {
  const cleanView = useDisplayStore((s) => s.cleanView);
  const setCleanView = useDisplayStore((s) => s.setCleanView);
  const style = useDisplayStore((s) => s.style);
  const styleParams = useDisplayStore((s) => s.styleParams);
  const setStyleParam = useDisplayStore((s) => s.setStyleParam);

  const hudVisible = useDisplayStore((s) => s.hudVisible);
  const setHudVisible = useDisplayStore((s) => s.setHudVisible);
  const hudVariant = useDisplayStore((s) => s.hudVariant);
  const setHudVariant = useDisplayStore((s) => s.setHudVariant);

  const detectionMode = useDisplayStore((s) => s.detectionMode);
  const setDetectionMode = useDisplayStore((s) => s.setDetectionMode);
  const detectionDensity = useDisplayStore((s) => s.detectionDensity);
  const setDetectionDensity = useDisplayStore((s) => s.setDetectionDensity);

  const sharpenEnabled = useDisplayStore((s) => s.sharpenEnabled);
  const setSharpenEnabled = useDisplayStore((s) => s.setSharpenEnabled);
  const sharpenIntensity = useDisplayStore((s) => s.sharpenIntensity);
  const setSharpenIntensity = useDisplayStore((s) => s.setSharpenIntensity);

  const bloomEnabled = useDisplayStore((s) => s.bloomEnabled);
  const setBloomEnabled = useDisplayStore((s) => s.setBloomEnabled);
  const bloomIntensity = useDisplayStore((s) => s.bloomIntensity);
  const setBloomIntensity = useDisplayStore((s) => s.setBloomIntensity);

  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useUiStore((s) => s.setRightPanelOpen);

  if (cleanView) return null;

  const activePreset = style === 'normal' ? null : SHADER_PRESETS[style];

  return (
    <aside className="gev-glass fixed right-4 top-28 z-[115] flex max-h-[calc(100vh-195px)] w-64 flex-col rounded-2xl">
      <button
        type="button"
        onClick={() => setRightPanelOpen(!rightPanelOpen)}
        className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 font-mono text-[10px] font-semibold tracking-[0.18em] text-[#cde8ef]">
          <SlidersHorizontal className="h-3.5 w-3.5 text-[#00d4ff]" />
          DISPLAY
        </span>
        {rightPanelOpen ? (
          <ChevronDown className="h-3.5 w-3.5 text-white/50" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-white/50" />
        )}
      </button>

      {rightPanelOpen && (
        <div className="ui-scroll space-y-3 overflow-y-auto border-t border-white/10 px-3.5 py-3 font-mono text-[10px]">
          {/* HUD Controls */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="tracking-[0.14em] text-white/60">INTEL HUD (H)</span>
              <button
                type="button"
                onClick={() => setHudVisible(!hudVisible)}
                className={`rounded px-2 py-0.5 text-[9px] ${
                  hudVisible
                    ? 'bg-[#00d4ff]/20 text-[#00d4ff]'
                    : 'bg-white/10 text-white/50'
                }`}
              >
                {hudVisible ? 'ON' : 'OFF'}
              </button>
            </div>
            {hudVisible && (
              <div className="grid grid-cols-3 gap-1">
                {(['tactical', 'minimal', 'cyber'] as HudLayoutVariant[]).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setHudVariant(v)}
                    className={`rounded py-1 text-[9px] uppercase transition ${
                      hudVariant === v
                        ? 'bg-[#00d4ff]/25 text-[#00d4ff]'
                        : 'bg-white/5 text-white/50 hover:text-white'
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Detection Overlay */}
          <div className="space-y-1.5 border-t border-white/10 pt-2.5">
            <div className="flex items-center justify-between">
              <span className="tracking-[0.14em] text-white/60">DETECTION (D)</span>
            </div>
            <div className="grid grid-cols-3 gap-1">
              {(['OFF', 'SPARSE', 'DENSE'] as DetectionMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setDetectionMode(m)}
                  className={`rounded py-1 text-[9px] transition ${
                    detectionMode === m
                      ? 'bg-[#00d4ff]/25 text-[#00d4ff]'
                      : 'bg-white/5 text-white/50 hover:text-white'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            {detectionMode !== 'OFF' && (
              <label className="flex items-center justify-between gap-2 text-[9px] text-white/60">
                <span>DENSITY</span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={detectionDensity}
                  onChange={(e) => setDetectionDensity(Number(e.target.value))}
                  className="h-1 flex-1 accent-[#00d4ff]"
                />
                <span className="w-7 text-right text-white">{detectionDensity}%</span>
              </label>
            )}
          </div>

          {/* Sharpen & Bloom */}
          <div className="space-y-2 border-t border-white/10 pt-2.5">
            <div className="flex items-center justify-between">
              <span className="tracking-[0.14em] text-white/60">SHARPEN</span>
              <button
                type="button"
                onClick={() => setSharpenEnabled(!sharpenEnabled)}
                className={`rounded px-2 py-0.5 text-[9px] ${
                  sharpenEnabled
                    ? 'bg-[#00d4ff]/20 text-[#00d4ff]'
                    : 'bg-white/10 text-white/50'
                }`}
              >
                {sharpenEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {sharpenEnabled && (
              <input
                type="range"
                min={0}
                max={100}
                value={sharpenIntensity}
                onChange={(e) => setSharpenIntensity(Number(e.target.value))}
                className="h-1 w-full accent-[#00d4ff]"
              />
            )}

            <div className="flex items-center justify-between pt-1">
              <span className="tracking-[0.14em] text-white/60">BLOOM</span>
              <button
                type="button"
                onClick={() => setBloomEnabled(!bloomEnabled)}
                className={`rounded px-2 py-0.5 text-[9px] ${
                  bloomEnabled
                    ? 'bg-[#00d4ff]/20 text-[#00d4ff]'
                    : 'bg-white/10 text-white/50'
                }`}
              >
                {bloomEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            {bloomEnabled && (
              <input
                type="range"
                min={0}
                max={100}
                value={bloomIntensity}
                onChange={(e) => setBloomIntensity(Number(e.target.value))}
                className="h-1 w-full accent-[#00d4ff]"
              />
            )}
          </div>

          {/* Dynamic Uniforms for Active Sensor Shader */}
          {activePreset && (
            <div className="space-y-2 border-t border-white/10 pt-2.5">
              <div className="tracking-[0.14em] text-[#00d4ff]">
                {activePreset.label} OPTICS
              </div>
              {activePreset.uniforms.map((u) => {
                const val = (styleParams[activePreset.id] as Record<string, number>)[
                  u.key
                ];
                return (
                  <label key={u.key} className="block space-y-1">
                    <div className="flex justify-between text-[9px] text-white/65">
                      <span>{u.label.toUpperCase()}</span>
                      <span className="text-white">{Number(val).toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={u.min}
                      max={u.max}
                      step={u.step || 0.05}
                      value={val}
                      onChange={(e) =>
                        setStyleParam(
                          activePreset.id,
                          u.key as never,
                          Number(e.target.value),
                        )
                      }
                      className="h-1 w-full accent-[#00d4ff]"
                    />
                  </label>
                );
              })}
            </div>
          )}

          {/* Clean View Toggle */}
          <button
            type="button"
            onClick={() => setCleanView(true)}
            className="w-full rounded-lg border border-white/15 bg-white/5 py-1.5 text-[9px] tracking-[0.16em] text-white/75 transition hover:border-[#00d4ff]/40 hover:text-white"
          >
            CLEAN VIEW
          </button>
        </div>
      )}
    </aside>
  );
}
