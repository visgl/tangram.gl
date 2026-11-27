// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {fileURLToPath} from 'node:url';

/** @type {import('@vis.gl/dev-tools').OcularConfig} */
const config = {
  // Resolve source workspaces that do not provide JavaScript dist entries for these imports.
  nodeAliases: {
    '@tangram.gl/basemap-layers': fileURLToPath(new URL('./modules/basemap-layers/src', import.meta.url)),
    '@tangram.gl/map-utils': fileURLToPath(new URL('./modules/map-utils/src', import.meta.url))
  },
  // Ocular owns repository-wide build, lint, and test orchestration.
  lint: {
    paths: ['dev-modules', 'modules', 'examples', 'website', 'test/rendering', 'vitest.rendering.config.ts']
  },
  babel: false,
  // Shared defaults for packages that can use ocular-bundle. The renderer
  // uses the same esbuild toolchain through a package-specific worker plugin.
  bundle: {
    target: ['chrome110', 'firefox110', 'safari15'],
    format: 'esm'
  }
};

export default config;
