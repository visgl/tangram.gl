// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TaskDescriptor} from '@math.gl/core-legacy-tasks/tasks';
import {decodeTerrainGrid} from './decode-height-grid';
import {validateTerrainImage, type TerrainNoDataPolicy, type TerrainPayload} from './terrain-payload';

/** Serializable inputs for one independent terrain decode. */
export type TerrainTaskInput = {
  /** Grid-only or adaptive-mesh output. */
  mode: 'grid' | 'mesh';
  /** Encoded terrain image; callers choose whether to copy or transfer it. */
  bytes: ArrayBuffer;
  /** Geographic bounds in west, south, east, north order. */
  bounds: [number, number, number, number];
  /** Adaptive mesh error in meters. */
  meshMaxError: number;
  /** Image validity policy. */
  noData: TerrainNoDataPolicy;
};

/** Decode one terrain image without retaining state between jobs. */
export async function processTerrainTask(input: TerrainTaskInput): Promise<TerrainPayload> {
  validateTerrainImage(input.bytes, input.bounds, input.noData);
  if (!Number.isFinite(input.meshMaxError) || input.meshMaxError < 0) {
    throw new Error('Terrain mesh error must be non-negative meters');
  }
  if (input.mode === 'grid') return decodeTerrainGrid(input.bytes, input.bounds, input.noData);
  if (input.mode !== 'mesh') throw new Error('Invalid terrain decode mode');
  return (await import('./decode-terrain')).decodeTerrainTile(input.bytes, input.bounds, input.meshMaxError, input.noData);
}

/** math.gl task descriptor; the worker URL is supplied by the hosting example. */
export const TerrainDecodeTask: TaskDescriptor<TerrainTaskInput, TerrainPayload> = {
  id: 'tangram-terrain-decode',
  name: 'Tangram terrain decode',
  module: 'tangram-terrain-example',
  version: '0.0.1',
  worker: true,
  options: {},
  process: processTerrainTask
};
