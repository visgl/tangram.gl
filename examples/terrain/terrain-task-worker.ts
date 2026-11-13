// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {initializeTaskWorker} from '@math.gl/tasks';
import {TerrainDecodeTask} from './terrain-task';

// Install math.gl's task protocol on the worker global.
void initializeTaskWorker(TerrainDecodeTask);
