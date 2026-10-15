// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {getOcularConfig} from '@vis.gl/dev-tools';
import {MATH_BROWSER_ASSETS} from './math-assets.mjs';

const repositoryDirectory = fileURLToPath(new URL('../../', import.meta.url));
const configuration = await getOcularConfig({root: repositoryDirectory});
const bundledPackages = new Set();

for (const [specifier, filename] of Object.entries(MATH_BROWSER_ASSETS)) {
  // Match the existing browser application builds: Ocular target policy, bundled
  // npm dependencies, and only the shared math.gl core left in the import map.
  const external = specifier === '@math.gl/core' ? [] : ['@math.gl/core'];
  const result = await build({
    absWorkingDir: repositoryDirectory,
    entryPoints: [fileURLToPath(import.meta.resolve(specifier))],
    outfile: resolve(import.meta.dirname, 'dist', filename),
    bundle: true, format: 'esm', platform: 'browser', minify: true,
    target: configuration.bundle.target,
    // esbuild's external package rule also matches subpaths. Leave only the
    // exact shared class entry external; bundle stateless mat4/spheroid leaves.
    plugins: external.length ? [{name: 'shared-math-core', setup(builder) {
      builder.onResolve({filter: /^@math\.gl\/core$/}, () => ({path: '@math.gl/core', external: true}));
    }}] : [],
    banner: {js: '/*! math.gl — third-party licenses: ./THIRD-PARTY-NOTICES.txt */'},
    sourcemap: true, sourcesContent: false, metafile: true, logLevel: 'info'
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const packagePath = input.match(/^(.*node_modules\/@math\.gl\/[^/]+)\//)?.[1];
    if (!packagePath) throw new Error(`Unexpected browser math dependency: ${input}`);
    bundledPackages.add(resolve(repositoryDirectory, packagePath));
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !external.includes(dependency.path)) {
        throw new Error(`Browser math asset has an unresolved dependency: ${dependency.path}`);
      }
    }
  }
}

// Ship the installed packages' notices alongside generated code, not copied source.
const notices = [];
for (const packageDirectory of [...bundledPackages].sort()) {
  const metadata = JSON.parse(await readFile(resolve(packageDirectory, 'package.json'), 'utf8'));
  const filenames = (await readdir(packageDirectory)).filter(name => /^(?:LICENSE|NOTICE|.*-LICENSE|THIRD-PARTY-NOTICES)(?:\.|$)/i.test(name)).sort();
  if (!filenames.length) throw new Error(`Missing browser dependency license: ${metadata.name}`);
  for (const filename of filenames) notices.push(`${metadata.name}@${metadata.version} — ${filename}\n\n${await readFile(resolve(packageDirectory, filename), 'utf8')}`);
}
await writeFile(resolve(import.meta.dirname, 'dist/THIRD-PARTY-NOTICES.txt'), notices.join('\n\n---\n\n'));
