'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import IntelHud from './IntelHud';
import SceneChrome from './SceneChrome';
import LayerPanels from './LayerPanels';
import DisplayPanel from './DisplayPanel';
import CommandDock from './CommandDock';
import CockpitHud from './CockpitHud';
import WelcomeLauncher from './WelcomeLauncher';
import ProviderSettingsModal from './ProviderSettingsModal';
import { useDisplayStore } from '@/stores/useDisplayStore';
import { useHudStore } from '@/stores/useHudStore';
import { useLayerStore } from '@/stores/useLayerStore';
import { useUiStore } from '@/stores/useUiStore';
import { getGlobeEngine } from '@/engine/engineBridge';
import type { VisualStyleId } from '@/types/gev';

const GlobeViewport = dynamic(() => import('./GlobeViewport'), { ssr: false });

const STYLE_KEYS: Record<string, VisualStyleId> = {
  '1': 'normal',
  '2': 'retro',
  '3': 'surveillance',
  '4': 'thermal',
  '5': 'anime',
  '6': 'noir',
};

export default function GodsEyeApp() {
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key in STYLE_KEYS) {
        useDisplayStore.getState().setStyle(STYLE_KEYS[e.key]);
        return;
      }

      const lower = e.key.toLowerCase();
      if (lower === 'h') {
        const d = useDisplayStore.getState();
        d.setHudVisible(!d.hudVisible);
      } else if (lower === 'd') {
        useDisplayStore.getState().cycleDetectionMode();
      } else if (lower === 'c') {
        useLayerStore.getState().toggleLayer('cctv');
      } else if (e.key === '`') {
        useHudStore.getState().toggleShowFps();
      } else if (e.key === 'Escape') {
        const ui = useUiStore.getState();
        const display = useDisplayStore.getState();
        if (ui.providerSettingsOpen) {
          ui.setProviderSettingsOpen(false);
        } else if (ui.welcomeVisible) {
          ui.dismissWelcome(false);
        } else if (display.cockpitMode) {
          display.setCockpitMode(false);
        } else if (display.cleanView) {
          display.setCleanView(false);
        } else if (useHudStore.getState().selectedEntity) {
          getGlobeEngine()?.clearSelection();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <main
      className="relative h-screen w-screen overflow-hidden bg-[#0a0a0f]"
      suppressHydrationWarning
    >
      {hydrated && (
        <>
          <GlobeViewport />
          <IntelHud />
          <SceneChrome />
          <LayerPanels />
          <DisplayPanel />
          <CommandDock />
          <CockpitHud />
          <WelcomeLauncher />
          <ProviderSettingsModal />
        </>
      )}
    </main>
  );
}
