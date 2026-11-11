'use client';

import { useState, type FormEvent } from 'react';
import { ChevronUp, Eye, MapPin, Search } from 'lucide-react';
import {
  CITY_PRESETS,
  getCityPreset,
  matchBundledLocation,
  parseDirectCoordinates,
} from '@/engine/cityPois';
import { MAP_STACK_DESCRIPTORS } from '@/engine/mapStacks';
import { STYLE_BUTTONS } from '@/engine/shaders';
import { useDisplayStore } from '@/stores/useDisplayStore';
import { useLocationStore } from '@/stores/useLocationStore';
import { useUiStore } from '@/stores/useUiStore';

export default function CommandDock() {
  const cleanView = useDisplayStore((s) => s.cleanView);
  const style = useDisplayStore((s) => s.style);
  const setStyle = useDisplayStore((s) => s.setStyle);
  const mapStack = useDisplayStore((s) => s.mapStack);
  const mapStackStatus = useDisplayStore((s) => s.mapStackStatus);
  const mapStackWarn = useDisplayStore((s) => s.mapStackWarn);
  const stackAvailability = useDisplayStore((s) => s.stackAvailability);
  const setMapStack = useDisplayStore((s) => s.setMapStack);

  const activeCityId = useLocationStore((s) => s.activeCityId);
  const activePoiIndex = useLocationStore((s) => s.activePoiIndex);
  const setActiveCity = useLocationStore((s) => s.setActiveCity);
  const setActivePoiIndex = useLocationStore((s) => s.setActivePoiIndex);
  const searchQuery = useLocationStore((s) => s.searchQuery);
  const setSearchQuery = useLocationStore((s) => s.setSearchQuery);
  const searching = useLocationStore((s) => s.searching);
  const setSearching = useLocationStore((s) => s.setSearching);
  const searchError = useLocationStore((s) => s.searchError);
  const setSearchError = useLocationStore((s) => s.setSearchError);
  const triggerFlyTo = useLocationStore((s) => s.triggerFlyTo);

  const locationExpanded = useUiStore((s) => s.locationTrayExpanded);
  const setLocationExpanded = useUiStore((s) => s.setLocationTrayExpanded);
  const presetsExpanded = useUiStore((s) => s.presetsTrayExpanded);
  const setPresetsExpanded = useUiStore((s) => s.setPresetsTrayExpanded);
  const showToast = useUiStore((s) => s.showToast);

  const [searchOpen, setSearchOpen] = useState(false);

  if (cleanView) return null;

  const activeCity = getCityPreset(activeCityId);
  const activePoi = activeCity.pois[activePoiIndex] || activeCity.pois[0];

  function chooseCity(cityId: string) {
    const city = getCityPreset(cityId);
    const first = city.pois[0];
    setActiveCity(city.id, 0);
    triggerFlyTo({
      lat: first.lat,
      lon: first.lon,
      alt: first.alt + city.groundElevation,
      heading: first.heading,
      pitch: first.pitch,
      label: city.name,
    });
  }

  function choosePoi(index: number) {
    const poi = activeCity.pois[index];
    if (!poi) return;
    setActivePoiIndex(index);
    triggerFlyTo({
      lat: poi.lat,
      lon: poi.lon,
      alt: poi.alt + activeCity.groundElevation,
      heading: poi.heading,
      pitch: poi.pitch,
      label: poi.name,
    });
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setSearchError(null);

    // 1. Keyless direct coordinates or geo: URI
    const coords = parseDirectCoordinates(q);
    if (coords) {
      triggerFlyTo({
        lat: coords.lat,
        lon: coords.lon,
        alt: 2500,
        pitch: -45,
        label: coords.label,
      });
      showToast(`Flying to ${coords.label}`);
      return;
    }

    // 2. Keyless bundled city/landmark presets
    const bundled = matchBundledLocation(q);
    if (bundled) {
      if (bundled.cityId) {
        setActiveCity(bundled.cityId, bundled.poiIndex ?? 0);
      }
      triggerFlyTo({
        lat: bundled.lat,
        lon: bundled.lon,
        alt: bundled.alt,
        heading: bundled.heading,
        pitch: bundled.pitch,
        label: bundled.label,
      });
      showToast(`Flying to ${bundled.label}`);
      return;
    }

    // 3. Keyless Nominatim geocode proxy
    setSearching(true);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const results = (await res.json()) as Array<{
        lat?: string;
        lon?: string;
        display_name?: string;
      }>;
      if (!Array.isArray(results) || results.length === 0) {
        setSearchError('No matching location found');
        return;
      }
      const top = results[0];
      const lat = Number(top.lat);
      const lon = Number(top.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        setSearchError('Invalid coordinates returned');
        return;
      }
      triggerFlyTo({
        lat,
        lon,
        alt: 4500,
        pitch: -40,
        label: top.display_name || q,
      });
      showToast(`Flying to ${(top.display_name || q).split(',')[0]}`);
    } catch {
      setSearchError('Location search failed');
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-[145] flex w-[min(94vw,1060px)] -translate-x-1/2 flex-col gap-2">
      {/* Popover Trays */}
      {(locationExpanded || presetsExpanded) && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {/* Location Tray */}
          {locationExpanded ? (
            <div className="gev-glass rounded-2xl p-3">
              <div className="mb-2 flex flex-wrap gap-1">
                {activeCity.pois.map((poi, idx) => (
                  <button
                    key={poi.name}
                    type="button"
                    onClick={() => choosePoi(idx)}
                    className={`rounded-md px-2 py-1 font-mono text-[10px] transition ${
                      idx === activePoiIndex
                        ? 'bg-[#00d4ff]/20 text-[#00d4ff] ring-1 ring-[#00d4ff]/40'
                        : 'bg-white/5 text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {poi.name}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1 border-t border-white/10 pt-2">
                {CITY_PRESETS.map((city) => (
                  <button
                    key={city.id}
                    type="button"
                    onClick={() => chooseCity(city.id)}
                    className={`rounded-full px-2.5 py-0.5 text-[11px] transition ${
                      city.id === activeCityId
                        ? 'bg-[#00d4ff] font-semibold text-[#0a0a0f]'
                        : 'bg-white/10 text-white/75 hover:bg-white/20'
                    }`}
                  >
                    {city.name}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setSearchOpen(!searchOpen)}
                  className="ml-auto flex items-center gap-1 rounded-full border border-white/15 px-2.5 py-0.5 text-[11px] text-[#00d4ff] hover:border-[#00d4ff]/60"
                >
                  <Search className="h-3 w-3" />
                  Find
                </button>
              </div>
              {searchOpen && (
                <form onSubmit={handleSearch} className="mt-2 flex gap-1.5">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="City, landmark, lat,lon or geo: URI..."
                    className="flex-1 rounded-lg border border-white/15 bg-black/40 px-2.5 py-1.5 text-xs text-white placeholder-white/35 outline-none focus:border-[#00d4ff]"
                  />
                  <button
                    type="submit"
                    disabled={searching}
                    className="rounded-lg bg-[#00d4ff] px-3 py-1.5 font-mono text-[10px] font-semibold text-[#0a0a0f] disabled:opacity-50"
                  >
                    {searching ? '...' : 'GO'}
                  </button>
                </form>
              )}
              {searchError && (
                <p className="mt-1 font-mono text-[10px] text-red-400">
                  {searchError}
                </p>
              )}
            </div>
          ) : (
            <div className="hidden md:block" />
          )}

          {/* Visual Presets & Map Source Tray */}
          {presetsExpanded && (
            <div className="gev-glass rounded-2xl p-3">
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
                {STYLE_BUTTONS.map((btn) => {
                  const active = style === btn.id;
                  return (
                    <button
                      key={btn.id}
                      type="button"
                      onClick={() => setStyle(btn.id)}
                      className={`flex flex-col items-center rounded-lg border py-1.5 transition ${
                        active
                          ? 'border-[#00d4ff]/70 bg-[#00d4ff]/15 text-[#00d4ff]'
                          : 'border-white/10 bg-white/[0.03] text-white/75 hover:border-white/25 hover:text-white'
                      }`}
                    >
                      <span className="text-sm">{btn.glyph}</span>
                      <span className="font-mono text-[10px]">{btn.label}</span>
                      <span className="font-mono text-[8px] text-white/40">
                        {btn.hotkey}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-2.5 border-t border-white/10 pt-2">
                <div className="mb-1.5 flex items-center justify-between font-mono text-[9px] tracking-[0.14em] text-white/55">
                  <span>MAP SOURCE</span>
                  <span className={mapStackWarn ? 'text-amber-300' : 'text-[#00d4ff]'}>
                    {mapStackStatus}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {MAP_STACK_DESCRIPTORS.map((desc) => {
                    const avail = stackAvailability[desc.id]?.available ?? false;
                    const active = mapStack === desc.id;
                    return (
                      <button
                        key={desc.id}
                        type="button"
                        disabled={!avail}
                        title={
                          avail
                            ? desc.label
                            : stackAvailability[desc.id]?.reason || 'Unavailable'
                        }
                        onClick={() => setMapStack(desc.id)}
                        className={`flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10px] transition ${
                          active
                            ? 'border-[#00d4ff]/70 bg-[#00d4ff]/20 text-[#00d4ff]'
                            : avail
                              ? 'border-white/10 bg-white/5 text-white/75 hover:border-white/30'
                              : 'cursor-not-allowed border-white/5 bg-white/[0.02] text-white/30'
                        }`}
                      >
                        <span>{desc.label}</span>
                        {!avail && desc.requirementBadge && (
                          <span className="text-[8px] text-amber-300/70">
                            {desc.requirementBadge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Compact Bottom Command Bar */}
      <div className="gev-glass grid grid-cols-2 divide-x divide-white/10 rounded-xl px-2 py-1.5">
        <button
          type="button"
          onClick={() => setLocationExpanded(!locationExpanded)}
          className="flex items-center justify-between px-3 py-1 text-left transition hover:bg-white/[0.03]"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-mono text-[9px] tracking-[0.16em] text-[#cde8ef]/70">
              <MapPin className="h-3 w-3 text-[#00d4ff]" />
              LOCATION
            </div>
            <div className="truncate text-xs font-medium text-white">
              {activeCity.name} ·{' '}
              <span className="text-white/60">{activePoi.name}</span>
            </div>
          </div>
          <ChevronUp
            className={`h-4 w-4 shrink-0 text-white/50 transition ${
              locationExpanded ? 'rotate-180 text-[#00d4ff]' : ''
            }`}
          />
        </button>

        <button
          type="button"
          onClick={() => setPresetsExpanded(!presetsExpanded)}
          className="flex items-center justify-between px-3 py-1 text-left transition hover:bg-white/[0.03]"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 font-mono text-[9px] tracking-[0.16em] text-[#cde8ef]/70">
              <Eye className="h-3 w-3 text-[#00d4ff]" />
              VISUAL PRESETS
            </div>
            <div className="truncate font-mono text-xs text-white">
              {STYLE_BUTTONS.find((b) => b.id === style)?.label.toUpperCase() || 'NORMAL'}{' '}
              · <span className="text-[#00d4ff]">{mapStackStatus}</span>
            </div>
          </div>
          <ChevronUp
            className={`h-4 w-4 shrink-0 text-white/50 transition ${
              presetsExpanded ? 'rotate-180 text-[#00d4ff]' : ''
            }`}
          />
        </button>
      </div>
    </div>
  );
}
