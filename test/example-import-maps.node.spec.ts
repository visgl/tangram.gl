// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {existsSync, readFileSync} from 'node:fs';
import {transpileModule, ModuleKind} from 'typescript';
import {expect, test} from 'vitest';

/** Collect runtime package imports from the source graph, without generating dist. */
function collectPackageImports(entry: URL, visited = new Set<string>()): Set<string> {
  const imports = new Set<string>();
  if (visited.has(entry.href)) return imports;
  visited.add(entry.href);
  // Type-only imports disappear in transpilation and do not need browser mappings.
  const {outputText} = transpileModule(readFileSync(entry, 'utf8'), {
    fileName: entry.pathname,
    compilerOptions: {module: ModuleKind.ESNext}
  });
  for (const match of outputText.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    const importName = match[1];
    if (!importName.startsWith('.')) {
      imports.add(importName);
      continue;
    }
    const candidates = [importName, `${importName}.ts`, `${importName}/index.ts`];
    const dependency = candidates.map(path => new URL(path, entry)).find(path => existsSync(path));
    if (!dependency) throw new Error(`Unable to resolve ${importName} from ${entry.href}`);
    for (const packageImport of collectPackageImports(dependency, visited)) imports.add(packageImport);
  }
  return imports;
}

const packageImports = collectPackageImports(new URL('../modules/tangram-layers/src/index.ts', import.meta.url));
const rendererPackage = JSON.parse(readFileSync(new URL('../modules/tangram-renderer/package.json', import.meta.url), 'utf8'));
const mathVersion = rendererPackage.dependencies['@math.gl/core'];

test.each([
  'examples/deck/index.html',
  'examples/webxr/index.html',
  'website/src/components/DeckExample.js',
  'website/src/components/TronHeroBackground.js',
  'website/src/components/WebXRExample.js'
])('%s resolves every TangramLayer runtime source import', filePath => {
  const source = readFileSync(new URL(`../${filePath}`, import.meta.url), 'utf8');
  expect(packageImports).toContain('@math.gl/core');
  for (const importName of packageImports) {
    expect(source, `Missing browser mapping for ${importName}`).toMatch(
      new RegExp(`["']${importName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']\\s*:`)
    );
  }
  expect(source).toContain(`https://esm.sh/@math.gl/core@${mathVersion}?bundle`);
});

test('renderer loaders use one pinned v5 release and layer math peers match the renderer', () => {
  const loadersVersions = Object.entries(rendererPackage.devDependencies)
    .filter(([name]) => name.startsWith('@loaders.gl/'))
    .map(([, version]) => version);
  expect(loadersVersions.length).toBeGreaterThan(0);
  expect(new Set(loadersVersions).size).toBe(1);
  expect(loadersVersions[0]).toMatch(/^5\.0\.0-alpha\.\d+$/);
  expect(rendererPackage.dependencies['@math.gl/web-mercator']).toBe(mathVersion);
  const layerPackage = JSON.parse(readFileSync(new URL('../modules/tangram-layers/package.json', import.meta.url), 'utf8'));
  const xrPackage = JSON.parse(readFileSync(new URL('../examples/webxr/package.json', import.meta.url), 'utf8'));
  expect(layerPackage.peerDependencies['@math.gl/core']).toBe(mathVersion);
  expect(xrPackage.dependencies['@math.gl/core']).toBe(mathVersion);
});
