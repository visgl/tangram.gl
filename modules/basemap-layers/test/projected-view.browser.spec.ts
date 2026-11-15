// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {webgl2Adapter} from '@luma.gl/core/webgl';
import {defineProjectedViewTests} from './projected-view-tests';

// `BasemapLayer` in a deck.gl `_CustomProjectionView`, on WebGL. The rendering suite runs the same
// tests on WebGL and WebGPU (`test/rendering/basemap-projected.render.spec.ts`).
defineProjectedViewTests({deviceType: 'webgl', adapters: [webgl2Adapter]});
