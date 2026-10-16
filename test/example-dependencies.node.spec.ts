// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
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
    const candidates = [importName, importName.replace(/\.js$/, '.ts'), `${importName}.ts`, `${importName}/index.ts`];
    const dependency = candidates.map(path => new URL(path, entry)).find(path => existsSync(path));
    if (!dependency) throw new Error(`Unable to resolve ${importName} from ${entry.href}`);
    for (const packageImport of collectPackageImports(dependency, visited)) imports.add(packageImport);
  }
  return imports;
}

const packageImports = collectPackageImports(new URL('../modules/tangram-layers/src/index.ts', import.meta.url));
const webXRPackageImports = collectPackageImports(new URL('../modules/tangram-layers/src/experimental/webxr/index.ts', import.meta.url));
const rendererPackage = JSON.parse(readFileSync(new URL('../modules/tangram-renderer/package.json', import.meta.url), 'utf8'));
const mathVersion = rendererPackage.dependencies['@math.gl/core'];
const lumaVersion = rendererPackage.dependencies['@luma.gl/core'].replace(/^\^/, '');

test('renderer, layer peers and WebXR use one luma release, including the lazy WebGPU adapter', () => {
  const layerPackage = JSON.parse(readFileSync(new URL('../modules/tangram-layers/package.json', import.meta.url), 'utf8'));
  const xrPackage = JSON.parse(readFileSync(new URL('../examples/webxr/package.json', import.meta.url), 'utf8'));
  expect(rendererPackage.dependencies['@luma.gl/shadertools']).toBe(`^${lumaVersion}`);
  for (const [name, version] of Object.entries(layerPackage.peerDependencies)) {
    if (name.startsWith('@luma.gl/')) expect(version).toBe(`^${lumaVersion}`);
  }
  for (const [name, version] of Object.entries(xrPackage.dependencies)) {
    if (name.startsWith('@luma.gl/')) expect(version).toBe(lumaVersion);
  }
  const adapter = readFileSync(new URL('../examples/deck/app-runtime.js', import.meta.url), 'utf8');
  expect(adapter).toContain("from '@luma.gl/webgpu'");
});

test('deck.gl and the renderer resolve the same installed luma Device runtime', () => {
  const rendererRequire = createRequire(new URL('../modules/tangram-renderer/package.json', import.meta.url));
  const deckRequire = createRequire(rendererRequire.resolve('@deck.gl/core'));
  expect(deckRequire.resolve('@luma.gl/core')).toBe(rendererRequire.resolve('@luma.gl/core'));
});

test('classic playground keeps loaders core and its Arrow peer on the compatible 4.5 patch', () => {
  const classicPackage = JSON.parse(readFileSync(new URL('../examples/classic/package.json', import.meta.url), 'utf8'));
  const repositoryPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const coreVersion = classicPackage.devDependencies['@loaders.gl/core'].replace(/^\^/, '');
  expect(repositoryPackage.resolutions['@loaders.gl/arrow@npm:4.5.1']).toBe(coreVersion);
});

test('renderer loaders use pinned v5 alphas and layer math peers match the renderer', () => {
  const loadersVersions = Object.entries(rendererPackage.devDependencies)
    .filter(([name]) => name.startsWith('@loaders.gl/'))
    .map(([, version]) => version);
  expect(loadersVersions.length).toBeGreaterThan(0);
  // All directly used loaders packages now have a coordinated v5 alpha release.
  for (const version of loadersVersions) expect(version).toMatch(/^5\.0\.0-alpha\.\d+$/);
  expect(new Set(loadersVersions).size).toBe(1);
  expect(rendererPackage.dependencies['@math.gl/web-mercator']).toBe(mathVersion);
  expect(rendererPackage.devDependencies['@math.gl/geospatial']).toBe(mathVersion);
  expect(rendererPackage.devDependencies['@math.gl/projection']).toBe(mathVersion);
  const layerPackage = JSON.parse(readFileSync(new URL('../modules/tangram-layers/package.json', import.meta.url), 'utf8'));
  const xrPackage = JSON.parse(readFileSync(new URL('../examples/webxr/package.json', import.meta.url), 'utf8'));
  expect(layerPackage.peerDependencies['@math.gl/core']).toBe(mathVersion);
  expect(xrPackage.dependencies['@math.gl/core']).toBe(mathVersion);
});

