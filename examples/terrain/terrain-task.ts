// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Task} from '@math.gl/tasks';
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

/** The decoded grid or mesh and time spent decoding it on the execution thread. */
export type TerrainTaskResult = {data: TerrainPayload; decodeMs: number};

/** math.gl task descriptor; the worker URL is supplied by the hosting example. */
export const TerrainDecodeTask = {
  id: 'tangram-terrain-decode',
  async process(input: TerrainTaskInput): Promise<TerrainTaskResult> {
    const started = performance.now();
    const data = await processTerrainTask(input);
    return {data, decodeMs: performance.now() - started};
  }
} satisfies Task<{input: TerrainTaskInput; output: TerrainTaskResult}>;

/** Bind the decoder to a caller-supplied same-origin module worker. */
export function getTerrainWorkerTask(create: () => Worker) {
  return {...TerrainDecodeTask, worker: {create, capabilities: {atomic: true, streaming: false}}};
}
