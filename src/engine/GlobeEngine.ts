import type * as CesiumType from 'cesium';
import type {
  DetectionTarget,
  MapStackId,
  SelectedEntityInfo,
  VisualStyleId,
} from '@/types/gev';
import { SHADER_PRESETS, SHARPEN_FRAGMENT_SHADER } from './shaders';
import { CITY_PRESETS, GLOBE_OVERVIEW } from './cityPois';
import {
  createImageryForStack,
  createTerrainForCredentials,
  loadPhotorealisticTileset,
  MAP_STACK_DESCRIPTORS,
} from './mapStacks';
import {
  classifyRegion,
  estimateGsdAndNiirs,
  estimateSunElevationDeg,
  formatAltMsl,
  formatDms,
  toMgrsSafe,
} from './hudMath';
import { renderDetectionOverlay } from './detectionOverlay';
import { FlightsLayerController } from './layers/flightsLayer';
import { VesselsLayerController } from './layers/vesselsLayer';
import { SatellitesLayerController } from './layers/satellitesLayer';
import { EarthquakesLayerController } from './layers/earthquakesLayer';
import { CctvLayerController } from './layers/cctvLayer';
import { TrafficLayerController } from './layers/trafficLayer';
import { useDisplayStore } from '@/stores/useDisplayStore';
import { useLayerStore } from '@/stores/useLayerStore';
import { useHudStore } from '@/stores/useHudStore';
import { useUiStore } from '@/stores/useUiStore';
import { useLocationStore } from '@/stores/useLocationStore';
import { registerGlobeEngine } from './engineBridge';
import { acquireTrackedCameraFrame, behindTargetEnuOffset } from './trackedCameraFrame';
import { cockpitAnchorCorrectionStep, slewHeadingDeg } from './horizonAndHeading';
import {
  type CockpitLookAngles,
  LOOK_REST_PITCH_DEG,
  clampLookPitch,
  easeLook,
  lookKeyStep,
  stepLook,
  wrapLookYaw,
} from './cockpitLook';
import { ensureGeoidReady, geoidHeightOrZero } from './geoid';

export class GlobeEngine {
  private Cesium!: typeof CesiumType;
  private viewer!: CesiumType.Viewer;
  private container: HTMLElement;
  private creditContainer: HTMLElement;
  private overlayCanvas: HTMLCanvasElement;

  private tileset: CesiumType.Cesium3DTileset | null = null;
  private imageryLayer: CesiumType.ImageryLayer | null = null;
  private activeMapStack: MapStackId | null = null;
  private googleApiKey = '';
  private cesiumToken = '';

  private styleStages = new Map<
    Exclude<VisualStyleId, 'normal'>,
    CesiumType.PostProcessStage
  >();
  private sharpenStage: CesiumType.PostProcessStage | null = null;

  private flightsLayer!: FlightsLayerController;
  private vesselsLayer!: VesselsLayerController;
  private satellitesLayer!: SatellitesLayerController;
  private earthquakesLayer!: EarthquakesLayerController;
  private cctvLayer!: CctvLayerController;
  private trafficLayer!: TrafficLayerController;

  private selectedEntityId: string | null = null;
  private trackedEntityKind: SelectedEntityInfo['kind'] | null = null;
  private trackedCartesian: CesiumType.Cartesian3 | null = null;
  private trackedHeadingDeg = 0;
  private trackedFollowEntity: CesiumType.Entity | null = null;
  private stopTrackedFrame: (() => void) | null = null;
  private cockpitHeadingDeg = 0;
  private lastCockpitFrameMs = 0;
  private lastTrafficLoopMs = 0;
  private cockpitAnchor: CesiumType.Cartesian3 | null = null;
  private cockpitEnuFrame: CesiumType.Matrix4 | null = null;
  private cockpitVec4A: CesiumType.Cartesian4 | null = null;
  private cockpitVec4B: CesiumType.Cartesian4 | null = null;
  private cockpitDiffVec: CesiumType.Cartesian3 | null = null;
  private cockpitLookTarget: CockpitLookAngles = { yawDeg: 0, pitchDeg: LOOK_REST_PITCH_DEG };
  private cockpitLookView: CockpitLookAngles = { yawDeg: 0, pitchDeg: LOOK_REST_PITCH_DEG };
  private lastCockpitLookSyncMs = 0;
  private cockpitLocalVec: CesiumType.Cartesian3 | null = null;
  private cockpitForwardVec: CesiumType.Cartesian3 | null = null;
  private cockpitUpVec: CesiumType.Cartesian3 | null = null;

  private startEpoch = performance.now();
  private lastHudUpdate = 0;
  private frameCounter = 0;
  private lastFpsTick = performance.now();
  private measuredFps = 60;
  private removePreUpdate: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private destroyed = false;

  private pickHandler: CesiumType.ScreenSpaceEventHandler | null = null;
  private unsubscribes: Array<() => void> = [];

  constructor(
    container: HTMLElement,
    creditContainer: HTMLElement,
    overlayCanvas: HTMLCanvasElement,
  ) {
    this.container = container;
    this.creditContainer = creditContainer;
    this.overlayCanvas = overlayCanvas;
  }

