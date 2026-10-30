// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {describe, expect, test} from 'vitest';

const root = resolve(import.meta.dirname, '..');
const packageNames = ['tangram-renderer', 'tangram-layers', 'basemap-layers'];

describe('npm publication preparation', () => {
  test.each(packageNames)('%s has a public package identity', packageName => {
    const manifest = JSON.parse(readFileSync(resolve(root, `modules/${packageName}/package.json`), 'utf8'));
    expect(manifest.name).toBe(`@tangram.gl/${packageName}`);
    expect(manifest.version).toBe('0.0.0');
    expect(manifest.private ?? false).toBe(false);
    expect(manifest.publishConfig.access).toBe('public');
    expect(manifest.scripts.prepack).toBe('yarn build');
  });

  test('release preflight accepts the release version and rejects malformed versions', () => {
    for (const version of ['0.0.0', 'not-a-version']) {
      const result = spawnSync(process.execPath, ['scripts/check-publish-ready.mjs'], {
        cwd: root,
        env: {...process.env, RELEASE_VERSION: version},
        encoding: 'utf8'
      });
      if (version === '0.0.0') {
        expect(result.status, result.stderr).toBe(0);
      } else {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('exact npm version');
      }
    }
  });

  test('coverage resolves the renamed layer entry points to authored source', async () => {
    const {default: configPromise} = await import('../vitest.config.js');
    const config = await configPromise;
    const aliases = config.resolve?.alias;
    expect(Array.isArray(aliases)).toBe(true);
    if (!Array.isArray(aliases)) throw new Error('Expected ordered Vitest aliases');
    for (const specifier of [
      '@tangram.gl/tangram-layers',
      '@tangram.gl/tangram-layers/experimental/terrain',
      '@tangram.gl/tangram-layers/experimental/webxr'
    ]) {
      const alias = aliases.find(entry => entry.find instanceof RegExp && entry.find.test(specifier));
      expect(alias?.replacement).toContain('/modules/tangram-layers/src/');
    }
  });
});
