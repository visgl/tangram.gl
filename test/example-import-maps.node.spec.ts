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
});
