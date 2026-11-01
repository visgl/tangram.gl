// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createWorker} from '@math.gl/core/tasks';
import {processTerrainTask} from './terrain-task';

// Install math.gl's task protocol on the worker global.
void createWorker(processTerrainTask);