test('math resolutions align only the older v5 alpha and preserve deck math 4', () => {
  const repositoryPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const resolutions = Object.entries(repositoryPackage.resolutions).filter(([name]) => name.startsWith('@math.gl/'));
  expect(resolutions.length).toBeGreaterThan(0);
  for (const [descriptor, version] of resolutions) {
    expect(descriptor).toMatch(/^@math\.gl\/[a-z-]+@npm:5\.0\.0-alpha\.15$/);
    expect(version).toBe(mathVersion);
  }
  const rendererRequire = createRequire(new URL('../modules/tangram-renderer/package.json', import.meta.url));
  const deckRequire = createRequire(rendererRequire.resolve('@deck.gl/core'));
  const readMathVersion = (require: ReturnType<typeof createRequire>) =>
    JSON.parse(readFileSync(new URL('../package.json', pathToFileURL(require.resolve('@math.gl/core'))), 'utf8')).version;
  expect(readMathVersion(rendererRequire)).toBe(mathVersion);
  expect(readMathVersion(deckRequire)).toMatch(/^4\./);
  expect(repositoryPackage.devDependencies['@math.gl/spatial-index']).toBe(mathVersion);
});

test('installed workspace dependencies cover the layer and optional WebXR source graphs', () => {
  const deckPackage = JSON.parse(readFileSync(new URL('../examples/deck/package.json', import.meta.url), 'utf8'));
  const xrPackage = JSON.parse(readFileSync(new URL('../examples/webxr/package.json', import.meta.url), 'utf8'));
  const packageName = (name: string) => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
  for (const name of packageImports) expect(deckPackage.dependencies[packageName(name)], name).toBeDefined();
  for (const name of webXRPackageImports) {
    // Culling is an ordinary dependency of the layer package, not a peer.
    const layerPackage = JSON.parse(readFileSync(new URL('../modules/tangram-layers/package.json', import.meta.url), 'utf8'));
    expect(xrPackage.dependencies[packageName(name)] || layerPackage.dependencies[packageName(name)], name).toBeDefined();
  }
});

test.each(['deck', 'webxr', 'projected', 'terrain'])('%s standalone entry uses a built application, not an import map', name => {
  const html = readFileSync(new URL(`../examples/${name}/index.html`, import.meta.url), 'utf8');
  expect(html).not.toContain('importmap');
  expect(html).not.toContain('esm.sh');
  expect(html).toContain(name === 'terrain' ? './dist/app.js' : `../dist/${name}.js`);
});

test.each(['DeckExample', 'TronHeroBackground', 'WebXRExample'])('%s imports installed source through the website bundler', name => {
  const source = readFileSync(new URL(`../website/src/components/${name}.js`, import.meta.url), 'utf8');
  expect(source).not.toContain('importmap');
  expect(source).not.toContain('appendScript');
  expect(source).not.toContain('esm.sh');
  expect(source).toContain('webpackChunkName');
  expect(source).toContain(name === 'WebXRExample' ? '@vis.gl/tangram-webxr-example/app' : '@vis.gl/tangram-deck-example/app-runtime');
  expect(source).toContain('cancelled');
});

test('Thor is installed at its existing pinned revision and stays example-local and lazy', () => {
  const xrPackage = JSON.parse(readFileSync(new URL('../examples/webxr/package.json', import.meta.url), 'utf8'));
  expect(xrPackage.dependencies['thor.gl']).toContain('https%3A//github.com/NEW-HEAT/thor.gl.git%23commit=1f85d87d52bbd30af34626fa17d3193f7e24dff5');
  expect(xrPackage.dependencies['thor.gl']).toContain('.yarn/patches/thor.gl-');
  expect(readFileSync(new URL('../examples/webxr/thor-adapter.js', import.meta.url), 'utf8')).toContain("import('thor.gl')");
  expect(readFileSync(new URL('../examples/webxr/app.js', import.meta.url), 'utf8')).toContain("import('./thor-adapter.js')");
  expect(rendererPackage.dependencies['thor.gl']).toBeUndefined();
});
