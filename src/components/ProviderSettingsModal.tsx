'use client';

import { useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, X } from 'lucide-react';
import { useUiStore } from '@/stores/useUiStore';

interface FieldSpec {
  envKey: string;
  label: string;
  statusKey: keyof ReturnType<typeof useUiStore.getState>['configuredProviders'];
  tier: string;
  hint: string;
}

const PROVIDER_FIELDS: FieldSpec[] = [
  {
    envKey: 'AISSTREAM_API_KEY',
    label: 'AISStream API Key',
    statusKey: 'aisstream',
    tier: 'Free key (aisstream.io)',
    hint: 'Enables live global maritime AIS vessel positions and wake trails.',
  },
  {
    envKey: 'TOMTOM_API_KEY',
    label: 'TomTom API Key',
    statusKey: 'tomtom',
    tier: 'Free 200k tiles/mo (my.tomtom.com/keys)',
    hint: 'Enables live real-time road traffic flow, jams & road closures.',
  },
  {
    envKey: 'CESIUM_ION_TOKEN',
    label: 'Cesium ion Token',
    statusKey: 'cesiumIon',
    tier: 'Free Community tier',
    hint: 'Unlocks ion-hosted Google Photorealistic 3D, Bing Imagery & World Terrain.',
  },
  {
    envKey: 'GOOGLE_MAPS_API_KEY',
    label: 'Google Maps API Key',
    statusKey: 'googleMaps',
    tier: 'Metered / Map Tiles API',
    hint: 'Unlocks direct Google Photorealistic 3D Tiles.',
  },
  {
    envKey: 'OPENSKY_CLIENT_ID',
    label: 'OpenSky OAuth Client ID',
    statusKey: 'opensky',
    tier: 'Optional free account',
    hint: 'Raises OpenSky API polling credits; adsb.lol regional fallback works keyless.',
  },
  {
    envKey: 'OPENSKY_CLIENT_SECRET',
    label: 'OpenSky OAuth Client Secret',
    statusKey: 'opensky',
    tier: 'Optional free account',
    hint: 'Paired with OPENSKY_CLIENT_ID on the server.',
  },
  {
    envKey: 'OPENAI_API_KEY',
    label: 'OpenAI API Key',
    statusKey: 'openai',
    tier: 'Optional (Voice/AI phase)',
    hint: 'Stored server-side in .env.local for AI flight prediction & HUD summaries.',
  },
  {
    envKey: 'GEMINI_API_KEY',
    label: 'Gemini API Key',
    statusKey: 'gemini',
    tier: 'Optional (AI Trajectory)',
    hint: 'Stored server-side in .env.local for Gemini flight path prediction.',
  },
];

export default function ProviderSettingsModal() {
  const open = useUiStore((s) => s.providerSettingsOpen);
  const setOpen = useUiStore((s) => s.setProviderSettingsOpen);
  const configured = useUiStore((s) => s.configuredProviders);
  const showToast = useUiStore((s) => s.showToast);

  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    const updates: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v.trim()) updates[k] = v.trim();
    }
    if (Object.keys(updates).length === 0) {
      setOpen(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/setup/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: updates }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);

      showToast('Keys saved to .env.local — reloading console...');
      setOpen(false);
      window.setTimeout(() => window.location.reload(), 650);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save keys');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[280] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="gev-glass w-full max-w-lg rounded-2xl border-[#00d4ff]/40 p-5">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 pb-3">
          <div>
            <div className="flex items-center gap-2 font-mono text-xs font-semibold tracking-[0.16em] text-[#00d4ff]">
              <KeyRound className="h-4 w-4" />
              PROVIDER SETTINGS · POWER UP
            </div>
            <p className="mt-1 text-xs text-white/60">
              Keyless Esri Satellite, flights, satellites, earthquakes, and CCTV
              work with zero keys. Add tokens below to upgrade 3D tiles &amp;
              quotas (saved locally in <code className="text-white/85">.env.local</code>).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="mt-4 space-y-3">
          {PROVIDER_FIELDS.map((field) => {
            const isSet = configured[field.statusKey];
            return (
              <div key={field.envKey} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <label
                    htmlFor={field.envKey}
                    className="font-medium text-white"
                  >
                    {field.label}
                  </label>
                  <span
                    className={`flex items-center gap-1 font-mono text-[10px] ${
                      isSet ? 'text-emerald-300' : 'text-white/45'
                    }`}
                  >
                    {isSet && <CheckCircle2 className="h-3 w-3" />}
                    {isSet ? 'CONFIGURED' : field.tier}
                  </span>
                </div>
                <input
                  id={field.envKey}
                  type="password"
                  autoComplete="off"
                  value={values[field.envKey] || ''}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      [field.envKey]: e.target.value,
                    }))
                  }
                  placeholder={isSet ? '•••••••• (configured — paste to replace)' : `Paste ${field.envKey}`}
                  className="w-full rounded-lg border border-white/15 bg-black/50 px-3 py-1.5 font-mono text-xs text-white placeholder-white/30 outline-none focus:border-[#00d4ff]"
                />
                <p className="text-[10px] text-white/45">{field.hint}</p>
              </div>
            );
          })}

          {error && (
            <p className="font-mono text-xs text-red-400">{error}</p>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-white/15 px-3 py-1.5 font-mono text-[11px] text-white/70 hover:text-white"
            >
              CANCEL
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-[#00d4ff] px-4 py-1.5 font-mono text-[11px] font-semibold tracking-[0.1em] text-[#0a0a0f] disabled:opacity-50"
            >
              {saving ? 'SAVING...' : 'SAVE KEYS'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
