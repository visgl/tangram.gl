// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {projectBasemapMesh} from './projected-mesh';
if (!('registerMeshProjector' in self) || typeof self.registerMeshProjector !== 'function') {
    throw new Error('Projected basemap script must run inside a Tangram scene worker');
}
self.registerMeshProjector(projectBasemapMesh);
