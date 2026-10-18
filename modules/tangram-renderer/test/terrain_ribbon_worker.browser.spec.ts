// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import worker from '../src/scene/scene_worker';
import {StyleManager} from '../src/styles/style_manager';
import {normalizeTerrainDraping} from '../src/procedures/terrain-draping';

test('lightweight ribbon updates preserve worker DEM/style/source ownership and ignore stale generations', async () => {
    const manager = new StyleManager(), styles = manager.build({roads: {base: 'lines'}});
    const previous = {styles: worker.styles, generation: worker.generation, configuring: worker.configuring};
    const terrain = normalizeTerrainDraping({grids: [], groundMeshResolution: 4});
    worker.styles = styles; worker.generation = 7; worker.configuring = Promise.resolve();
    styles.roads.terrain = terrain;
    const sources = worker.sources, tiles = worker.tiles, layers = worker.layers;
    try {
        await worker.updateTerrainView({generation: 8, ribbonZoom: 12.75});
        expect(worker.styles).toBe(styles); expect(styles.roads.terrain).toBe(terrain);
        expect(styles.roads.terrainRibbonZoom).toBe(12.75);
        expect(worker.sources).toBe(sources); expect(worker.tiles).toBe(tiles); expect(worker.layers).toBe(layers);
        await worker.updateTerrainView({generation: 7, ribbonZoom: 10});
        expect(worker.generation).toBe(8); expect(styles.roads.terrainRibbonZoom).toBe(12.75);
        await worker.updateTerrainView({generation: 9});
        expect(styles.roads.terrainRibbonZoom).toBeUndefined();
        for (const value of [-1, NaN, Infinity, 41]) expect(() => worker.updateTerrainView({generation: 10, ribbonZoom: value})).toThrow(/ribbon view zoom/);
        expect(worker.generation).toBe(9);
    } finally {worker.styles = previous.styles; worker.generation = previous.generation; worker.configuring = previous.configuring; manager.destroy(undefined);}
});
