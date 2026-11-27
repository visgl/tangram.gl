// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {_GlobeViewport as GlobeViewport} from '@deck.gl/core';

// Same check as `isGlobeViewport` in `@deck.gl-community/geo-layers`. It is copied so that
// tangram-layers does not depend on that package. Remove both copies when `@deck.gl/core`
// exports `PROJECTION_MODE` or a globe check: deck.gl v10 does not export the table.
const PROJECTION_MODE_GLOBE = 2;

/** Detect a globe projection by its numeric mode, falling back to the deck.gl class. */
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
