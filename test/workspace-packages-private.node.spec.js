// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readdir, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {describe, expect, test} from 'vitest';

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_PACKAGE_FILES = new Set([
  'modules/tangram-renderer/package.json',
  'modules/tangram-layers/package.json',
  'modules/basemap-layers/package.json'
].map(path => resolve(REPOSITORY_ROOT, path)));

describe('workspace package publication safety', () => {
  test.each(['modules', 'examples'])('only allows intended public packages in %s', async (directory) => {
    const workspaceDirectory = resolve(REPOSITORY_ROOT, directory);
    const packageFiles = [];
    const pendingDirectories = [workspaceDirectory];
    while (pendingDirectories.length) {
      const currentDirectory = pendingDirectories.pop();
      const entries = await readdir(currentDirectory, {withFileTypes: true});
      for (const entry of entries) {
        const path = resolve(currentDirectory, entry.name);
        if (entry.isFile() && entry.name === 'package.json') {
          packageFiles.push(path);
        } else if (entry.isDirectory() && !['node_modules', 'dist', 'build'].includes(entry.name)) {
          pendingDirectories.push(path);
        }
      }
    }

    expect(packageFiles.length).toBeGreaterThan(0);
    for (const packageFile of packageFiles) {
      const packageJson = JSON.parse(await readFile(packageFile, 'utf8'));
      if (PUBLIC_PACKAGE_FILES.has(packageFile)) {
        expect(packageJson.private ?? false, `${packageJson.name} should be public`).toBe(false);
      } else {
        expect(packageJson.private, `${packageJson.name} must remain private`).toBe(true);
      }
    }
  });
});
