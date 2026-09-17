// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** @type {import('@vis.gl/dev-tools').OcularConfig} */
const config = {
  // Tangram's renderer retains a purpose-built Rollup pipeline for its worker
  // and browser bundles. Ocular owns repository-wide orchestration around it.
  lint: {
    paths: ['dev-modules', 'modules', 'examples', 'website', 'test/rendering', 'vitest.rendering.config.ts']
  },
  babel: false,
  // Shared defaults for packages that can use ocular-bundle. The renderer's
  // worker/GLSL bundle remains on its dedicated Rollup pipeline for now.
  bundle: {
    target: ['chrome110', 'firefox110', 'safari15'],
    format: 'esm'
  }
};

export default config;