  async init(credentials: { googleApiKey?: string; cesiumToken?: string }) {
    this.googleApiKey = (credentials.googleApiKey || '').trim();
    this.cesiumToken = (credentials.cesiumToken || '').trim();

    const ui = useUiStore.getState();
    ui.setLoading(true, 'Loading CesiumJS engine...');

    (window as unknown as { CESIUM_BASE_URL?: string }).CESIUM_BASE_URL = '/cesium';
    const Cesium = await import('cesium');
    if (this.destroyed) return;
    this.Cesium = Cesium;

    ui.setLoading(true, 'Initializing 3D globe & starfield...');

    this.viewer = new Cesium.Viewer(this.container, {
      timeline: false,
      animation: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      vrButton: false,
      selectionIndicator: false,
      infoBox: false,
      baseLayer: false,
      creditContainer: this.creditContainer,
      msaaSamples: 4,
      contextOptions: { webgl: { preserveDrawingBuffer: true } },
      skyBox: new Cesium.SkyBox({
        sources: {
          positiveX: '/sky/milkyway_px.webp',
          negativeX: '/sky/milkyway_nx.webp',
          positiveY: '/sky/milkyway_py.webp',
          negativeY: '/sky/milkyway_ny.webp',
          positiveZ: '/sky/milkyway_pz.webp',
          negativeZ: '/sky/milkyway_nz.webp',
        },
      }),
    });

    this.viewer.targetFrameRate = 60;
    this.viewer.scene.globe.show = false;
    if (this.viewer.scene.skyAtmosphere) {
      this.viewer.scene.skyAtmosphere.show = true;
      this.viewer.scene.skyAtmosphere.atmosphereLightIntensity = 18;
      this.viewer.scene.skyAtmosphere.saturationShift = -0.12;
      this.viewer.scene.skyAtmosphere.brightnessShift = -0.08;
    }

    // Install GLSL Post-Processing Stages
    this.installPostProcessStages();

    // Initialize Map Stack (Google 3D -> Ion -> Esri Satellite -> OSM fallback)
    await this.initMapStack();
    if (this.destroyed) return;

    // Initialize Data Layer Controllers
    this.initLayers();

    // Entity Click-to-Track Picking
    this.installPicking();

    // Subscribe to Zustand store changes
    this.bindStores();

    // Default initial flight to Austin, TX (Texas State Capitol)
    const austin = CITY_PRESETS[0];
    const cap = austin.pois[0];
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(cap.lon, cap.lat, cap.alt + austin.groundElevation),
      orientation: {
        heading: Cesium.Math.toRadians(cap.heading),
        pitch: Cesium.Math.toRadians(cap.pitch),
        roll: 0,
      },
    });

    this.startLoop();
    registerGlobeEngine(this);
    ui.setLoading(false, 'Ready');
  }

  private installPostProcessStages() {
    const Cesium = this.Cesium;
    const stages = this.viewer.scene.postProcessStages;

    for (const [id, spec] of Object.entries(SHADER_PRESETS) as Array<
      [Exclude<VisualStyleId, 'normal'>, (typeof SHADER_PRESETS)['retro']]
    >) {
      const uniforms: Record<string, unknown> = {
        intensity: 1.0,
        time: () => (performance.now() - this.startEpoch) / 1000,
      };
      for (const def of spec.uniforms) {
        uniforms[def.key] = def.default;
      }
      const stage = new Cesium.PostProcessStage({
        name: `gev-${id}`,
        fragmentShader: spec.fragmentShader,
        uniforms,
      });
      stage.enabled = false;
      stages.add(stage);
      this.styleStages.set(id, stage);
    }

    this.sharpenStage = new Cesium.PostProcessStage({
      name: 'gev-sharpen',
      fragmentShader: SHARPEN_FRAGMENT_SHADER,
      uniforms: { amount: 0.49 },
    });
    this.sharpenStage.enabled = true;
    stages.add(this.sharpenStage);

    this.syncVisualEffects();
  }

  private syncVisualEffects() {
    const display = useDisplayStore.getState();

    for (const [id, stage] of this.styleStages.entries()) {
      const active = display.style === id;
      stage.enabled = active;
      if (active) {
        const params = display.styleParams[id];
        for (const [k, v] of Object.entries(params)) {
          stage.uniforms[k] = v;
        }
      }
    }

    if (this.sharpenStage) {
      this.sharpenStage.enabled = display.sharpenEnabled;
      this.sharpenStage.uniforms.amount = display.sharpenIntensity / 100;
    }

    const bloom = this.viewer.scene.postProcessStages.bloom;
    if (bloom) {
      bloom.enabled = display.bloomEnabled;
      bloom.uniforms.contrast = 128;
      bloom.uniforms.brightness = -0.3 + (display.bloomIntensity / 100) * 0.45;
      bloom.uniforms.delta = 1.0;
      bloom.uniforms.sigma = 3.0;
      bloom.uniforms.stepSize = 5.0;
    }
  }

  private async initMapStack() {
    const ui = useUiStore.getState();
    const display = useDisplayStore.getState();
    const hasCreds = Boolean(this.googleApiKey || this.cesiumToken);

    ui.setLoading(
      true,
      hasCreds ? 'Loading Google Photorealistic 3D Tiles...' : 'Loading Esri World Imagery...',
    );

    const { tileset, route } = await loadPhotorealisticTileset(this.Cesium, {
      googleApiKey: this.googleApiKey,
      cesiumToken: this.cesiumToken,
    });
    if (this.destroyed) return;

    if (tileset) {
      this.tileset = tileset;
      this.viewer.scene.primitives.add(tileset);
    }

    const hasIon = Boolean(this.cesiumToken);
    display.setStackAvailability({
      photoreal: {
        available: Boolean(tileset),
        reason: tileset
          ? undefined
          : 'Needs Google Maps API key or Cesium ion token (POWER UP)',
      },
      'bing-aerial': {
        available: hasIon,
        reason: hasIon ? undefined : 'Needs Cesium ion token (POWER UP)',
      },
      'bing-labels': {
        available: hasIon,
        reason: hasIon ? undefined : 'Needs Cesium ion token (POWER UP)',
      },
      'esri-imagery': { available: true },
      osm: { available: true },
    });

    const initialStack: MapStackId = tileset ? 'photoreal' : 'esri-imagery';
    await this.switchMapStack(initialStack, route === 'google-ion' || route === 'google-direct');
  }

  async switchMapStack(stackId: MapStackId, silent = false) {
    if (this.activeMapStack === stackId) return;
    const display = useDisplayStore.getState();
    const ui = useUiStore.getState();
    const desc = MAP_STACK_DESCRIPTORS.find((d) => d.id === stackId);

    if (stackId === 'photoreal') {
      if (!this.tileset) {
        ui.showToast('Google 3D requires a Google Maps API key or Cesium ion token', 'warn');
        return;
      }
      this.activeMapStack = 'photoreal';
      this.tileset.show = true;
      this.viewer.scene.globe.show = false;
      display.setMapStack('photoreal');
      display.setMapStackStatus('3D', false);
      return;
    }

    if (this.tileset) this.tileset.show = false;
    this.viewer.scene.globe.show = true;

    try {
      const provider = await createImageryForStack(this.Cesium, stackId, this.cesiumToken);
      if (this.destroyed) return;
      this.activeMapStack = stackId;
      if (this.imageryLayer) {
        this.viewer.imageryLayers.remove(this.imageryLayer, true);
      }
      this.imageryLayer = this.viewer.imageryLayers.addImageryProvider(provider);
      this.viewer.terrainProvider = await createTerrainForCredentials(this.Cesium, this.cesiumToken);
      display.setMapStack(stackId);
      display.setMapStackStatus(desc?.shortLabel || stackId.toUpperCase(), false);
      if (!silent) {
        ui.showToast(`Switched map source to ${desc?.label || stackId}`);
      }
    } catch (err) {
      if (stackId !== 'osm') {
        console.warn('[MapStack] Falling back to OSM:', err);
        await this.switchMapStack('osm', true);
        display.setMapStackStatus('OSM (FALLBACK)', true);
        ui.showToast('Primary imagery unavailable; using OpenStreetMap', 'warn');
      }
    }
  }

  private initLayers() {
    const layerStore = useLayerStore.getState();
    const updateStats = (
      id: 'flights' | 'military' | 'vessels' | 'traffic' | 'satellites' | 'earthquakes' | 'cctv',
      patch: Parameters<typeof layerStore.updateLayerState>[1],
    ) => {
      useLayerStore.getState().updateLayerState(id, patch);
    };

    this.flightsLayer = new FlightsLayerController(this.viewer, this.Cesium, (kind, patch) =>
      updateStats(kind, patch),
    );
    this.vesselsLayer = new VesselsLayerController(this.viewer, this.Cesium, (patch) =>
      updateStats('vessels', patch),
    );
    this.trafficLayer = new TrafficLayerController(this.viewer, this.Cesium, (patch) =>
      updateStats('traffic', patch),
    );
    this.satellitesLayer = new SatellitesLayerController(this.viewer, this.Cesium, (patch) =>
      updateStats('satellites', patch),
    );
    this.earthquakesLayer = new EarthquakesLayerController(this.viewer, this.Cesium, (patch) =>
      updateStats('earthquakes', patch),
    );
    this.cctvLayer = new CctvLayerController(this.viewer, this.Cesium, (patch) =>
      updateStats('cctv', patch),
    );

    const layerStoreState = useLayerStore.getState();
    const initialLayers = layerStoreState.layers;
    this.flightsLayer.setEnabled('flights', initialLayers.flights.enabled);
    this.flightsLayer.setEnabled('military', initialLayers.military.enabled);
    this.vesselsLayer.setEnabled(initialLayers.vessels.enabled);
    this.trafficLayer.setLinesEnabled(layerStoreState.trafficLines);
    this.trafficLayer.setEnabled(initialLayers.traffic.enabled);
    this.satellitesLayer.setEnabled(initialLayers.satellites.enabled);
    this.earthquakesLayer.setEnabled(initialLayers.earthquakes.enabled);
    this.cctvLayer.setEnabled(initialLayers.cctv.enabled);
  }

  private pressTravelPx = 0;
  private prevPointerPos: { x: number; y: number } | null = null;
  private pressActive = false;

  private installPicking() {
    const Cesium = this.Cesium;
    this.pickHandler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);

    this.pickHandler.setInputAction(
      (movement: { position: CesiumType.Cartesian2 }) => {
        this.pressActive = true;
        this.pressTravelPx = 0;
        this.prevPointerPos = { x: movement.position.x, y: movement.position.y };
        if (useDisplayStore.getState().autoOrbit) {
          useDisplayStore.getState().setAutoOrbit(false);
        }
      },
      Cesium.ScreenSpaceEventType.LEFT_DOWN,
    );

    this.pickHandler.setInputAction(
      (movement: { endPosition: CesiumType.Cartesian2 }) => {
        if (!this.pressActive || !this.prevPointerPos) return;
        const dx = movement.endPosition.x - this.prevPointerPos.x;
        const dy = movement.endPosition.y - this.prevPointerPos.y;
        this.pressTravelPx += Math.hypot(dx, dy);
        this.prevPointerPos = { x: movement.endPosition.x, y: movement.endPosition.y };
        if (useDisplayStore.getState().cockpitMode) {
          this.cockpitLookTarget = {
            yawDeg: wrapLookYaw(this.cockpitLookTarget.yawDeg + dx * 0.22),
            pitchDeg: clampLookPitch(this.cockpitLookTarget.pitchDeg - dy * 0.18),
          };
        }
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );

    this.pickHandler.setInputAction(() => {
      this.pressActive = false;
      this.prevPointerPos = null;
    }, Cesium.ScreenSpaceEventType.LEFT_UP);

    this.pickHandler.setInputAction(
      (movement: { position: CesiumType.Cartesian2 }) => {
        const travelPx = this.pressTravelPx;
        this.pressActive = false;
        this.prevPointerPos = null;
        this.pressTravelPx = 0;

        // Orbit/pan drags > 6 px must never accidentally drop or switch tracking lock
        if (travelPx > 6) return;
        if (useDisplayStore.getState().cockpitMode) return;

        const picked = this.viewer.scene.pick(movement.position);
        const pickedId = picked?.id ?? picked?.primitive?.id;
        if (picked?.id && picked.id === this.trackedFollowEntity) return;

        const entityId: string | null =
          typeof pickedId === 'string'
            ? pickedId
            : typeof pickedId?.entityId === 'string'
              ? pickedId.entityId
              : null;

        if (entityId) {
          this.selectAndTrackEntity(entityId, false);
        } else if (this.selectedEntityId) {
          this.clearSelection();
        }
      },
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );

    this.keydownHandler = (e: KeyboardEvent) => {
      const targetEl = e.target instanceof Element ? e.target : null;
      const editingText = Boolean(
        targetEl?.closest('input, textarea, select, [contenteditable]'),
      );
      if (e.key === 'Escape') {
        if (useDisplayStore.getState().cockpitMode) {
          e.preventDefault();
          useDisplayStore.getState().setCockpitMode(false);
          return;
        }
        if (this.selectedEntityId) {
          this.clearSelection();
        }
        return;
      }

      if (useDisplayStore.getState().cockpitMode && !editingText && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const step = lookKeyStep(e.key, e.shiftKey);
        if (step) {
          e.preventDefault();
          this.cockpitLookTarget = stepLook(this.cockpitLookTarget, step);
          return;
        }
        if (!e.repeat && (e.key === 'Home' || e.key === '0')) {
          e.preventDefault();
          this.resetCockpitLook();
        }
      }
    };
    document.addEventListener('keydown', this.keydownHandler);
  }

  stepCockpitLook(axis: 'yaw' | 'pitch', sign: 1 | -1, coarse = false) {
    this.cockpitLookTarget = stepLook(this.cockpitLookTarget, {
      axis,
      sign,
      stepDeg: coarse ? 45 : 10,
    });
  }

  resetCockpitLook() {
    this.cockpitLookTarget = { yawDeg: 0, pitchDeg: LOOK_REST_PITCH_DEG };
  }

  private releaseTrackedCamera() {
    this.stopTrackedFrame?.();
    this.stopTrackedFrame = null;
    if (this.viewer && !this.viewer.isDestroyed()) {
      if (this.viewer.trackedEntity) {
        this.viewer.trackedEntity = undefined;
      }
      this.viewer.camera.lookAtTransform(this.Cesium.Matrix4.IDENTITY);
      if (this.trackedFollowEntity) {
        this.viewer.entities.remove(this.trackedFollowEntity);
      }
    }
    this.trackedFollowEntity = null;
  }

  private resolveTrackedEntityPosition(
    _time?: CesiumType.JulianDate,
    result?: CesiumType.Cartesian3,
  ): CesiumType.Cartesian3 | undefined {
    const nowMs = Date.now();
    if (!this.selectedEntityId) return undefined;
    if (
      this.selectedEntityId.startsWith('flight:') ||
      this.selectedEntityId.startsWith('mil:')
    ) {
      return this.flightsLayer.getTrackedLivePosition(nowMs, result);
    }
    if (this.selectedEntityId.startsWith('sat:')) {
      return this.satellitesLayer.getTrackedLivePosition(nowMs, result);
    }
    return undefined;
  }

  private attachFollowCamera(
    kind: 'flight' | 'military' | 'satellite',
    altM: number,
    headingDeg: number,
  ) {
    if (!this.viewer || this.viewer.isDestroyed()) return;
    this.releaseTrackedCamera();

    let offset: CesiumType.Cartesian3;
    if (kind === 'satellite') {
      const followRange = altM > 10_000_000 ? 6_500_000 : 1_200_000;
      offset = behindTargetEnuOffset(
        this.Cesium,
        headingDeg,
        followRange * 0.55,
        followRange * 0.85,
      );
    } else {
      // Frame behind & slightly above the aircraft along its course heading so the camera
      // looks forward along its flight path and follows continuously as it flies.
      const followRange = Math.min(Math.max((altM || 1500) * 1.1 + 2500, 3000), 22_000);
      offset = behindTargetEnuOffset(
        this.Cesium,
        headingDeg,
        followRange * 0.85,
        followRange * 0.45,
      );
    }

    this.trackedFollowEntity = this.viewer.entities.add({
      trackingReferenceFrame: this.Cesium.TrackingReferenceFrame.ENU,
      position: new this.Cesium.CallbackPositionProperty(
        (time, result) => this.resolveTrackedEntityPosition(time, result),
        false,
      ),
      viewFrom: new this.Cesium.ConstantProperty(offset),
    });

    this.viewer.camera.cancelFlight();
    this.viewer.trackedEntity = this.trackedFollowEntity;
    this.stopTrackedFrame = acquireTrackedCameraFrame(
      this.Cesium,
      this.viewer,
      this.trackedFollowEntity,
      offset,
    );
  }

  private flyToTarget(
    lat: number,
    lon: number,
    targetAltM: number,
    rangeM: number,
    headingDeg = 0,
    pitchDeg = -35,
  ) {
    const pitchRad = this.Cesium.Math.toRadians(Math.abs(pitchDeg));
    const headRad = this.Cesium.Math.toRadians(headingDeg);
    const horizM = rangeM * Math.cos(pitchRad);
    const upM = rangeM * Math.sin(pitchRad);
    const dNorth = (-Math.cos(headRad) * horizM) / 111_320;
    const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const dEast = (-Math.sin(headRad) * horizM) / (111_320 * cosLat);
    this.flyTo(lat + dNorth, lon + dEast, targetAltM + upM, headingDeg, pitchDeg);
  }

  selectAndTrackEntity(entityId: string | null, enterCockpit = false) {
    this.selectedEntityId = entityId;
    this.flightsLayer.setSelectedEntityId(entityId);
    this.vesselsLayer.setSelectedEntityId(entityId);
    this.satellitesLayer.setSelectedEntityId(entityId);
    this.earthquakesLayer.setSelectedEntityId(entityId);
    this.cctvLayer.setSelectedEntityId(entityId);

    if (!entityId) {
      this.trackedEntityKind = null;
      this.trackedCartesian = null;
      this.flightsLayer.setCockpitActive(false);
      this.releaseTrackedCamera();
      useDisplayStore.getState().setCockpitMode(false);
      useHudStore.getState().setRouteOverviewActive(false);
      useHudStore.getState().setSelectedEntity(null);
      return;
    }

    const eq = this.earthquakesLayer.getTickData();
    const cam = this.cctvLayer.getTickData();
    const sat = this.satellitesLayer.tick(Date.now());
    const fl = this.flightsLayer.tick(Date.now());
    const vs = this.vesselsLayer.tick(Date.now());

    const info: SelectedEntityInfo | null =
      fl.selectedInfo ||
      vs.selectedInfo ||
      sat.selectedInfo ||
      eq.selectedInfo ||
      cam.selectedInfo;
    if (!info) return;

    this.trackedEntityKind = info.kind;
    useHudStore.getState().setSelectedEntity(info);

    if (info.kind === 'flight' || info.kind === 'military') {
      this.trackedHeadingDeg = fl.trackedHeadingDeg;
      this.cockpitHeadingDeg = fl.trackedHeadingDeg;
      this.cockpitAnchor = null;
      this.lastCockpitFrameMs = performance.now();
      useDisplayStore.getState().setAutoOrbit(false);
      useHudStore.getState().setRouteOverviewActive(false);

      if (enterCockpit) {
        this.flightsLayer.setCockpitActive(true);
        useDisplayStore.getState().setCockpitMode(true);
        this.releaseTrackedCamera();
      } else {
        this.flightsLayer.setCockpitActive(false);
        useDisplayStore.getState().setCockpitMode(false);
        this.attachFollowCamera(info.kind, info.altM, fl.trackedHeadingDeg);
      }
      return;
    }

    this.flightsLayer.setCockpitActive(false);
    useDisplayStore.getState().setCockpitMode(false);
    useHudStore.getState().setRouteOverviewActive(false);

    if (info.kind === 'satellite') {
      useDisplayStore.getState().setAutoOrbit(false);
      this.attachFollowCamera('satellite', info.altM, 0);
      return;
    }

    if (info.kind === 'vessel') {
      this.flyToTarget(info.lat, info.lon, info.altM, 5_000, vs.trackedHeadingDeg, -40);
      return;
    }

    const range = info.kind === 'cctv' ? 350 : 450_000;
    const pitch = info.kind === 'cctv' ? -35 : -55;
    this.flyToTarget(info.lat, info.lon, info.altM, range, 0, pitch);
  }

  clearSelection() {
    this.selectAndTrackEntity(null, false);
  }

  viewSelectedFlightRoute() {
    if (!this.viewer || this.viewer.isDestroyed() || !this.selectedEntityId) return;
    const points = this.flightsLayer.getFullRoutePositions(Date.now());
    if (!points || points.length < 2) {
      useUiStore.getState().showToast('Gathering route path points…', 'info');
      return;
    }
    this.flightsLayer.setCockpitActive(false);
    useDisplayStore.getState().setCockpitMode(false);
    useDisplayStore.getState().setAutoOrbit(false);
    this.releaseTrackedCamera();

    const sphere = this.Cesium.BoundingSphere.fromPoints(points);
    const radius = Math.max(sphere.radius, 8_000);
    const range = Math.max(22_000, radius * 2.45);
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.4,
      offset: new this.Cesium.HeadingPitchRange(
        this.Cesium.Math.toRadians(this.trackedHeadingDeg || 0),
        this.Cesium.Math.toRadians(-52),
        range,
      ),
    });
    useHudStore.getState().setRouteOverviewActive(true);
  }

  followSelectedTarget() {
    if (!this.selectedEntityId) return;
    const fl = this.flightsLayer.tick(Date.now());
    if (!fl.selectedInfo) return;
    this.flightsLayer.setCockpitActive(false);
    useDisplayStore.getState().setCockpitMode(false);
    useDisplayStore.getState().setAutoOrbit(false);
    useHudStore.getState().setRouteOverviewActive(false);
    this.attachFollowCamera(fl.selectedInfo.kind as 'flight' | 'military', fl.selectedInfo.altM, fl.trackedHeadingDeg);
  }

  async refreshFlightPrediction() {
    return this.flightsLayer.triggerAiPrediction(true);
  }

  flyToNearestCctv(lat: number, lon: number) {
    if (!useLayerStore.getState().layers.cctv.enabled) {
      useLayerStore.getState().setLayerEnabled('cctv', true);
    }
    const cam = this.cctvLayer.findNearestCamera(lat, lon);
    if (!cam) {
      useUiStore.getState().showToast('Loading CCTV catalog or no camera in range', 'warn');
      return;
    }
    this.selectAndTrackEntity(`cctv:${cam.id}`, false);
  }

  flyTo(lat: number, lon: number, altM: number, headingDeg = 0, pitchDeg = -35) {
    if (!this.viewer || this.viewer.isDestroyed()) return;
    useDisplayStore.getState().setAutoOrbit(false);
    this.releaseTrackedCamera();
    this.viewer.camera.flyTo({
      destination: this.Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(80, altM)),
      orientation: {
        heading: this.Cesium.Math.toRadians(headingDeg),
        pitch: this.Cesium.Math.toRadians(pitchDeg),
        roll: 0,
      },
      duration: 1.6,
    });
  }

  resetGlobe() {
    this.clearSelection();
    this.flyTo(
      GLOBE_OVERVIEW.lat,
      GLOBE_OVERVIEW.lon,
      GLOBE_OVERVIEW.alt,
      GLOBE_OVERVIEW.heading,
      GLOBE_OVERVIEW.pitch,
    );
  }

  setTilt(mode: 'oblique' | 'nadir') {
    const carto = this.viewer.camera.positionCartographic;
    if (!carto) return;
    const pitchDeg = mode === 'oblique' ? -35 : -89;
    const dest = this.viewer.trackedEntity
      ? this.viewer.camera.position.clone()
      : this.viewer.camera.positionWC.clone();
    this.viewer.camera.flyTo({
      destination: dest,
      orientation: {
        heading: this.viewer.camera.heading,
        pitch: this.Cesium.Math.toRadians(pitchDeg),
        roll: 0,
      },
      duration: 0.65,
    });
  }

  setNorthUp() {
    const dest = this.viewer.trackedEntity
      ? this.viewer.camera.position.clone()
      : this.viewer.camera.positionWC.clone();
    this.viewer.camera.flyTo({
      destination: dest,
      orientation: {
        heading: 0,
        pitch: this.viewer.camera.pitch,
        roll: 0,
      },
      duration: 0.55,
    });
  }

  private bindStores() {
    this.unsubscribes.push(
      useDisplayStore.subscribe((state, prev) => {
        if (
          state.style !== prev.style ||
          state.styleParams !== prev.styleParams ||
          state.sharpenEnabled !== prev.sharpenEnabled ||
          state.sharpenIntensity !== prev.sharpenIntensity ||
          state.bloomEnabled !== prev.bloomEnabled ||
          state.bloomIntensity !== prev.bloomIntensity
        ) {
          this.syncVisualEffects();
        }
        if (state.models3dMode !== prev.models3dMode) {
          this.flightsLayer.setModels3dMode(state.models3dMode);
        }
        if (state.mapStack !== prev.mapStack) {
          void this.switchMapStack(state.mapStack);
        }
        if (state.cockpitMode !== prev.cockpitMode) {
          this.flightsLayer.setCockpitActive(state.cockpitMode);
          this.cockpitAnchor = null;
          this.cockpitLookTarget = { yawDeg: 0, pitchDeg: LOOK_REST_PITCH_DEG };
          this.cockpitLookView = { yawDeg: 0, pitchDeg: LOOK_REST_PITCH_DEG };
          useHudStore.getState().setCockpitLook(this.cockpitLookTarget);
          if (!this.viewer.isDestroyed()) {
            this.viewer.scene.screenSpaceCameraController.enableInputs = !state.cockpitMode;
          }
          if (state.cockpitMode) {
            void ensureGeoidReady();
            this.releaseTrackedCamera();
            this.cockpitHeadingDeg = this.trackedHeadingDeg;
            this.lastCockpitFrameMs = performance.now();
          } else if (
            this.selectedEntityId &&
            (this.trackedEntityKind === 'flight' || this.trackedEntityKind === 'military')
          ) {
            const fl = this.flightsLayer.tick(Date.now());
            if (fl.selectedInfo && (fl.selectedInfo.kind === 'flight' || fl.selectedInfo.kind === 'military')) {
              this.attachFollowCamera(
                fl.selectedInfo.kind,
                fl.selectedInfo.altM,
                fl.trackedHeadingDeg,
              );
            }
          }
        }
      }),
    );

    this.unsubscribes.push(
      useLayerStore.subscribe((state, prev) => {
        if (state.layers.flights.enabled !== prev.layers.flights.enabled) {
          this.flightsLayer.setEnabled('flights', state.layers.flights.enabled);
        }
        if (state.layers.military.enabled !== prev.layers.military.enabled) {
          this.flightsLayer.setEnabled('military', state.layers.military.enabled);
        }
        if (state.layers.vessels.enabled !== prev.layers.vessels.enabled) {
          this.vesselsLayer.setEnabled(state.layers.vessels.enabled);
        }
        if (state.layers.traffic.enabled !== prev.layers.traffic.enabled) {
          this.trafficLayer.setEnabled(state.layers.traffic.enabled);
        }
        if (state.trafficLines !== prev.trafficLines) {
          this.trafficLayer.setLinesEnabled(state.trafficLines);
        }
        if (state.layers.satellites.enabled !== prev.layers.satellites.enabled) {
          this.satellitesLayer.setEnabled(state.layers.satellites.enabled);
        }
        if (state.layers.earthquakes.enabled !== prev.layers.earthquakes.enabled) {
          this.earthquakesLayer.setEnabled(state.layers.earthquakes.enabled);
        }
        if (state.layers.cctv.enabled !== prev.layers.cctv.enabled) {
          this.cctvLayer.setEnabled(state.layers.cctv.enabled);
        }
        if (state.cctvCoverageMode !== prev.cctvCoverageMode) {
          this.cctvLayer.setCoverageMode(state.cctvCoverageMode);
        }
        if (state.satelliteClasses !== prev.satelliteClasses) {
          this.satellitesLayer.setClasses(state.satelliteClasses);
        }
      }),
    );

    this.unsubscribes.push(
      useHudStore.subscribe((state, prev) => {
        if (
          state.trackTargetNonce &&
          state.trackTargetNonce !== prev.trackTargetNonce
        ) {
          this.selectAndTrackEntity(
            state.trackTargetNonce.entityId,
            state.trackTargetNonce.cockpit,
          );
        }
      }),
    );

    this.unsubscribes.push(
      useLocationStore.subscribe((state, prev) => {
        if (state.flyToRequest && state.flyToRequest !== prev.flyToRequest) {
          const req = state.flyToRequest;
          this.flyTo(req.lat, req.lon, req.alt, req.heading ?? 0, req.pitch ?? -35);
        }
        if (state.resetGlobeNonce !== prev.resetGlobeNonce) {
          this.resetGlobe();
        }
        if (state.tiltMode !== prev.tiltMode) {
          this.setTilt(state.tiltMode);
        }
        if (state.northUpNonce !== prev.northUpNonce) {
          this.setNorthUp();
        }
      }),
    );
  }

  private startLoop() {
    this.removePreUpdate = this.viewer.scene.preUpdate.addEventListener(() => {
      if (this.destroyed || this.viewer.isDestroyed()) return;

      const nowMs = Date.now();
      const perfNow = performance.now();
      this.frameCounter++;
      if (perfNow - this.lastFpsTick >= 500) {
        this.measuredFps = Math.round((this.frameCounter * 1000) / (perfNow - this.lastFpsTick));
        this.frameCounter = 0;
        this.lastFpsTick = perfNow;
      }

      const display = useDisplayStore.getState();

      // Auto-orbit spin (around free globe or tracked entity)
      if (display.autoOrbit && (!this.selectedEntityId || (this.trackedFollowEntity && !display.cockpitMode))) {
        this.viewer.camera.rotateRight(0.0012);
      }

      // Tick live data layers in lockstep with Cesium render frames
      const trafficDtSec = this.lastTrafficLoopMs
        ? Math.min(0.1, Math.max(0.001, (perfNow - this.lastTrafficLoopMs) / 1000))
        : 0.016;
      this.lastTrafficLoopMs = perfNow;
      this.trafficLayer.tick(trafficDtSec);

      const flightsTick = this.flightsLayer.tick(nowMs);
      const vesselsTick = this.vesselsLayer.tick(nowMs);
      const satsTick = this.satellitesLayer.tick(nowMs);
      const eqTick = this.earthquakesLayer.getTickData();
      const cctvTick = this.cctvLayer.getTickData();
      const trafficTick = this.trafficLayer.getTickData();

      const trackedPos = flightsTick.trackedCartesian || satsTick.trackedCartesian;
      if (!display.cockpitMode || !flightsTick.trackedCartesian) {
        this.cockpitAnchor = null;
      }
      if (trackedPos && display.cockpitMode && flightsTick.trackedCartesian) {
        const dtSec = Math.min(0.1, Math.max(0.001, (perfNow - this.lastCockpitFrameMs) / 1000));
        this.lastCockpitFrameMs = perfNow;
        this.cockpitHeadingDeg = slewHeadingDeg(
          this.cockpitHeadingDeg,
          flightsTick.trackedHeadingDeg,
          28 * dtSec,
        );
        this.cockpitLookView = easeLook(this.cockpitLookView, this.cockpitLookTarget, dtSec * 1000);
        const hRad = this.Cesium.Math.toRadians(this.cockpitHeadingDeg);
        const viewHeadingRad = this.Cesium.Math.toRadians(
          this.cockpitHeadingDeg + this.cockpitLookView.yawDeg,
        );
        const pitchRad = this.Cesium.Math.toRadians(this.cockpitLookView.pitchDeg);
        const targetPos = flightsTick.trackedCartesian;

        if (
          !this.cockpitAnchor ||
          this.Cesium.Cartesian3.distance(this.cockpitAnchor, targetPos) > 50_000
        ) {
          this.cockpitAnchor = this.Cesium.Cartesian3.clone(targetPos);
        } else if (!flightsTick.trackedStale) {
          // Advance inertially in local ENU along smoothed heading, then gently converge toward targetPos
          const speedMps = Math.max(0, flightsTick.trackedSpeedMps);
          const forwardM = speedMps * dtSec;
          this.cockpitEnuFrame ??= new this.Cesium.Matrix4();
          this.cockpitVec4A ??= new this.Cesium.Cartesian4();
          this.cockpitVec4B ??= new this.Cesium.Cartesian4();
          this.cockpitDiffVec ??= new this.Cesium.Cartesian3();

          const enuFrame = this.Cesium.Transforms.eastNorthUpToFixedFrame(
            this.cockpitAnchor,
            undefined,
            this.cockpitEnuFrame,
          );
          const east = this.Cesium.Matrix4.getColumn(enuFrame, 0, this.cockpitVec4A);
          const north = this.Cesium.Matrix4.getColumn(enuFrame, 1, this.cockpitVec4B);
          const headingSin = Math.sin(hRad);
          const headingCos = Math.cos(hRad);
          this.cockpitAnchor.x += (east.x * headingSin + north.x * headingCos) * forwardM;
          this.cockpitAnchor.y += (east.y * headingSin + north.y * headingCos) * forwardM;
          this.cockpitAnchor.z += (east.z * headingSin + north.z * headingCos) * forwardM;

          const diff = this.Cesium.Cartesian3.subtract(targetPos, this.cockpitAnchor, this.cockpitDiffVec);
          const distM = this.Cesium.Cartesian3.magnitude(diff);
          if (distM > 0.01) {
            const corrStep = cockpitAnchorCorrectionStep(distM, speedMps, dtSec);
            const ratio = Math.min(1, corrStep / distM);
            this.cockpitAnchor.x += diff.x * ratio;
            this.cockpitAnchor.y += diff.y * ratio;
            this.cockpitAnchor.z += diff.z * ratio;
          }
        }

        const anchorCarto = this.Cesium.Cartographic.fromCartesian(this.cockpitAnchor);
        const targetCarto = this.Cesium.Cartographic.fromCartesian(targetPos);
        const lat = this.Cesium.Math.toDegrees(anchorCarto.latitude);
        const lon = this.Cesium.Math.toDegrees(anchorCarto.longitude);
        const forwardLat = lat + (7 * Math.cos(hRad)) / 111_320;
        const forwardLon = lon + (7 * Math.sin(hRad)) / (111_320 * Math.max(0.15, Math.cos((lat * Math.PI) / 180)));
        const safeAltM = Math.max(
          targetCarto.height + 2.6,
          geoidHeightOrZero(forwardLat, forwardLon) + 12,
        );
        const eyeDest = this.Cesium.Cartesian3.fromDegrees(forwardLon, forwardLat, safeAltM);

        // Build local ENU basis at eye position so yaw/pitch look works smoothly without gimbal lock
        this.cockpitEnuFrame ??= new this.Cesium.Matrix4();
        this.cockpitLocalVec ??= new this.Cesium.Cartesian3();
        this.cockpitForwardVec ??= new this.Cesium.Cartesian3();
        this.cockpitUpVec ??= new this.Cesium.Cartesian3();
        const eyeEnu = this.Cesium.Transforms.eastNorthUpToFixedFrame(
          eyeDest,
          this.Cesium.Ellipsoid.WGS84,
          this.cockpitEnuFrame,
        );

        this.cockpitLocalVec.x = Math.sin(viewHeadingRad) * Math.cos(pitchRad);
        this.cockpitLocalVec.y = Math.cos(viewHeadingRad) * Math.cos(pitchRad);
        this.cockpitLocalVec.z = Math.sin(pitchRad);
        this.Cesium.Matrix4.multiplyByPointAsVector(eyeEnu, this.cockpitLocalVec, this.cockpitForwardVec);
        this.Cesium.Cartesian3.normalize(this.cockpitForwardVec, this.cockpitForwardVec);

        this.cockpitLocalVec.x = -Math.sin(viewHeadingRad) * Math.sin(pitchRad);
        this.cockpitLocalVec.y = -Math.cos(viewHeadingRad) * Math.sin(pitchRad);
        this.cockpitLocalVec.z = Math.cos(pitchRad);
        this.Cesium.Matrix4.multiplyByPointAsVector(eyeEnu, this.cockpitLocalVec, this.cockpitUpVec);
        this.Cesium.Cartesian3.normalize(this.cockpitUpVec, this.cockpitUpVec);

        this.viewer.camera.setView({
          destination: eyeDest,
          orientation: {
            direction: this.cockpitForwardVec,
            up: this.cockpitUpVec,
          },
        });

        if (perfNow - this.lastCockpitLookSyncMs >= 100) {
          this.lastCockpitLookSyncMs = perfNow;
          useHudStore.getState().setCockpitLook({ ...this.cockpitLookView });
        }
      }
      this.trackedCartesian = trackedPos;
      this.trackedHeadingDeg = flightsTick.trackedHeadingDeg;

      // Render 2D screen-space detection mesh
      const allTargets: DetectionTarget[] = [
        ...flightsTick.detectionTargets,
        ...vesselsTick.detectionTargets,
        ...satsTick.detectionTargets,
        ...trafficTick.detectionTargets,
        ...eqTick.detectionTargets,
        ...cctvTick.detectionTargets,
      ];
      renderDetectionOverlay(this.overlayCanvas, this.viewer, this.Cesium, allTargets, {
        mode: display.detectionMode,
        densityPct: display.detectionDensity,
        style: display.style,
        selectedEntityId: this.selectedEntityId,
      });

      // Publish HUD telemetry at ~8 Hz
      if (perfNow - this.lastHudUpdate >= 120) {
        this.lastHudUpdate = perfNow;
        const carto = this.viewer.camera.positionCartographic;
        if (carto) {
          const lat = this.Cesium.Math.toDegrees(carto.latitude);
          const lon = this.Cesium.Math.toDegrees(carto.longitude);
          const altM = Math.max(0, carto.height);
          const pitchDeg = this.Cesium.Math.toDegrees(this.viewer.camera.pitch);
          const offNadir = Math.max(0, Math.min(90, Math.round(90 + pitchDeg)));
          const nowDate = new Date(nowMs);
          const utcTime = nowDate.toISOString().slice(11, 19) + 'Z';
          const sunElev = estimateSunElevationDeg(lat, lon, nowDate);
          const { gsdText } = estimateGsdAndNiirs(altM);
          const selectedInfo =
            flightsTick.selectedInfo ||
            vesselsTick.selectedInfo ||
            satsTick.selectedInfo ||
            eqTick.selectedInfo ||
            cctvTick.selectedInfo ||
            null;

          useHudStore.getState().updateTelemetry({
            lat,
            lon,
            altM,
            mgrs: toMgrsSafe(lat, lon),
            latlonText: formatDms(lat, lon),
            gsdText,
            altText: formatAltMsl(altM),
            collText: `COLL ${utcTime}`,
            onaText: `ONA ${offNadir.toFixed(1)}°  SUN ${sunElev}°`,
            utcTimestamp: utcTime,
            regionLabel: classifyRegion(lat, lon),
            fps: this.measuredFps,
            nearbyContacts: flightsTick.nearbyContacts,
            ...(this.selectedEntityId && selectedInfo ? { selectedEntity: selectedInfo } : {}),
          });
        }
      }
    });
  }

  destroy() {
    this.destroyed = true;
    registerGlobeEngine(null);
    this.removePreUpdate?.();
    this.removePreUpdate = null;
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
    this.releaseTrackedCamera();
    for (const unsub of this.unsubscribes) unsub();
    this.unsubscribes = [];
    this.pickHandler?.destroy();
    this.flightsLayer?.destroy();
    this.vesselsLayer?.destroy();
    this.trafficLayer?.destroy();
    this.satellitesLayer?.destroy();
    this.earthquakesLayer?.destroy();
    this.cctvLayer?.destroy();
    if (this.viewer && !this.viewer.isDestroyed()) {
      this.viewer.destroy();
    }
  }
}
