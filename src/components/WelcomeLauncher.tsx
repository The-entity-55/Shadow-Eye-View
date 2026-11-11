'use client';

import { useState } from 'react';
import { Activity, ArrowRight, Globe, Radar, Rocket } from 'lucide-react';
import { useLayerStore } from '@/stores/useLayerStore';
import { useLocationStore } from '@/stores/useLocationStore';
import { useUiStore } from '@/stores/useUiStore';

export default function WelcomeLauncher() {
  const welcomeVisible = useUiStore((s) => s.welcomeVisible);
  const loadingVisible = useUiStore((s) => s.loadingVisible);
  const configuredProviders = useUiStore((s) => s.configuredProviders);
  const dismissWelcome = useUiStore((s) => s.dismissWelcome);
  const setLeftPanelOpen = useUiStore((s) => s.setLeftPanelOpen);

  const setLayersEnabled = useLayerStore((s) => s.setLayersEnabled);
  const triggerResetGlobe = useLocationStore((s) => s.triggerResetGlobe);

  const [suppress, setSuppress] = useState(false);

  if (!welcomeVisible || loadingVisible) return null;

  function chooseMission(mission: 'contacts' | 'space' | 'environmental' | 'explore') {
    setLeftPanelOpen(true);
    if (mission === 'contacts') {
      setLayersEnabled({
        flights: true,
        military: true,
        vessels: configuredProviders.aisstream,
        traffic: configuredProviders.tomtom,
        cctv: true,
        satellites: false,
        earthquakes: false,
      });
    } else if (mission === 'space') {
      setLayersEnabled({
        satellites: true,
        flights: false,
        military: false,
        vessels: false,
        traffic: false,
        cctv: false,
        earthquakes: false,
      });
      triggerResetGlobe();
    } else if (mission === 'environmental') {
      setLayersEnabled({
        earthquakes: true,
        flights: false,
        military: false,
        vessels: false,
        traffic: false,
        satellites: false,
        cctv: false,
      });
      triggerResetGlobe();
    }
    dismissWelcome(suppress);
  }

  return (
    <div className="fixed inset-0 z-[260] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <aside
        role="dialog"
        aria-labelledby="first-run-title"
        className="gev-glass relative w-full max-w-lg overflow-hidden rounded-2xl border-[#00d4ff]/35 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.8)]"
      >
        <div className="gev-scanline pointer-events-none absolute inset-x-0 top-0 h-24" />
        <div className="font-mono text-[10px] tracking-[0.22em] text-[#00d4ff]">
          MISSION CONTROL · FIRST LAUNCH
        </div>
        <h2
          id="first-run-title"
          className="mt-1 text-xl font-semibold tracking-tight text-white"
        >
          Choose your first view
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-white/65">
          It feels like a forbidden cockpit—then you realize the sources are
          public and the data is real.
        </p>

        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => chooseMission('contacts')}
            className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-left transition hover:border-[#00d4ff]/60 hover:bg-[#00d4ff]/10"
          >
            <Radar className="h-5 w-5 shrink-0 text-[#00d4ff]" />
            <div className="flex-1">
              <div className="font-mono text-xs font-semibold tracking-[0.12em] text-white">
                LIVE CONTACTS
              </div>
              <div className="text-[11px] text-white/55">
                Civil &amp; military ADS-B flights and live CCTV camera mesh
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-white/40" />
          </button>

          <button
            type="button"
            onClick={() => chooseMission('space')}
            className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-left transition hover:border-[#00d4ff]/60 hover:bg-[#00d4ff]/10"
          >
            <Rocket className="h-5 w-5 shrink-0 text-purple-400" />
            <div className="flex-1">
              <div className="font-mono text-xs font-semibold tracking-[0.12em] text-white">
                SPACE MISSIONS
              </div>
              <div className="text-[11px] text-white/55">
                Real-time SGP4 orbital propagation from CelesTrak TLE catalogs
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-white/40" />
          </button>

          <button
            type="button"
            onClick={() => chooseMission('environmental')}
            className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-3 text-left transition hover:border-[#00d4ff]/60 hover:bg-[#00d4ff]/10"
          >
            <Activity className="h-5 w-5 shrink-0 text-amber-400" />
            <div className="flex-1">
              <div className="font-mono text-xs font-semibold tracking-[0.12em] text-white">
                ENVIRONMENTAL
              </div>
              <div className="text-[11px] text-white/55">
                Global 24h seismic activity from USGS M2.5+ live GeoJSON
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-white/40" />
          </button>

          <button
            type="button"
            onClick={() => chooseMission('explore')}
            className="flex w-full items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3.5 py-2.5 text-left transition hover:border-white/30 hover:bg-white/[0.06]"
          >
            <Globe className="h-5 w-5 shrink-0 text-white/60" />
            <div className="flex-1">
              <div className="font-mono text-xs font-semibold tracking-[0.12em] text-white/90">
                EXPLORE MANUALLY
              </div>
              <div className="text-[11px] text-white/50">
                Begin with a clean globe
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-white/40" />
          </button>
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-[11px]">
          <label className="flex cursor-pointer items-center gap-2 text-white/60">
            <input
              type="checkbox"
              checked={suppress}
              onChange={(e) => setSuppress(e.target.checked)}
              className="accent-[#00d4ff]"
            />
            <span>Don&apos;t show this again</span>
          </label>
          <button
            type="button"
            onClick={() => dismissWelcome(suppress)}
            className="font-mono text-[10px] tracking-[0.12em] text-white/50 hover:text-white"
          >
            ESC TO DISMISS
          </button>
        </div>

        <p className="mt-2 font-mono text-[10px] text-[#00d4ff]/75">
          Keys: 1–6 sensor styles · H HUD · D detection · C CCTV · ` FPS
        </p>
      </aside>
    </div>
  );
}
