// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {webgl2Adapter} from '@luma.gl/core/webgl';
import {defineFillStyleTests} from './fill-style-tests';

// The rendering suite runs these tests on WebGL and WebGPU too.
defineFillStyleTests({deviceType: 'webgl', adapters: [webgl2Adapter]});
