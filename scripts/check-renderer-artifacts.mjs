// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {existsSync, readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const rendererDirectory = resolve(repositoryRoot, 'modules/tangram-renderer');
const rendererPackage = JSON.parse(readFileSync(resolve(rendererDirectory, 'package.json'), 'utf8'));
const requiredArtifacts = [
  'dist/types/index.d.ts',
  'dist/types/core.d.ts',
  'dist/types/types.d.ts',
  'dist/types/map-logic/index.d.ts',
  'dist/map-logic.js',
  'dist/index.js',
  'dist/core.js',
  'dist/core.js.map',
  'dist/style-schema.js',
  'dist/loaders-gl-worker.js',
  'dist/projected-basemaps-worker.js',
  'dist/projected-basemaps-worker.js.map',
  'dist/loaders-gl-worker.js.map',
  'dist/tangram-style.schema.json',
  'dist/tangram.debug.mjs',
  'dist/tangram.debug.mjs.map',
  'dist/tangram.min.mjs'
];

for (const obsoleteOutput of ['tangram.debug.js', 'tangram.debug.js.map', 'tangram.min.js']) {
  if (existsSync(resolve(rendererDirectory, 'dist', obsoleteOutput))) {
    throw new Error(`Obsolete classic-script renderer output remains: ${obsoleteOutput}`);
  }
}

for (const artifactPath of requiredArtifacts) {
  const absolutePath = resolve(rendererDirectory, artifactPath);
  if (statSync(absolutePath).size === 0) {
    throw new Error(`Renderer artifact is empty: ${artifactPath}`);
  }
}

const expectedExports = {
  '.': './dist/index.js',
  './core': './dist/core.js',
  './map-logic': './dist/map-logic.js',
  './style-schema': './dist/style-schema.js',
  './tangram-style.schema.json': './dist/tangram-style.schema.json'
};
for (const [exportPath, expectedTarget] of Object.entries(expectedExports)) {
  const packageExport = rendererPackage.exports[exportPath];
  const actualTarget = typeof packageExport === 'string' ? packageExport : packageExport?.import;
  if (actualTarget !== expectedTarget) {
    throw new Error(
      `Renderer export ${exportPath} changed from ${expectedTarget} to ${String(actualTarget)}`
    );
  }
}

const rendererEntry = readFileSync(resolve(rendererDirectory, 'dist/index.js'), 'utf8');
const exportBlock = rendererEntry.match(/export\s*\{([\s\S]*?)\};/)?.[1] ?? '';
const exportedNames = new Set(
  exportBlock
    .split(',')
    .map(exportSpecifier => exportSpecifier.trim().split(/\s+as\s+/)[0])
    .filter(Boolean)
);
for (const exportName of [
  'TerrainMeshSurface',
  'pickTerrainAt',
  'Scene',
  'ClassicWebGLRenderer',
  'Renderer',
  'HostFrame',
  'LumaDeviceRenderer',
  'calculatePlanarGroundBounds',
  'calculatePlanarVolumeBounds',
  'convertLumaLight',
  'mapTangramLight',
  'debug',
  'version',
  'default'
]) {
  const isExported = exportName === 'default' ? /export default/.test(rendererEntry) : exportedNames.has(exportName);
  if (!isExported) {
    throw new Error(`Renderer package entry is missing export: ${exportName}`);
  }
}

// Check the bundle exports as well as the shim: a valid shim can import a name
// that the generated entry accidentally omitted. Include minified public names.
for (const bundlePath of ['dist/tangram.debug.mjs', 'dist/tangram.min.mjs', 'dist/core.js']) {
  const bundle = readFileSync(resolve(rendererDirectory, bundlePath), 'utf8');
  const bundleExportNames = new Set(
    [...bundle.matchAll(/\bexport\s*\{([^}]+)\}/g)].flatMap(match =>
      match[1].split(',').map(specifier => specifier.trim().split(/\s+as\s+/).at(-1))
    )
  );
  for (const exportName of ['TerrainMeshSurface', 'pickTerrainAt', 'convertLumaLight', 'mapTangramLight', 'calculatePlanarVolumeBounds']) {
    if (!bundleExportNames.has(exportName)) {
      throw new Error(`${bundlePath} is missing export: ${exportName}`);
    }
  }
  if (bundlePath === 'dist/core.js') {
    for (const exportName of ['PROJECTION_CONSTANTS', 'projectGeographicPosition', 'projectGeographicVector', 'unprojectGlobePosition']) {
      if (!bundleExportNames.has(exportName)) throw new Error(`${bundlePath} is missing export: ${exportName}`);
    }
  }
}

for (const bundlePath of ['dist/tangram.debug.mjs']) {
  const bundle = readFileSync(resolve(rendererDirectory, bundlePath), 'utf8');
  if (!/workerURL\s*=\s*(?:window\.)?URL\.createObjectURL/.test(bundle)) {
    throw new Error(`${bundlePath} does not assemble a worker URL`);
  }
  for (const contractMarker of ['workerURL', 'HostFrame', 'LumaDeviceRenderer']) {
    if (!bundle.includes(contractMarker)) {
      throw new Error(`${bundlePath} is missing contract marker: ${contractMarker}`);
    }
  }
  if (!/globalThis\.Tangram\s*=/.test(bundle)) {
    throw new Error(`${bundlePath} does not expose the Tangram global`);
  }
}

console.log(`Renderer artifact contract is valid (${requiredArtifacts.length} files).`);
