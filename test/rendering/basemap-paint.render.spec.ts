// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {commands} from 'vitest/browser';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {webgpuAdapter} from '@luma.gl/core/webgpu';
import {defineBackendPaintTests} from '../../modules/basemap-layers/test/backend-paint-tests';
import {defineFillStyleTests} from '../../modules/basemap-layers/test/fill-style-tests';
import {defineTranslateTests} from '../../modules/basemap-layers/test/translate-tests';

declare const __TEST_DEVICE__: 'webgl' | 'webgpu';

// The paint properties that `BasemapLayer` draws with its own shader code, on the backend of the
// test lane (see `vitest.rendering.config.ts`), against MapLibre GL JS's formulas.
const options = {
  deviceType: __TEST_DEVICE__,
  adapters: [webgl2Adapter, webgpuAdapter],
  saveFrame: (name: string, image: string) => commands.saveRenderingArtifact(name, image)
};
defineBackendPaintTests(options);
defineFillStyleTests(options);
defineTranslateTests(options);
