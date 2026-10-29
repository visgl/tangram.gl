// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {expect, test} from 'vitest';

const repositoryDirectory = resolve(import.meta.dirname, '..');

test('built renderer and deck-layer entries import in a clean Node SSR process', () => {
  const script = `
    import assert from 'node:assert/strict';
    const globals = ['self', 'window', 'document'];
    for (const name of globals) assert.equal(name in globalThis, false, name);
    const renderer = await import('@tangram.gl/tangram-renderer');
    const core = await import('@tangram.gl/tangram-renderer/core');
    const mapLogic = await import('@tangram.gl/tangram-renderer/map-logic');
    const shaderModules = await import('@tangram.gl/tangram-renderer/experimental/shader-modules');
    const layer = await import('@tangram.gl/tangram-layers');
    assert.equal(typeof renderer.Scene, 'function');
    assert.equal(typeof core.Renderer, 'function');
    assert.ok(Object.keys(mapLogic).length > 0);
    assert.ok(Object.keys(shaderModules).length > 0);
    assert.equal(typeof layer.TangramLayer, 'function');
    for (const name of globals) assert.equal(name in globalThis, false, name);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    timeout: 30_000
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

test('a server-side self polyfill is not mistaken for a browser worker', () => {
  const script = `
    import assert from 'node:assert/strict';
    globalThis.self = globalThis;
    await import('@tangram.gl/tangram-renderer/core');
    assert.equal(globalThis.self, globalThis);
    assert.equal('window' in globalThis, false);
    assert.equal('document' in globalThis, false);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repositoryDirectory,
    encoding: 'utf8',
    timeout: 30_000
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
