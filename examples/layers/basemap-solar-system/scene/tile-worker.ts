// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Renders Web Mercator tiles of the bodies off the main thread, so the globe loads its tiles
// during the fly-in without dropped frames.
import type {BodyId} from '../celestial';
import {BODIES} from '../bodies';
import {renderTile, stats} from './tiles';

self.onmessage = async (event: MessageEvent<{n: number; id: BodyId; z: number; x: number; y: number}>) => {
  const {n, id, z, x, y} = event.data;
  try {
    const blob = await renderTile(BODIES[id], z, x, y);
    postMessage({n, blob, stats});
  } catch (error) {
    postMessage({n, error: String(error), stats});
  }
};
