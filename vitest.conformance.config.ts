// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * The shared basemap conformance runner (report only, not part of `yarn test`). The harness comes
 * from a deck.gl-community checkout at a pinned commit (`scripts/basemap-conformance.mjs`):
 *
 *   yarn conformance:checkout && yarn build:modules
 *   yarn test-conformance      renders the Streets scenes into .basemap-conformance/output
 *   yarn conformance-report    scores them with the shared scorer
 *
 * VITE_CONFORMANCE_SCENES selects scenes (ids or style ids, default `tangram-streets`), and
 * VITE_CONFORMANCE_RENDERERS renderers (default `maplibre,tangram`). CONFORMANCE_RECORD=1
 * downloads missing fixtures into the checkout; CONFORMANCE_OUTPUT moves the output directory.
 */

import {fileURLToPath} from 'node:url';
import {getVitestConfig} from '@vis.gl/dev-tools';
import {mergeConfig} from 'vitest/config';
import {assertHarness, getConformancePaths} from './scripts/basemap-conformance.mjs';

const paths = getConformancePaths();
assertHarness(paths);
// The fixture server imports only `node:` modules, so Node loads it from the checkout as is.
const {conformanceFixtureServer, HERMETIC_CHROMIUM_ARGS} = await import(`${paths.harness}/src/fixture-server.ts`);

export default mergeConfig(getVitestConfig({
  // A browser that cannot reach the network: every fixture comes from the fixture server.
  launchOptions: {args: HERMETIC_CHROMIUM_ARGS},
  overrides: {
    server: {fs: {allow: [fileURLToPath(new URL('.', import.meta.url)), paths.harness]}},
    // Exercise published bundles (including the inlined scene worker), as the rendering tests do.
    optimizeDeps: {
      include: ['@deck.gl/core', '@luma.gl/core', '@luma.gl/engine', '@luma.gl/webgl', '@math.gl/core',
        '@math.gl/culling', '@loaders.gl/mvt', 'maplibre-gl', '@maplibre/maplibre-gl-style-spec'],
      exclude: ['@vis.gl/tangram-renderer', '@vis.gl/tangram-layers']
    },
    plugins: [conformanceFixtureServer({
      fixtureRoots: paths.fixtureRoots,
      outputDirectory: paths.output,
      record: process.env.CONFORMANCE_RECORD === '1'
    })]
  },
  projects: {node: false, browser: false, headless: {test: {
    include: ['test/basemap-conformance/**/*.conformance.ts'],
    fileParallelism: false,
    testTimeout: 400000,
    hookTimeout: 120000
  }}}
}), {resolve: {alias: {'basemap-conformance': `${paths.harness}/src/index.ts`}}});
