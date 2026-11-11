'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  Car,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Layers,
  Plane,
  Radio,
  RefreshCw,
  Route,
  Satellite,
  ShieldAlert,
  Ship,
  Sparkles,
  Video,
  X,
} from 'lucide-react';
import { useDisplayStore } from '@/stores/useDisplayStore';
import { useHudStore } from '@/stores/useHudStore';
import { useLayerStore } from '@/stores/useLayerStore';
import { useUiStore } from '@/stores/useUiStore';
import { getGlobeEngine } from '@/engine/engineBridge';
import type {
  CctvCoverageMode,
  LayerCategory,
  LayerId,
  SatelliteClassKey,
} from '@/types/gev';

const CATEGORY_ORDER: LayerCategory[] = ['Movement', 'Space', 'Cameras', 'Events'];

const LAYER_ORDER: LayerId[] = [
  'flights',
  'military',
  'vessels',
  'traffic',
  'satellites',
  'cctv',
  'earthquakes',
];

const LAYER_ICONS: Record<LayerId, typeof Plane> = {
  flights: Plane,
  military: ShieldAlert,
  vessels: Ship,
  traffic: Car,
  satellites: Satellite,
  cctv: Video,
  earthquakes: Activity,
};

const SAT_CLASS_LABELS: Array<{ key: SatelliteClassKey; label: string }> = [
  { key: 'stations', label: 'Stations' },
  { key: 'imaging', label: 'Imaging' },
  { key: 'telecom', label: 'Telecom' },
  { key: 'probes', label: 'Probes' },
  { key: 'starlink', label: 'Starlink' },
];

