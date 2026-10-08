// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const repositoryDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function readPackageManifest(packageDirectory) {
  const manifestPath = resolve(repositoryDirectory, packageDirectory, 'package.json');
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

describe('workspace package manifests', () => {
  it('defines private renderer and layer entrypoints', async () => {
    const renderer = await readPackageManifest('modules/tangram-renderer');
    const layers = await readPackageManifest('modules/tangram-layers');

    expect(renderer.name).toBe('@vis.gl/tangram-renderer');
    expect(renderer.private).toBe(true);
    expect(renderer.types).toBe('dist/types/index.d.ts');
    expect(renderer.exports['.'].types).toBe('./dist/types/index.d.ts');
    expect(renderer.exports['.'].import).toBe('./dist/index.js');
    expect(layers.name).toBe('@vis.gl/tangram-layers');
    expect(layers.private).toBe(true);
    expect(layers.exports['.'].import).toBe('./dist/index.js');
    expect(layers.exports['./experimental/webxr'].import).toBe('./dist/experimental/webxr.js');
  });
});
