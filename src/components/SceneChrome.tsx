'use client';

import { useEffect, useState } from 'react';
import { Compass, Globe, Orbit, Sparkles } from 'lucide-react';
import { useDisplayStore } from '@/stores/useDisplayStore';
import { useHudStore } from '@/stores/useHudStore';
import { useLocationStore } from '@/stores/useLocationStore';
import { useUiStore } from '@/stores/useUiStore';
import { SHADER_PRESETS } from '@/engine/shaders';

export default function SceneChrome() {
  const style = useDisplayStore((s) => s.style);
  const cleanView = useDisplayStore((s) => s.cleanView);
  const autoOrbit = useDisplayStore((s) => s.autoOrbit);
  const setAutoOrbit = useDisplayStore((s) => s.setAutoOrbit);
  const setCleanView = useDisplayStore((s) => s.setCleanView);

  const fps = useHudStore((s) => s.fps);
  const showFps = useHudStore((s) => s.showFps);

  const tiltMode = useLocationStore((s) => s.tiltMode);
  const toggleTiltMode = useLocationStore((s) => s.toggleTiltMode);
  const triggerNorthUp = useLocationStore((s) => s.triggerNorthUp);
  const triggerResetGlobe = useLocationStore((s) => s.triggerResetGlobe);

  const loadingVisible = useUiStore((s) => s.loadingVisible);
  const loadingStatus = useUiStore((s) => s.loadingStatus);
  const loadingError = useUiStore((s) => s.loadingError);
  const toast = useUiStore((s) => s.toast);
  const configured = useUiStore((s) => s.configuredProviders);
  const setProviderSettingsOpen = useUiStore((s) => s.setProviderSettingsOpen);
  const setWelcomeVisible = useUiStore((s) => s.setWelcomeVisible);

  const [visibleToast, setVisibleToast] = useState<typeof toast>(null);

  useEffect(() => {
    if (!toast) return;
    setVisibleToast(toast);
    const id = window.setTimeout(() => {
      setVisibleToast((cur) => (cur?.nonce === toast.nonce ? null : cur));
    }, 3200);
    return () => clearTimeout(id);
  }, [toast]);

  const anyPowered =
    configured.googleMaps ||
    configured.cesiumIon ||
    configured.opensky ||
    configured.aisstream;
  const activeStyleLabel = style === 'normal' ? 'NORMAL' : SHADER_PRESETS[style].label;

  return (
    <>
      {/* Loading Screen */}
      {loadingVisible && (
        <div
          id="loading-screen"
          className="fixed inset-0 z-[500] flex flex-col items-center justify-center bg-[#0a0a0f]"
        >
          <img src="/logo.svg" alt="" className="mb-4 h-16 w-24 opacity-95" />
          <h2 className="font-mono text-xl font-semibold tracking-[0.26em] text-white">
            GOD&apos;S EYE <span className="text-[#00d4ff]">VIEW</span>
          </h2>
          <p
            className={`mt-2 font-mono text-xs tracking-[0.14em] ${
              loadingError ? 'text-red-400' : 'text-[#00d4ff]/80'
            }`}
          >
            {loadingError ? `Error: ${loadingError}` : loadingStatus}
          </p>
        </div>
      )}

      {/* Clean View Exit Pill */}
      {cleanView && (
        <button
          type="button"
          onClick={() => setCleanView(false)}
          className="gev-glass fixed right-4 top-4 z-[220] rounded-lg px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] text-[#00d4ff] transition hover:border-[#00d4ff]/60"
        >
          EXIT CLEAN VIEW
        </button>
      )}

      {!cleanView && (
        <>
          {/* Top-Left Brand Title Bar */}
          <header className="pointer-events-none fixed left-4 top-3.5 z-[110] flex items-center gap-3">
            <img src="/logo.svg" alt="God's Eye View" className="h-8 w-12 drop-shadow-[0_0_12px_rgba(0,212,255,0.45)]" />
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="font-mono text-sm font-semibold tracking-[0.22em] text-white">
                  GOD&apos;S EYE <span className="text-[#00d4ff]">VIEW</span>
                </h1>
                {showFps && (
                  <span className="rounded border border-[#00d4ff]/30 bg-[#00d4ff]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#00d4ff]">
                    {fps} FPS
                  </span>
                )}
              </div>
              <p className="font-mono text-[9px] tracking-[0.2em] text-white/45">
                NO PLACE LEFT BEHIND · {activeStyleLabel}
              </p>
            </div>
          </header>

          {/* Top-Right Camera Action Bar */}
          <div className="fixed right-4 top-3.5 z-[110] flex items-center gap-1.5">
            {autoOrbit && (
              <span className="mr-1 animate-pulse font-mono text-[10px] tracking-[0.18em] text-[#00d4ff]">
                ● ORBIT
              </span>
            )}
            <button
              type="button"
              onClick={() => setAutoOrbit(!autoOrbit)}
              title="Toggle gentle camera orbit"
              className={`gev-glass flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-[10px] tracking-[0.12em] transition ${
                autoOrbit
                  ? 'border-[#00d4ff]/60 text-[#00d4ff]'
                  : 'text-white/75 hover:border-white/25 hover:text-white'
              }`}
            >
              <Orbit className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">ORBIT</span>
            </button>
            <button
              type="button"
              onClick={toggleTiltMode}
              title="Toggle 35° Oblique vs Top-Down Nadir"
              className="gev-glass flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-[10px] tracking-[0.12em] text-white/75 transition hover:border-white/25 hover:text-white"
            >
              <Compass className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">
                {tiltMode === 'oblique' ? '35° TILT' : 'NADIR'}
              </span>
            </button>
            <button
              type="button"
              onClick={triggerNorthUp}
              title="Snap heading to North Up"
              className="gev-glass rounded-lg px-2.5 py-1.5 font-mono text-[10px] tracking-[0.12em] text-white/75 transition hover:border-white/25 hover:text-white"
            >
              N↑
            </button>
            <button
              type="button"
              onClick={triggerResetGlobe}
              title="Zoom out to full globe view"
              className="gev-glass flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-[10px] tracking-[0.12em] text-white/75 transition hover:border-[#00d4ff]/45 hover:text-[#00d4ff]"
            >
              <Globe className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">RESET GLOBE</span>
            </button>
            <button
              type="button"
              onClick={() => setWelcomeVisible(true)}
              title="Open Mission Launcher"
              className="gev-glass rounded-lg px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] text-white/60 transition hover:border-white/25 hover:text-white"
            >
              MISSIONS
            </button>
          </div>

          {/* Bottom-Right POWER UP / Provider Settings Chip */}
          <button
            type="button"
            onClick={() => setProviderSettingsOpen(true)}
            className={`gev-glass fixed bottom-3 right-3.5 z-[120] flex items-center gap-1.5 rounded-full px-3 py-1.5 font-mono text-[10px] tracking-[0.14em] transition ${
              anyPowered
                ? 'border-emerald-400/40 text-emerald-300 hover:border-emerald-400/70'
                : 'border-[#00d4ff]/40 text-[#00d4ff] hover:border-[#00d4ff]/75'
            }`}
          >
            <Sparkles className="h-3 w-3" />
            <span>{anyPowered ? 'POWERED UP' : 'POWER UP'}</span>
          </button>
        </>
      )}

      {/* Toast Notification */}
      {visibleToast && (
        <div
          role="status"
          className={`gev-glass fixed left-1/2 top-16 z-[300] -translate-x-1/2 rounded-lg px-3.5 py-1.5 font-mono text-[11px] tracking-[0.1em] ${
            visibleToast.tone === 'error'
              ? 'border-red-400/50 text-red-200'
              : visibleToast.tone === 'warn'
                ? 'border-amber-400/50 text-amber-200'
                : 'border-[#00d4ff]/45 text-[#e8eaed]'
          }`}
        >
          {visibleToast.text}
        </div>
      )}
    </>
  );
}
