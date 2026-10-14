// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {sampleTerrainHeight, type TerrainHeightGrid} from './terrain-data';
import {TerrainHeightField} from './terrain-height-field';

/** Sample touching footprints with shared-edge averaging; callers validate datum and topology. */
export function sampleTerrainNeighborhood(grids: readonly TerrainHeightGrid[], position: readonly [number, number]): number | null {
    let sum = 0, count = 0;
    for (const grid of grids) {
        const [west, south, east, north] = grid.bounds;
        const tolerance = Math.max(east - west, north - south) * 1e-10;
        if (position[0] < west - tolerance || position[0] > east + tolerance || position[1] < south - tolerance || position[1] > north + tolerance) continue;
        const height = sampleTerrainHeight(grid, [Math.max(west, Math.min(east, position[0])), Math.max(south, Math.min(north, position[1]))]);
        // A touching invalid sample is a hole, not permission to bridge it with its neighbor.
        if (height === null) return null;
        sum += height; count++;
    }
    return count ? sum / count : null;
}

/** Reconstruct explicit boundary nodes from pixel-center data and adjacent tiles. */
export function resampleTerrainNodes(grid: TerrainHeightGrid, neighbors: readonly TerrainHeightGrid[] = []): TerrainHeightGrid {
    const grids = [grid, ...neighbors.filter(neighbor => neighbor !== grid)];
    const [west, south, east, north] = grid.bounds;
    for (const neighbor of grids) {
        if (neighbor.verticalDatum !== grid.verticalDatum || neighbor.registration !== grid.registration || neighbor.width !== grid.width || neighbor.height !== grid.height ||
            Math.abs((neighbor.bounds[2] - neighbor.bounds[0]) / (east - west) - 1) > 1e-8 ||
            Math.abs((neighbor.bounds[3] - neighbor.bounds[1]) / (north - south) - 1) > 1e-8) throw new Error('Terrain neighbors require matching resolution and datum');
    }
    const columns = grid.registration === 'pixel-center' ? grid.width : grid.width - 1;
    const rows = grid.registration === 'pixel-center' ? grid.height : grid.height - 1;
    const width = columns + 1, height = rows + 1;
    const field = new TerrainHeightField(grids);
    const heights = new Float32Array(width * height), valid = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
        const value = field.sampleHeight([west + column / columns * (east - west), north - row / rows * (north - south)]);
        const index = row * width + column;
        heights[index] = value ?? NaN; valid[index] = Number(value !== null);
    }
    return {width, height, heights, valid, bounds: [...grid.bounds], registration: 'grid-node', verticalDatum: grid.verticalDatum};
}
