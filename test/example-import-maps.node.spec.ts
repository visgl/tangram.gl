// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {expect, test} from 'vitest';

test.each([
  'examples/deck/index.html',
  'examples/webxr/index.html',
  'website/src/components/DeckExample.js',
  'website/src/components/TronHeroBackground.js',
  'website/src/components/WebXRExample.js'
])('%s resolves every published TangramLayer package import', filePath => {
  const entry = readFileSync(new URL('../modules/tangram-layers/dist/index.js', import.meta.url), 'utf8');
  const source = readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');
  const imports = [...entry.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(match => match[1]);
  expect(imports).toContain('@math.gl/core');
  for (const importName of new Set(imports)) {
    expect(source, `Missing browser mapping for ${importName}`).toMatch(
      new RegExp(`["']${importName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:`)
    );
  }
});
