// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The `world://` protocol: `world://<seed>/tilejson?sea=<offset>` is the TileJSON and
// `world://<seed>/tiles/{z}/{x}/{y}.pbf?sea=<offset>` the generated vector tiles. The handler has
// the shape of MapLibre GL JS's `addProtocol` handler, which tangram.gl's
// `registerBasemapProtocol` takes. Tiles are generated in a pool of workers; a request that is
// aborted while it waits in the queue never reaches a worker.

import type {BasemapProtocolHandler} from '@tangram.gl/basemap-layers';
import {getTileJSON} from './tile';

type Pending = {
  id: number;
  seed: number;
  sea: number;
  z: number;
  x: number;
  y: number;
  signal: AbortSignal;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
};

/** The number of tile and world timings that the statistics keep. */
const MAX_TIMINGS = 1000;

/** Statistics of the tile generation, for the status line of the example. */
export type TileStats = {
  /** The number of tiles generated. */
  generated: number;
  /** The generation times of the last tiles, in milliseconds. */
  tileMs: number[];
  /** The build times of the worlds, in milliseconds. */
  worldMs: number[];
  /** The tile requests aborted while they waited in the queue. */
  aborted: number;
  inFlight: number;
  queued: number;
};

/**
 * Creates the handler of the `world://` protocol and its pool of workers. `destroy` stops the
 * workers.
 */
export function createWorldProtocol(workerCount = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1))) {
  const stats: TileStats = {generated: 0, tileMs: [], worldMs: [], aborted: 0, inFlight: 0, queued: 0};
  const workers = Array.from(
    {length: workerCount},
    () => new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'})
  );
  const idle = [...workers];
  const queue: Pending[] = [];
  const running = new Map<number, Pending & {worker: Worker}>();
  let nextId = 1;

  const pump = () => {
    while (idle.length && queue.length) {
      const job = queue.shift()!;
      if (job.signal.aborted) {
        stats.aborted++;
        job.reject(job.signal.reason ?? new DOMException('Aborted', 'AbortError'));
        continue;
      }
      const worker = idle.pop()!;
      running.set(job.id, {...job, worker});
      const {id, seed, sea, z, x, y} = job;
      worker.postMessage({id, seed, sea, z, x, y});
    }
    stats.inFlight = running.size;
    stats.queued = queue.length;
  };
  for (const worker of workers) {
    worker.onmessage = (event: MessageEvent) => {
      const {id, bytes, error, tileMs, worldMs} = event.data;
      const job = running.get(id);
      running.delete(id);
      idle.push(worker);
      if (job) {
        if (error) job.reject(new Error(error));
        else {
          stats.generated++;
          stats.tileMs.push(tileMs);
          if (stats.tileMs.length > MAX_TIMINGS) stats.tileMs.shift();
          if (worldMs) stats.worldMs.push(worldMs);
          if (stats.worldMs.length > MAX_TIMINGS) stats.worldMs.shift();
          job.resolve(bytes);
        }
      }
      pump();
    };
  }

  const parse = (url: string) => {
    const match = /^world:\/\/(-?\d+)\/(tilejson|tiles\/(\d+)\/(\d+)\/(\d+)\.pbf)(?:\?sea=(-?[\d.]+))?$/.exec(url);
    if (!match) throw new Error(`Not a world URL: ${url}`);
    const seed = Number(match[1]) >>> 0;
    const sea = Number(match[6] ?? 0);
    return match[3] === undefined
      ? {kind: 'tilejson' as const, seed, sea}
      : {kind: 'tile' as const, seed, sea, z: Number(match[3]), x: Number(match[4]), y: Number(match[5])};
  };

  const handler: BasemapProtocolHandler = async (params, abortController) => {
    const request = parse(params.url);
    if (request.kind === 'tilejson') {
      return {data: getTileJSON(`world://${request.seed}/tiles/{z}/{x}/{y}.pbf?sea=${request.sea}`)};
    }
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      queue.push({...request, id: nextId++, signal: abortController.signal, resolve, reject});
      pump();
    });
    return {data: bytes};
  };

  return {
    handler,
    stats,
    destroy() {
      for (const worker of workers) worker.terminate();
      const error = new DOMException('The world protocol was destroyed', 'AbortError');
      for (const job of [...queue, ...running.values()]) job.reject(error);
      queue.length = 0;
      running.clear();
    }
  };
}

/** The protocol scheme of the generated world. */
export const WORLD_SCHEME = 'world';

/** The TileJSON URL of a world. */
export const worldSourceUrl = (seed: number, sea: number) => `world://${seed >>> 0}/tilejson?sea=${sea}`;
