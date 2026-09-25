// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync, statSync} from 'node:fs';
import {resolve} from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const rendererDirectory = resolve(repositoryRoot, 'modules/tangram-renderer');
const rendererPackage = JSON.parse(readFileSync(resolve(rendererDirectory, 'package.json'), 'utf8'));
const requiredArtifacts = [
  'dist/index.js',
  'dist/style-schema.js',
  'dist/tangram-style.schema.json',
  'dist/tangram.debug.js',
  'dist/tangram.debug.js.map',
  'dist/tangram.debug.mjs',
  'dist/tangram.debug.mjs.map',
  'dist/tangram.min.js',
  'dist/tangram.min.mjs'
];

for (const artifactPath of requiredArtifacts) {
  const absolutePath = resolve(rendererDirectory, artifactPath);
  if (statSync(absolutePath).size === 0) {
    throw new Error(`Renderer artifact is empty: ${artifactPath}`);
  }
}

const expectedExports = {
  '.': './dist/index.js',
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
  'Scene',
  'ClassicWebGLRenderer',
  'Renderer',
  'HostFrame',
  'LumaDeviceRenderer',
  'debug',
  'version',
  'default'
]) {
  const isExported = exportName === 'default' ? /export default/.test(rendererEntry) : exportedNames.has(exportName);
  if (!isExported) {
    throw new Error(`Renderer package entry is missing export: ${exportName}`);
  }
}

for (const bundlePath of ['dist/tangram.debug.js', 'dist/tangram.debug.mjs']) {
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
