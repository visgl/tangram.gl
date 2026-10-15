// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {preProcessFile} from 'typescript';
import {expect, test} from 'vitest';
import {MATH_BROWSER_ASSETS} from '../examples/browser-dependencies/math-assets.mjs';

const assetRoot = new URL('../examples/browser-dependencies/dist/', import.meta.url);

test.each(['deck', 'webxr', 'projected'])('%s standalone math imports stay under a non-root deployment base', example => {
  const source = readFileSync(new URL(`../examples/${example}/index.html`, import.meta.url), 'utf8');
  const map = JSON.parse(source.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1] ?? 'null');
  expect(map).not.toBeNull();
  const documentUrl = new URL(`examples/${example}/index.html`, 'https://example.test/nested/tangram.gl/');
  for (const [specifier, target] of Object.entries(map.imports)) {
    if (!specifier.startsWith('@math.gl/')) continue;
    const filename = new Map(Object.entries(MATH_BROWSER_ASSETS)).get(specifier);
    expect(filename).toBeDefined();
    expect(new URL(String(target), documentUrl).href).toBe(`https://example.test/nested/tangram.gl/examples/browser-dependencies/dist/${filename}`);
  }
});

test.each(Object.entries(MATH_BROWSER_ASSETS))('%s is built without CDN or unmapped imports', (specifier, filename) => {
  const source = readFileSync(new URL(filename, assetRoot), 'utf8');
  expect(source).toContain('third-party licenses: ./THIRD-PARTY-NOTICES.txt');
  const imports = preProcessFile(source).importedFiles.map(imported => imported.fileName);
  expect(imports.every(name => specifier !== '@math.gl/core' && name === '@math.gl/core')).toBe(true);
});

test('browser assets use renderer math versions and retain installed third-party notices', () => {
  const renderer = JSON.parse(readFileSync(new URL('../modules/tangram-renderer/package.json', import.meta.url), 'utf8'));
  const assets = JSON.parse(readFileSync(new URL('../examples/browser-dependencies/package.json', import.meta.url), 'utf8'));
  expect(assets.private).toBe(true);
  for (const [name, version] of Object.entries(assets.devDependencies)) {
    if (name.startsWith('@math.gl/')) expect(version).toBe(renderer.dependencies['@math.gl/core']);
  }
  const notices = readFileSync(new URL('THIRD-PARTY-NOTICES.txt', assetRoot), 'utf8');
  expect(notices).toContain(`@math.gl/core@${renderer.dependencies['@math.gl/core']}`);
  expect(notices).toContain('Permission is hereby granted');
  expect(notices).toContain('Apache License');
});
