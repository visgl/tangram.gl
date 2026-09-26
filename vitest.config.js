// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getVitestConfig} from '@vis.gl/dev-tools';

const RENDERER_SOURCE_GLOB = 'modules/tangram-renderer/src/**/*.{js,ts}';
const GENERATED_OR_EXTERNAL_COVERAGE_PATHS = [
  '**/build/**',
  '**/dist/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/*.d.ts'
];

export default getVitestConfig({
  overrides: {
    optimizeDeps: {include: ['sinon', '@luma.gl/experimental']},
    plugins: [
      {
        name: 'tangram-glsl',
        transform(source, identifier) {
          if (!identifier.endsWith('.glsl')) {
            return null;
          }
          return {
            code: `export default ${JSON.stringify(source)}`,
            map: null
          };
        }
      }
    ]
  },
  coverage: {
    provider: 'v8',
    reporter: ['text', 'lcov', 'json-summary'],
    // Keep the denominator to authored renderer source. Package outputs and
    // vendored copies are tracked in this repository for distribution, but are
    // not independently executable source and must never enter coverage.
    include: [RENDERER_SOURCE_GLOB],
    exclude: GENERATED_OR_EXTERNAL_COVERAGE_PATHS
  },
  projects: {
    node: {
      test: {
        include: ['test/**/*.node.spec.{js,ts}', 'modules/**/test/**/*.node.spec.{js,ts}']
      }
    },
    browser: {
      test: {
        include: ['test/**/*.browser.spec.{js,ts}']
      }
    },
    headless: {
      test: {
        include: [
          'test/**/*.browser.spec.{js,ts}',
          'modules/**/test/**/*.browser.spec.{js,ts}'
        ],
        globals: true,
        setupFiles: ['./test/vitest-browser-setup.js']
      }
    }
  }
});
