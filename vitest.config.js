// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getVitestConfig} from '@vis.gl/dev-tools';
import {fileURLToPath} from 'node:url';
import {COVERAGE_MODULES} from './scripts/coverage-modules.mjs';

const GENERATED_OR_EXTERNAL_COVERAGE_PATHS = [
  '**/build/**',
  '**/dist/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/*.d.ts'
];

export default getVitestConfig({
  overrides: {
    resolve: {
      // Unit tests exercise authored source; artifact smoke tests separately verify dist.
      alias: [
        {find: /^@vis\.gl\/tangram-layers\/experimental\/webxr$/,
          replacement: fileURLToPath(new URL('./modules/tangram-layers/src/experimental/webxr/index.ts', import.meta.url))},
        {find: /^@vis\.gl\/tangram-layers$/,
          replacement: fileURLToPath(new URL('./modules/tangram-layers/src/index.ts', import.meta.url))}
      ]
    },
    optimizeDeps: {include: [
      'sinon', '@luma.gl/experimental',
      // Archive/parser conformance imports must not reload unrelated tests mid-run.
      '@loaders.gl/pmtiles', '@loaders.gl/mvt/mvt-geojson-loader',
      '@loaders.gl/tiles',
      '@deck.gl-community/panels',
      './examples/classic/app/community-playground.js',
      'monaco-editor',
      // Eagerly optimize Monaco's lazy JSON runtime so first use cannot reload
      // other tests while their worker/client protocols are being initialized.
      'monaco-editor/esm/vs/editor/editor.api.js',
      'monaco-editor/esm/vs/editor/editor.worker.js',
      'monaco-editor/esm/vs/language/json/monaco.contribution.js',
      'monaco-editor/esm/vs/language/json/jsonMode.js',
      'monaco-editor/esm/vs/language/json/json.worker.js'
    ]},
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
    // Both authored modules belong in the report, including experimental WebXR.
    // Generated packages, declarations, and vendored code are not independent source.
    include: COVERAGE_MODULES.map(module => module.sourceGlob),
    exclude: GENERATED_OR_EXTERNAL_COVERAGE_PATHS,
    // Individual runtime blobs are incomplete. Enforce gates only on their merged report.
    thresholds: process.env.TANGRAM_COVERAGE_ENFORCE === '1'
      ? Object.fromEntries(COVERAGE_MODULES.map(module => [module.sourceGlob, module.thresholds]))
      : undefined
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
