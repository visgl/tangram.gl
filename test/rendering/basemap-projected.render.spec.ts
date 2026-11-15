// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {commands} from 'vitest/browser';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {webgpuAdapter} from '@luma.gl/core/webgpu';
import {defineProjectedViewTests} from '../../modules/basemap-layers/test/projected-view-tests';

declare const __TEST_DEVICE__: 'webgl' | 'webgpu';

// `BasemapLayer` in a deck.gl `_CustomProjectionView`, on the backend of the test lane (see
// `vitest.rendering.config.ts`). The tests are in the basemap-layers module, whose browser suite
// also runs them on WebGL.
defineProjectedViewTests({
  deviceType: __TEST_DEVICE__,
  adapters: [webgl2Adapter, webgpuAdapter],
  saveFrame: (name, image) => commands.saveRenderingArtifact(name, image)
});
