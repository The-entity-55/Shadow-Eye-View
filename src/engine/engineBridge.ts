import type { GlobeEngine } from './GlobeEngine';

let activeEngine: GlobeEngine | null = null;

export function registerGlobeEngine(engine: GlobeEngine | null) {
  activeEngine = engine;
}

export function getGlobeEngine(): GlobeEngine | null {
  return activeEngine;
}
