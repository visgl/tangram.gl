// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {performance} from 'node:perf_hooks';
import {buildGlobeTerrainMesh, prepareGlobeTerrainMesh, scaleGlobeTerrainMesh} from '../modules/tangram-renderer/dist/map-logic.js';

// Build first. This deterministic CPU microbenchmark is deliberately not a CI timing gate.
const halfWorld = Math.PI * 6378137;
const width = 128;
const grids = Array.from({length: 16}, (_, index) => {
    const column = index % 4, row = Math.floor(index / 4);
    return {width, height: width,
        heights: Float32Array.from({length: width * width}, (_, pixel) => Math.sin(pixel % width / 11) * 1600 + Math.cos(Math.floor(pixel / width) / 13) * 700),
        valid: new Uint8Array(width * width).fill(1),
        bounds: [-halfWorld + column * halfWorld / 2, halfWorld - (row + 1) * halfWorld / 2, -halfWorld + (column + 1) * halfWorld / 2, halfWorld - row * halfWorld / 2],
        registration: 'pixel-center', verticalDatum: 'unknown'};
});
const templates = grids.map(grid => prepareGlobeTerrainMesh(grid, {resolution: 64, neighbors: grids.filter(candidate => candidate !== grid)}));
/** Run equivalent display changes, retaining preparation only in the second case. */
function measure(prepareAgain) {
    const milliseconds = [];
    for (let run = 0; run < 6; run++) {
        const start = performance.now();
        grids.forEach((grid, index) => {
            if (prepareAgain) buildGlobeTerrainMesh(grid, {resolution: 64, exaggeration: 30 + run, neighbors: grids.filter(candidate => candidate !== grid)});
            else scaleGlobeTerrainMesh(templates[index], 30 + run);
        });
        if (run) milliseconds.push(performance.now() - start);
    }
    return milliseconds;
}
console.log(JSON.stringify({scope: '16 z2 grids, 128x128 source samples, 64x64 mesh cells; CPU only, no GPU, queries or frame-rate guarantee',
    rebuildMilliseconds: measure(true), rescaleMilliseconds: measure(false)}, null, 2));
