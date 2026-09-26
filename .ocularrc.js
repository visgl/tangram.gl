// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** @type {import('@vis.gl/dev-tools').OcularConfig} */
const config = {
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
