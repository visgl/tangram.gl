// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {projectBasemapMesh, projectBasemapMeshWithEngine} from './projected-mesh';
import type {MeshProjectionRequest} from '../procedures/mesh-projector';
if (!('registerMeshProjector' in self) || typeof self.registerMeshProjector !== 'function') {
    throw new Error('Projected basemap script must run inside a Tangram scene worker');
}
self.registerMeshProjector((request: MeshProjectionRequest) => request.projectPositions ?
    projectBasemapMeshWithEngine(request) : projectBasemapMesh(request));
