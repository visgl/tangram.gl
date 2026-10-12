// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TerrainTileData} from '../examples/terrain/terrain-payload';

/** Four adaptive corners and a small physical pixel-center height field. */
export function createTerrainStreamFixture(bounds: [number, number, number, number] = [0, 0, 2, 2], heights = [10, 20, 30, 40]): TerrainTileData {
  return {grid: {width: 2, height: 2, bounds, heights: Float32Array.from(heights), valid: new Uint8Array([1, 1, 1, 1]), registration: 'pixel-center', verticalDatum: 'unknown'},
    mesh: {mode: 4, topology: 'triangle-list', schema: {fields: [], metadata: {}}, attributes: {
      POSITION: {size: 3, value: new Float32Array(12)}, TEXCOORD_0: {size: 2, value: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])}}, indices: {size: 1, value: new Uint32Array([0, 2, 1, 1, 2, 3])}}};
}
