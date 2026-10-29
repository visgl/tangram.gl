// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {_GlobeViewport as GlobeViewport} from '@deck.gl/core';

// Copied from deck.gl-community geo-layers: the published 9.4.x does not export this yet.
const PROJECTION_MODE_GLOBE = 2;

/** Detect a globe projection, including across copies of deck.gl. */
export function isGlobeViewport(viewport: unknown): boolean {
  if (!viewport || typeof viewport !== 'object') {
    return false;
  }
  const {projectionMode} = viewport as {projectionMode?: unknown};
  if (typeof projectionMode === 'number') {
    return projectionMode === PROJECTION_MODE_GLOBE;
  }
  return viewport instanceof GlobeViewport;
}
