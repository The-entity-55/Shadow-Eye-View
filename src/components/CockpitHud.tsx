'use client';

import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Navigation,
  Plane,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react';
import {
  LOOK_REST_PITCH_DEG,
  formatCockpitLookLabel,
  lookIsOffset,
} from '@/engine/cockpitLook';
import { getGlobeEngine } from '@/engine/engineBridge';
import { useDisplayStore } from '@/stores/useDisplayStore';
import { useHudStore } from '@/stores/useHudStore';

export default function CockpitHud() {
  const cockpitMode = useDisplayStore((s) => s.cockpitMode);
  const setCockpitMode = useDisplayStore((s) => s.setCockpitMode);
  const selectedEntity = useHudStore((s) => s.selectedEntity);
  const nearbyContacts = useHudStore((s) => s.nearbyContacts);
  const requestTrackEntity = useHudStore((s) => s.requestTrackEntity);
  const cockpitLook = useHudStore((s) => s.cockpitLook);

  if (!cockpitMode || !selectedEntity) return null;

  const lookOffset = lookIsOffset(cockpitLook, LOOK_REST_PITCH_DEG);
  const lookReadout = formatCockpitLookLabel(cockpitLook, LOOK_REST_PITCH_DEG);

  const route = selectedEntity.flightRoute;
  const prediction = selectedEntity.flightPrediction;
  const hasDestBearing =
    typeof route?.destBearingDeg === 'number' &&
    typeof route?.relBearingDeg === 'number';
  const clampedRelDeg = hasDestBearing
    ? Math.max(-120, Math.min(120, route!.relBearingDeg!))
    : 0;

  return (
    <div className="pointer-events-none fixed inset-0 z-[130]">
      {/* Center Artificial Horizon / Gun Sight */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-60">
        <div className="flex h-20 w-36 items-center justify-center border-x border-[#00d4ff]/40">
          <div className="h-px w-8 bg-[#00d4ff]/70" />
          <div className="mx-3 h-2 w-2 rounded-full border border-[#00d4ff]" />
          <div className="h-px w-8 bg-[#00d4ff]/70" />
        </div>
      </div>

      {/* Top Cockpit Flight Banner */}
      <div className="gev-glass pointer-events-auto absolute left-1/2 top-14 flex -translate-x-1/2 items-center gap-4 rounded-xl border-[#00d4ff]/40 px-4 py-2 font-mono">
        <Plane className="h-4 w-4 text-[#00d4ff]" />
        <div>
          <div className="text-xs font-semibold tracking-[0.16em] text-white">
            COCKPIT RIDE · {selectedEntity.title}
          </div>
          <div className="text-[10px] tracking-[0.12em] text-[#00d4ff]/80">
            {selectedEntity.telemetry.slice(1, 4).map((t) => `${t.label}: ${t.value}`).join(' · ')}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setCockpitMode(false)}
          className="ml-2 flex items-center gap-1 rounded-md border border-red-400/40 bg-red-500/15 px-2.5 py-1 text-[10px] tracking-[0.12em] text-red-200 transition hover:bg-red-500/30"
        >
          <X className="h-3 w-3" />
          EXIT COCKPIT
        </button>
      </div>

      {/* Upstream-style Estimated Flight Plan + Destination Bearing Chevron */}
      {(route?.origin || route?.destination || prediction) && (
        <div className="gev-glass pointer-events-none absolute left-1/2 top-32 flex -translate-x-1/2 items-center gap-3 rounded-xl border-emerald-400/30 px-3.5 py-1.5 font-mono text-[10px]">
          {(route?.origin || route?.destination) && (
            <div className="flex items-center gap-2 text-emerald-200">
              <span className="text-[9px] tracking-[0.14em] text-emerald-400/80">
                ESTIMATED FLIGHT PLAN
              </span>
              <strong className="tracking-[0.1em] text-white">
                {route?.origin?.code || '---'} → {route?.destination?.code || '---'}
              </strong>
            </div>
          )}
          {hasDestBearing && (
            <div className="flex items-center gap-1.5 border-l border-white/15 pl-2.5 text-[#00d4ff]">
              <Navigation
                className="h-3.5 w-3.5 transition-transform"
                style={{ transform: `rotate(${clampedRelDeg.toFixed(1)}deg)` }}
              />
              <span>DEST {String(Math.round(route!.destBearingDeg!)).padStart(3, '0')}°</span>
            </div>
          )}
          {prediction && (
            <div className="flex items-center gap-1.5 border-l border-white/15 pl-2.5 text-purple-200">
              <Sparkles className="h-3 w-3 text-purple-300" />
              <span>
                {prediction.phase}
                {prediction.etaMin ? ` · ETA ~${prediction.etaMin}m` : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Cockpit Gimbal / Look Control Pad (Arrow keys / WASD / Drag / Home) */}
      <div className="gev-glass pointer-events-auto fixed bottom-24 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-xl border-[#00d4ff]/30 px-3 py-2 font-mono">
        <div className="grid grid-cols-3 gap-0.5">
          <div />
          <button
            type="button"
            onClick={(e) => getGlobeEngine()?.stepCockpitLook('pitch', 1, e.shiftKey)}
            title="Look Up (↑ / W)"
            className="flex h-6 w-6 items-center justify-center rounded border border-white/15 bg-white/5 text-white/85 transition hover:border-[#00d4ff]/60 hover:text-[#00d4ff]"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <div />
          <button
            type="button"
            onClick={(e) => getGlobeEngine()?.stepCockpitLook('yaw', -1, e.shiftKey)}
            title="Look Left (← / A)"
            className="flex h-6 w-6 items-center justify-center rounded border border-white/15 bg-white/5 text-white/85 transition hover:border-[#00d4ff]/60 hover:text-[#00d4ff]"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => getGlobeEngine()?.resetCockpitLook()}
            title="Center Look Ahead (Home / 0)"
            className={`flex h-6 w-6 items-center justify-center rounded border transition ${
              lookOffset
                ? 'border-[#00d4ff]/60 bg-[#00d4ff]/20 text-[#00d4ff] hover:bg-[#00d4ff]/30'
                : 'border-white/10 bg-white/[0.03] text-white/40 hover:text-white/80'
            }`}
          >
            <RotateCcw className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => getGlobeEngine()?.stepCockpitLook('yaw', 1, e.shiftKey)}
            title="Look Right (→ / D)"
            className="flex h-6 w-6 items-center justify-center rounded border border-white/15 bg-white/5 text-white/85 transition hover:border-[#00d4ff]/60 hover:text-[#00d4ff]"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <div />
          <button
            type="button"
            onClick={(e) => getGlobeEngine()?.stepCockpitLook('pitch', -1, e.shiftKey)}
            title="Look Down (↓ / S)"
            className="flex h-6 w-6 items-center justify-center rounded border border-white/15 bg-white/5 text-white/85 transition hover:border-[#00d4ff]/60 hover:text-[#00d4ff]"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <div />
        </div>
        <div className="min-w-[140px] space-y-0.5 text-[9px]">
          <div className="tracking-[0.14em] text-[#00d4ff]">
            VIEW: <span className="text-white">{lookReadout}</span>
          </div>
          <div className="text-[8px] tracking-[0.1em] text-white/50">
            ARROWS · WASD · DRAG · HOME
          </div>
        </div>
      </div>

      {/* 250 km Nearby Contacts Roster */}
      {nearbyContacts.length > 0 && (
        <aside className="gev-glass pointer-events-auto fixed bottom-28 right-4 w-64 rounded-xl p-3 font-mono">
          <div className="mb-2 flex items-center justify-between border-b border-white/10 pb-1.5 text-[10px] tracking-[0.15em] text-[#00d4ff]">
            <span>CONTACTS (250 KM)</span>
            <span>{nearbyContacts.length}</span>
          </div>
          <div className="ui-scroll max-h-52 space-y-1 overflow-y-auto pr-1">
            {nearbyContacts.map((c) => {
              const active = c.entityId === selectedEntity.entityId;
              return (
                <button
                  key={c.entityId}
                  type="button"
                  onClick={() => requestTrackEntity(c.entityId, true)}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[10px] transition ${
                    active
                      ? 'bg-[#00d4ff]/20 text-[#00d4ff]'
                      : 'text-white/75 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <span className="truncate font-semibold">
                    {c.kind === 'military' ? '▲ ' : ''}
                    {c.callsign}
                  </span>
                  <span className="ml-2 shrink-0 text-[9px] text-white/50">
                    {Math.round(c.distKm)}km · {c.speedKts}kt
                  </span>
                </button>
              );
            })}
          </div>
        </aside>
      )}
    </div>
  );
}
