# God's Eye View — Next.js Recreation

A Next.js 16 (App Router) + TypeScript + Zustand + CesiumJS recreation of [`bilawalsidhu/gods-eye-view`](https://github.com/bilawalsidhu/gods-eye-view).

## Implemented MVP Architecture

- **Framework & State**: Next.js 16 App Router, React 19, TypeScript, Tailwind CSS v4, and Zustand stores (`src/stores/`).
- **3D Globe Engine (`src/engine/GlobeEngine.ts`)**:
  - Client-only CesiumJS (`1.138.0`) viewport with Milky Way skybox (`public/sky/`) and `CESIUM_BASE_URL=/cesium` static asset pipeline (`scripts/copy-cesium.mjs`).
  - **Basemap Ladder (`src/engine/mapStacks.ts`)**: Keyless Esri World Imagery + Re:Earth terrain (with automatic OpenStreetMap fallback), plus optional Google Photorealistic 3D Tiles and Cesium ion / Bing imagery.
  - **GLSL Post-Processing (`src/engine/shaders.ts`)**: `Normal`, `CRT`, `NVG`, `FLIR` (White-Hot / Black-Hot + Ironbow), `Anime`, and `Noir` shaders, plus unsharp-mask sharpening and bloom with live uniform sliders.
  - **Tactical HUD & Detection Mesh (`src/components/IntelHud.tsx`, `src/engine/detectionOverlay.ts`)**: 4-corner reconnaissance HUD with MGRS, DMS, GSD/NIIRS estimation, UTC clock, and screen-space target bounding brackets (`OFF` / `SPARSE` / `DENSE`).
- **Live Data Layers & Next.js Route Handlers (`src/app/api/`)**:
  - **Flights & Military Flights** (`/api/flights`, `/api/military`): OpenSky Network + `adsb.lol` regional & military feeds with dead reckoning, 3D glTF aircraft models (`public/models/*.glb`), click-to-track flight trails, and **Cockpit Ride Mode** with a 250 km Contacts roster.
  - **Live Vessels** (`/api/vessels`, `/api/vessels/track`): Persistent server-side AISStream WebSocket (`ws`) with ITU-R M.1371 sentinel handling, ship-type chevron color coding, screen-projected bow headings, dead reckoning, and 64-sample wake trails (requires `AISSTREAM_API_KEY`).
  - **Satellites** (`/api/celestrak/[group]`): Real-time SGP4 propagation via `satellite.js` with class filters and orbital ring visualization.
  - **Earthquakes** (`/api/earthquakes`): USGS M2.5+ 24-hour GeoJSON feed.
  - **CCTV Mesh** (`/api/cctv/sources`, `/api/cctv/frame/[id]`): Public traffic/city cameras (Austin, TfL London JamCams, Tallinn, Romania, World image cameras) with optional viewshed cones and live refreshing frame previews.
  - **Geocoding & Provider Settings** (`/api/geocode`, `/api/setup/status`, `/api/setup/keys`): Keyless decimal/`geo:`/preset search + Nominatim proxy, and in-app **POWER UP** key saver (`.env.local`, loopback-gated).

## Quick Start

```bash
npm install
npm run dev
```

Open `http://localhost:4173`.

## Keyboard Shortcuts

- `1`–`6`: Visual sensor presets (`Normal`, `CRT`, `NVG`, `FLIR`, `Anime`, `Noir`)
- `H`: Toggle Intel HUD
- `D`: Cycle Detection overlay (`OFF` → `SPARSE` → `DENSE`)
- `C`: Toggle CCTV layer
- `` ` ``: Toggle FPS readout
- `Esc`: Dismiss modal / exit Cockpit or Clean View / release target lock
