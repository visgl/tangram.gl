// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {performance} from 'node:perf_hooks';
import {TerrainHeightField, sampleTerrainNeighborhood} from '../modules/tangram-renderer/dist/map-logic.js';

// Optional local benchmark, not a timing gate. Build modules first. No network or large fixtures.
const gridCount = Number(process.argv[2] ?? 96);
if (!Number.isSafeInteger(gridCount) || gridCount < 1 || gridCount > 96) throw new Error('Supply a grid count from 1 to 96');
const grids = Array.from({length: gridCount}, (_, index) => ({
  width: 16, height: 16,
  bounds: [index % 12 * 1000, Math.floor(index / 12) * 1000, (index % 12 + 1) * 1000, (Math.floor(index / 12) + 1) * 1000],
  heights: Float32Array.from({length: 256}, (_, sample) => sample * 0.25 + index),
  valid: new Uint8Array(256).fill(1),
  registration: 'grid-node', verticalDatum: 'unknown'
}));
const positions = Array.from({length: 16384}, (_, index) => {
  const grid = grids[index % grids.length];
  return [grid.bounds[0] + index * 137 % 1000, grid.bounds[1] + index * 97 % 1000];
});
const started = performance.now(), field = new TerrainHeightField(grids);
const constructionMs = performance.now() - started;
for (const position of positions) {
  const actual = field.sampleHeight(position), expected = sampleTerrainNeighborhood(grids, position);
  if (!Object.is(actual, expected)) throw new Error(`Height mismatch at ${position}: ${actual} != ${expected}`);
}

/** Measure a warmed deterministic workload; retain a checksum so every lookup is consumed. */
function measure(sample) {
  const started = performance.now();
  let checksum = 0;
  for (const position of positions) checksum += sample(position) ?? 0;
  return {milliseconds: performance.now() - started, checksum};
}

const legacy = [], indexed = [];
for (let repeat = 0; repeat < 7; repeat++) {
  // Alternate order to reduce warm-up/order bias; timings remain machine-specific.
  const first = repeat % 2 === 0 ? 'legacy' : 'indexed';
  for (const implementation of [first, first === 'legacy' ? 'indexed' : 'legacy']) {
    const result = measure(implementation === 'legacy' ? position => sampleTerrainNeighborhood(grids, position) : position => field.sampleHeight(position));
    (implementation === 'legacy' ? legacy : indexed).push(result);
  }
}
if (legacy.some(result => result.checksum !== indexed[0].checksum)) throw new Error('Benchmark checksums differ');
const median = results => [...results].sort((first, second) => first.milliseconds - second.milliseconds)[Math.floor(results.length / 2)].milliseconds;
console.log(JSON.stringify({grids: grids.length, probes: positions.length, repeats: 7, constructionMs,
  legacyMedianMs: median(legacy), indexedMedianMs: median(indexed), indexedStatistics: field.getStatistics()}, null, 2));