export default function LayerPanels() {
  const cleanView = useDisplayStore((s) => s.cleanView);
  const models3dMode = useDisplayStore((s) => s.models3dMode);
  const setModels3dMode = useDisplayStore((s) => s.setModels3dMode);
  const setCockpitMode = useDisplayStore((s) => s.setCockpitMode);

  const layers = useLayerStore((s) => s.layers);
  const toggleLayer = useLayerStore((s) => s.toggleLayer);
  const cctvCoverageMode = useLayerStore((s) => s.cctvCoverageMode);
  const setCctvCoverageMode = useLayerStore((s) => s.setCctvCoverageMode);
  const satelliteClasses = useLayerStore((s) => s.satelliteClasses);
  const toggleSatelliteClass = useLayerStore((s) => s.toggleSatelliteClass);

  const selectedEntity = useHudStore((s) => s.selectedEntity);
  const routeOverviewActive = useHudStore((s) => s.routeOverviewActive);
  const leftPanelOpen = useUiStore((s) => s.leftPanelOpen);
  const setLeftPanelOpen = useUiStore((s) => s.setLeftPanelOpen);
  const setProviderSettingsOpen = useUiStore((s) => s.setProviderSettingsOpen);

  const [frameTick, setFrameTick] = useState(0);

  // Auto-refresh live CCTV snapshot every 12s while a camera is selected
  useEffect(() => {
    if (!selectedEntity?.cctvId) return;
    setFrameTick((t) => t + 1);
    const id = window.setInterval(() => setFrameTick((t) => t + 1), 12_000);
    return () => clearInterval(id);
  }, [selectedEntity?.cctvId]);

  if (cleanView) return null;

  const activeCount = Object.values(layers).filter((l) => l.enabled).length;

  return (
    <div className="fixed left-4 top-28 z-[115] flex max-h-[calc(100vh-195px)] w-72 flex-col gap-2.5">
      {/* Data Layers Collapsible Glass Panel */}
      <section className="gev-glass flex min-h-0 flex-col rounded-2xl">
        <button
          type="button"
          onClick={() => setLeftPanelOpen(!leftPanelOpen)}
          className="flex w-full items-center justify-between px-3.5 py-2.5 text-left"
        >
          <span className="flex items-center gap-2 font-mono text-[10px] font-semibold tracking-[0.18em] text-[#cde8ef]">
            <Layers className="h-3.5 w-3.5 text-[#00d4ff]" />
            DATA LAYERS
            {activeCount > 0 && (
              <span className="rounded bg-[#00d4ff]/20 px-1.5 py-0.5 text-[9px] text-[#00d4ff]">
                {activeCount}
              </span>
            )}
          </span>
          {leftPanelOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-white/50" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-white/50" />
          )}
        </button>

        {leftPanelOpen && (
          <div className="ui-scroll space-y-3 overflow-y-auto border-t border-white/10 px-3 py-2.5">
            {CATEGORY_ORDER.map((category) => {
              const catLayers = LAYER_ORDER.map((id) => layers[id]).filter(
                (l) => l.category === category,
              );
              if (!catLayers.length) return null;
              return (
                <div key={category} className="space-y-1.5">
                  <div className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/40">
                    {category}
                  </div>
                  {catLayers.map((layer) => {
                    const Icon = LAYER_ICONS[layer.id];
                    return (
                      <div
                        key={layer.id}
                        className={`rounded-xl border px-2.5 py-2 transition ${
                          layer.enabled
                            ? 'border-[#00d4ff]/35 bg-[#00d4ff]/[0.07]'
                            : 'border-white/5 bg-white/[0.02] hover:border-white/15'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => toggleLayer(layer.id)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            <Icon
                              className={`h-3.5 w-3.5 shrink-0 ${
                                layer.enabled
                                  ? layer.id === 'military'
                                    ? 'text-amber-400'
                                    : 'text-[#00d4ff]'
                                  : 'text-white/45'
                              }`}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-xs font-medium text-white">
                                {layer.name}
                              </div>
                              <div className="truncate font-mono text-[9px] text-white/45">
                                {layer.sourceLabel}
                              </div>
                            </div>
                          </button>

                          <div className="flex shrink-0 items-center gap-1.5">
                            {layer.enabled && (
                              <span
                                className={`rounded px-1.5 py-0.5 font-mono text-[9px] ${
                                  layer.status === 'ERROR'
                                    ? 'bg-red-500/20 text-red-300'
                                    : layer.status === 'STALE'
                                      ? 'bg-amber-500/20 text-amber-300'
                                      : layer.loading
                                        ? 'bg-[#00d4ff]/20 text-[#00d4ff]'
                                        : 'bg-emerald-500/15 text-emerald-300'
                                }`}
                              >
                                {layer.loading ? 'SYNC' : layer.count.toLocaleString()}
                              </span>
                            )}
                            <button
                              type="button"
                              aria-pressed={layer.enabled}
                              onClick={() => toggleLayer(layer.id)}
                              className={`relative h-4 w-7 rounded-full transition ${
                                layer.enabled ? 'bg-[#00d4ff]' : 'bg-white/15'
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 h-3 w-3 rounded-full bg-[#0a0a0f] transition ${
                                  layer.enabled ? 'left-3.5' : 'left-0.5'
                                }`}
                              />
                            </button>
                          </div>
                        </div>

                        {layer.error && layer.enabled && (
                          <div className="mt-1 flex items-center justify-between gap-2">
                            <p className="font-mono text-[9px] text-red-300/90">
                              {layer.error}
                            </p>
                            {(layer.error.includes('AISSTREAM_API_KEY') ||
                              layer.error.includes('TOMTOM_API_KEY')) && (
                              <button
                                type="button"
                                onClick={() => setProviderSettingsOpen(true)}
                                className="shrink-0 rounded border border-[#00d4ff]/45 bg-[#00d4ff]/15 px-1.5 py-0.5 font-mono text-[8px] tracking-[0.1em] text-[#00d4ff] hover:bg-[#00d4ff]/25"
                              >
                                POWER UP
                              </button>
                            )}
                          </div>
                        )}

                        {/* Sub-info for Traffic */}
                        {layer.id === 'traffic' && layer.enabled && !layer.error && (
                          <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/10 pt-1.5 font-mono text-[8px]">
                            <div className="flex items-center gap-2 text-white/60">
                              <span className="flex items-center gap-1">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#2ecc71]" />
                                FREE
                              </span>
                              <span className="flex items-center gap-1">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#f0b23e]" />
                                SLOW
                              </span>
                              <span className="flex items-center gap-1">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#e05252]" />
                                JAM
                              </span>
                            </div>
                            {layer.sourceLabel.includes('Zoom') && (
                              <button
                                type="button"
                                onClick={() => {
                                  const { lat, lon } = useHudStore.getState();
                                  getGlobeEngine()?.flyTo(lat, lon, 2_400, 0, -45);
                                }}
                                className="rounded border border-[#00d4ff]/45 bg-[#00d4ff]/15 px-1.5 py-0.5 text-[8px] text-[#00d4ff] hover:bg-[#00d4ff]/25"
                              >
                                ZOOM STREET
                              </button>
                            )}
                          </div>
                        )}

                        {/* Sub-options for Flights */}
                        {layer.id === 'flights' && layer.enabled && (
                          <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-1.5 font-mono text-[9px]">
                            <span className="text-white/50">3D MODELS</span>
                            <div className="flex gap-1">
                              {(['proximity', 'all', 'off'] as const).map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  onClick={() => setModels3dMode(m)}
                                  className={`rounded px-1.5 py-0.5 uppercase ${
                                    models3dMode === m
                                      ? 'bg-[#00d4ff]/25 text-[#00d4ff]'
                                      : 'text-white/50 hover:text-white'
                                  }`}
                                >
                                  {m === 'proximity' ? 'PROX' : m}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Sub-options for Satellites */}
                        {layer.id === 'satellites' && layer.enabled && (
                          <div className="mt-2 flex flex-wrap gap-1 border-t border-white/10 pt-1.5">
                            {SAT_CLASS_LABELS.map((c) => {
                              const on = satelliteClasses[c.key];
                              return (
                                <button
                                  key={c.key}
                                  type="button"
                                  onClick={() => toggleSatelliteClass(c.key)}
                                  className={`rounded px-1.5 py-0.5 font-mono text-[9px] transition ${
                                    on
                                      ? 'bg-[#00d4ff]/20 text-[#00d4ff]'
                                      : 'bg-white/5 text-white/40 hover:text-white/75'
                                  }`}
                                >
                                  {c.label}
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {/* Sub-options for CCTV */}
                        {layer.id === 'cctv' && layer.enabled && (
                          <div className="mt-2 flex items-center justify-between border-t border-white/10 pt-1.5 font-mono text-[9px]">
                            <span className="text-white/50">COVERAGE</span>
                            <div className="flex gap-1">
                              {(['off', 'on', 'viewshed'] as CctvCoverageMode[]).map((m) => (
                                <button
                                  key={m}
                                  type="button"
                                  onClick={() => setCctvCoverageMode(m)}
                                  className={`rounded px-1.5 py-0.5 uppercase ${
                                    cctvCoverageMode === m
                                      ? 'bg-[#00d4ff]/25 text-[#00d4ff]'
                                      : 'text-white/50 hover:text-white'
                                  }`}
                                >
                                  {m}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Selected Target Telemetry & Live CCTV Card */}
      {selectedEntity && (
        <section className="gev-glass ui-scroll max-h-[54vh] overflow-y-auto rounded-2xl border-[#00d4ff]/40 p-3 font-mono">
          <div className="mb-2 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[9px] tracking-[0.16em] text-[#00d4ff]">
                TRACKING LOCK
              </div>
              <div className="truncate text-xs font-semibold text-white">
                {selectedEntity.title}
              </div>
              <div className="truncate text-[9px] text-white/55">
                {selectedEntity.subtitle}
              </div>
            </div>
            <button
              type="button"
              onClick={() => getGlobeEngine()?.clearSelection()}
              title="Release tracking lock (Esc)"
              className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Live CCTV Frame Preview */}
          {selectedEntity.cctvId && (
            <div className="mb-2.5 overflow-hidden rounded-lg border border-white/10 bg-black/60">
              <img
                src={`/api/cctv/frame/${encodeURIComponent(selectedEntity.cctvId)}?t=${frameTick}`}
                alt={selectedEntity.title}
                className="h-36 w-full object-cover"
              />
              <div className="flex items-center justify-between px-2 py-1 text-[9px] text-white/55">
                <span className="truncate">
                  {selectedEntity.cctvProvider || 'Public Camera'}
                </span>
                <button
                  type="button"
                  onClick={() => setFrameTick((t) => t + 1)}
                  className="flex items-center gap-1 text-[#00d4ff] hover:underline"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  REFRESH
                </button>
              </div>
            </div>
          )}

          {/* Telemetry Key/Values */}
          <div className="space-y-1 text-[10px]">
            {selectedEntity.telemetry.map((row) => (
              <div key={row.label} className="flex items-center justify-between gap-2">
                <span className="text-white/45">{row.label}</span>
                <span className="truncate text-right text-white/90">
                  {row.value}
                </span>
              </div>
            ))}
          </div>

          {/* Route & AI Path Prediction Readout for Aircraft */}
          {(selectedEntity.kind === 'flight' || selectedEntity.kind === 'military') && (
            <div className="mt-2.5 space-y-1.5 rounded-xl border border-purple-400/25 bg-purple-500/[0.06] p-2 text-[9px]">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 font-semibold tracking-[0.12em] text-purple-300">
                  <Sparkles className="h-2.5 w-2.5" />
                  {selectedEntity.flightPrediction?.phase || 'TRAJECTORY'}
                </span>
                <span className="text-white/55">
                  {selectedEntity.flightPrediction?.loading
                    ? 'ANALYZING…'
                    : `${(selectedEntity.flightPrediction?.provider || 'kinematic').toUpperCase()} · ${selectedEntity.flightPrediction?.confidence || 'LOW'}`}
                </span>
              </div>

              {selectedEntity.flightRoute && (
                <div className="flex items-center justify-between text-[9px] text-white/65">
                  <span>
                    PATH: {selectedEntity.flightRoute.trailPoints} PTS
                    {selectedEntity.flightRoute.backfilled ? ' · BACKFILL' : ''}
                  </span>
                  {selectedEntity.flightPrediction?.etaMin ? (
                    <span className="text-emerald-300">
                      ETA ~{selectedEntity.flightPrediction.etaMin} MIN
                    </span>
                  ) : null}
                </div>
              )}

              {selectedEntity.flightPrediction?.summary && (
                <p className="leading-relaxed text-white/80">
                  {selectedEntity.flightPrediction.summary}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-white/10 pt-1 text-[8px] text-white/60">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-0.5 w-3 border-b-2 border-dashed border-amber-500" />
                  PREVIOUS
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-0.5 w-3 border-b-2 border-dashed border-emerald-400" />
                  FILED
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-0.5 w-3 border-b-2 border-dashed border-purple-400" />
                  AI PRED
                </span>
              </div>

              <div className="flex gap-1 pt-0.5">
                <button
                  type="button"
                  onClick={() =>
                    routeOverviewActive
                      ? getGlobeEngine()?.followSelectedTarget()
                      : getGlobeEngine()?.viewSelectedFlightRoute()
                  }
                  className={`flex flex-1 items-center justify-center gap-1 rounded-md border py-1 text-[9px] font-semibold tracking-[0.1em] transition ${
                    routeOverviewActive
                      ? 'border-emerald-400/50 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30'
                      : 'border-white/15 bg-white/5 text-white/85 hover:border-[#00d4ff]/45 hover:text-[#00d4ff]'
                  }`}
                >
                  {routeOverviewActive ? (
                    <>
                      <Crosshair className="h-2.5 w-2.5" />
                      FOLLOW PLANE
                    </>
                  ) : (
                    <>
                      <Route className="h-2.5 w-2.5" />
                      FULL ROUTE
                    </>
                  )}
                </button>
                <button
                  type="button"
                  disabled={Boolean(selectedEntity.flightPrediction?.loading)}
                  onClick={() => void getGlobeEngine()?.refreshFlightPrediction()}
                  className="flex flex-1 items-center justify-center gap-1 rounded-md border border-purple-400/45 bg-purple-500/15 py-1 text-[9px] font-semibold tracking-[0.1em] text-purple-200 transition hover:bg-purple-500/25 disabled:opacity-50"
                >
                  <Sparkles className="h-2.5 w-2.5" />
                  AI PREDICT
                </button>
              </div>
            </div>
          )}

          {/* Target Actions */}
          <div className="mt-2.5 flex gap-1.5 border-t border-white/10 pt-2">
            {selectedEntity.canCockpit && (
              <button
                type="button"
                onClick={() => setCockpitMode(true)}
                className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-[#00d4ff]/50 bg-[#00d4ff]/15 py-1.5 text-[10px] font-semibold tracking-[0.12em] text-[#00d4ff] transition hover:bg-[#00d4ff]/25"
              >
                <Plane className="h-3 w-3" />
                COCKPIT
              </button>
            )}
            {selectedEntity.kind !== 'cctv' && (
              <button
                type="button"
                onClick={() =>
                  getGlobeEngine()?.flyToNearestCctv(
                    selectedEntity.lat,
                    selectedEntity.lon,
                  )
                }
                className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/15 bg-white/5 py-1.5 text-[10px] tracking-[0.1em] text-white/80 transition hover:border-[#00d4ff]/40 hover:text-white"
              >
                <Radio className="h-3 w-3" />
                NEAREST CAM
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
