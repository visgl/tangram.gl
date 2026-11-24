// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {webgl2Adapter} from '@luma.gl/core/webgl';
import {defineTranslateTests} from './translate-tests';

// The rendering suite runs these tests on WebGL and WebGPU too.
defineTranslateTests({deviceType: 'webgl', adapters: [webgl2Adapter]});
