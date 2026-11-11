import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cesiumBuildDir = path.join(root, 'node_modules', 'cesium', 'Build', 'Cesium');
const publicCesiumDir = path.join(root, 'public', 'cesium');

const SUBDIRS = ['Workers', 'Assets', 'Widgets', 'ThirdParty'];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

if (!fs.existsSync(cesiumBuildDir)) {
  console.log('[copy-cesium] Cesium not installed yet; skipping copy.');
  process.exit(0);
}

const markerFile = path.join(publicCesiumDir, '.cesium-version');
let installedVersion = 'unknown';
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, 'node_modules', 'cesium', 'package.json'), 'utf8'),
  );
  installedVersion = String(pkg.version || 'unknown');
} catch {
  // ignore
}

const allExist = SUBDIRS.every((dir) => fs.existsSync(path.join(publicCesiumDir, dir)));
const existingVersion = fs.existsSync(markerFile)
  ? fs.readFileSync(markerFile, 'utf8').trim()
  : '';

if (allExist && existingVersion === installedVersion) {
  process.exit(0);
}

console.log(`[copy-cesium] Syncing Cesium ${installedVersion} static assets to public/cesium...`);
fs.mkdirSync(publicCesiumDir, { recursive: true });
for (const dir of SUBDIRS) {
  const src = path.join(cesiumBuildDir, dir);
  const dst = path.join(publicCesiumDir, dir);
  if (fs.existsSync(src)) copyDir(src, dst);
}
fs.writeFileSync(markerFile, installedVersion + '\n', 'utf8');
console.log('[copy-cesium] Done.');
