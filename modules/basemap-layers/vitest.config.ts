// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@maplibre-test/projection': fileURLToPath(new URL('../../node_modules/maplibre-gl/src/symbol/projection.ts', import.meta.url)),
      '@maplibre-test/path-interpolator': fileURLToPath(new URL('../../node_modules/maplibre-gl/src/symbol/path_interpolator.ts', import.meta.url)),
      '@maplibre-test/merge-lines': fileURLToPath(new URL('../../node_modules/maplibre-gl/src/symbol/merge_lines.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['modules/basemap-layers/tests/**/*.{test,spec}.{js,ts}'],
    exclude: ['modules/basemap-layers/tests/**/*.browser.{test,spec}.{js,ts}']
  }
});
