'use client';

import { useEffect, useRef } from 'react';
import { GlobeEngine } from '@/engine/GlobeEngine';
import { isFirstRunSuppressed, useUiStore, type ProviderStatus } from '@/stores/useUiStore';

export default function GlobeViewport() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const creditsRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const credits = creditsRef.current;
    const overlay = overlayRef.current;
    if (!container || !credits || !overlay) return;

    if (isFirstRunSuppressed()) {
      useUiStore.getState().setWelcomeVisible(false);
    }

    const engine = new GlobeEngine(container, credits, overlay);
    let cancelled = false;

    async function boot() {
      let googleApiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';
      let cesiumToken = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN || '';

      try {
        const res = await fetch('/api/setup/status', { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as {
            configured?: ProviderStatus;
            clientTokens?: { googleApiKey?: string; cesiumToken?: string };
          };
          if (json.clientTokens?.googleApiKey) {
            googleApiKey = json.clientTokens.googleApiKey;
          }
          if (json.clientTokens?.cesiumToken) {
            cesiumToken = json.clientTokens.cesiumToken;
          }
          if (json.configured) {
            useUiStore.getState().setServerConfig(json.configured, {
              googleApiKey,
              cesiumToken,
            });
          }
        }
      } catch {
        // Boot keyless if status check fails
      }

      if (cancelled) return;

      try {
        await engine.init({ googleApiKey, cesiumToken });
      } catch (err) {
        if (!cancelled) {
          useUiStore
            .getState()
            .setLoading(
              true,
              'Globe initialization failed',
              err instanceof Error ? err.message : String(err),
            );
        }
      }
    }

    void boot();

    return () => {
      cancelled = true;
      engine.destroy();
    };
  }, []);

  return (
    <>
      <div
        id="cesiumContainer"
        ref={containerRef}
        className="fixed inset-0 z-0 h-full w-full"
      />
      <canvas
        id="world-overlay-canvas"
        ref={overlayRef}
        className="pointer-events-none fixed inset-0 z-[1] h-full w-full"
        aria-hidden="true"
      />
      <div id="cesium-credits" ref={creditsRef} />
    </>
  );
}
