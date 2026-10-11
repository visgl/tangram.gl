// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {_GlobeViewport as GlobeViewport} from '@deck.gl/core';
import {getTerrainChildren, selectGlobeTerrainDetail, terrainTileContains, terrainTilesTouch} from '../examples/terrain/globe-detail';
import {getTerrainTileKey, type TerrainTileCoordinate} from '../examples/terrain/tile-selection';
import {TerrainTileset} from '../examples/terrain/terrain-tileset';
import {createTerrainStreamFixture} from './terrain-stream-fixture';

/** Assert full world coverage, non-overlap and balanced edges, including world wrap. */
function expectBalanced(tiles: readonly TerrainTileCoordinate[]): void {
    expect(tiles.reduce((sum, tile) => sum + 4 ** -tile.zoom, 0)).toBe(1);
    for (const [index, tile] of tiles.entries()) for (const [otherIndex, other] of tiles.entries()) {
        if (index !== otherIndex) expect(terrainTileContains(tile, other)).toBe(false);
        if (terrainTilesTouch(tile, other)) expect(Math.abs(tile.zoom - other.zoom)).toBeLessThanOrEqual(1);
    }
}

test.each([[80, 25], [179.9, 0], [-179.9, 75], [0, -75]])('globe refinement is bounded and covers the world around [%s, %s]', (longitude, latitude) => {
    const coarse = selectGlobeTerrainDetail(new GlobeViewport({longitude, latitude, zoom: 1, width: 512, height: 320}));
    const fine = selectGlobeTerrainDetail(new GlobeViewport({longitude, latitude, zoom: 7, width: 512, height: 320}));
    expectBalanced(coarse.tiles); expectBalanced(fine.tiles);
    expect(fine.tiles.length).toBeLessThanOrEqual(96);
    expect(Math.max(...fine.tiles.map(tile => tile.zoom))).toBeGreaterThan(Math.max(...coarse.tiles.map(tile => tile.zoom)));
    expect(selectGlobeTerrainDetail(new GlobeViewport({longitude, latitude, zoom: 7, width: 512, height: 320}), {previous: fine.tiles}).tiles).toEqual(fine.tiles);
});

test('resource/source limits and unusable projections keep explicit bounded fallback', () => {
    const view = new GlobeViewport({longitude: 80, latitude: 25, zoom: 8, width: 512, height: 320});
    const limited = selectGlobeTerrainDetail(view, {maxTiles: 16}); expect(limited.tiles).toHaveLength(16); expect(limited.limited).toBe(true);
    expect(selectGlobeTerrainDetail(view, {maxZoom: 2}).tiles).toHaveLength(16);
    const invalid = {...view, project: () => [NaN, NaN, NaN]};
    expectBalanced(selectGlobeTerrainDetail(invalid).tiles);
    for (const options of [{maxTiles: 15}, {maxTiles: 129}, {maxZoom: 13}, {maxZoom: 1}, {targetPixels: NaN}, {targetPixels: 0}]) expect(() => selectGlobeTerrainDetail(view, options)).toThrow('Invalid');
    expect(() => selectGlobeTerrainDetail({...invalid, cameraPosition: [0, 0, 0]})).toThrow('outside');
    expect(() => selectGlobeTerrainDetail({...invalid, width: 0})).toThrow('Invalid');
});

test('tile topology respects containment, corner-only contact and wrapped edges', () => {
    const tile = {zoom: 2, column: 0, row: 1};
    expect(getTerrainChildren(tile)).toHaveLength(4);
    expect(getTerrainChildren(tile).every(child => terrainTileContains(tile, child))).toBe(true);
    expect(terrainTilesTouch(tile, {zoom: 2, column: 3, row: 1})).toBe(true);
    expect(terrainTilesTouch(tile, {zoom: 2, column: 1, row: 2})).toBe(false);
});

test('hierarchy keeps loaded ancestors and warm bytes across refinement and coarsening', async () => {
    const fetched: string[] = [];
    const tileset = new TerrainTileset({hierarchical: true, minZoom: 1, maxZoom: 12,
        fetch: async tile => {fetched.push(getTerrainTileKey(tile)); return new ArrayBuffer(1);}, decode: async () => createTerrainStreamFixture(), onChange() {}});
    try {
        const roots = Array.from({length: 16}, (_, index) => ({zoom: 2, column: index % 4, row: Math.floor(index / 4)}));
        tileset.update(roots); await tileset.waitForIdle();
        expect(fetched).toHaveLength(20); expectBalanced(tileset.getDrawableTiles().map(tile => tile.coordinate));
        const refined = roots.flatMap((tile, index) => index === 0 ? getTerrainChildren(tile) : [tile]);
        tileset.update(refined);
        expect(tileset.getDrawableTiles()).toHaveLength(16);
        await tileset.waitForIdle(); expect(tileset.getDrawableTiles()).toHaveLength(19);
        expectBalanced(tileset.getDrawableTiles().map(tile => tile.coordinate));
        const count = fetched.length;
        tileset.update(roots); await tileset.waitForIdle(); tileset.update(refined); await tileset.waitForIdle();
        expect(fetched).toHaveLength(count);
        expect(() => tileset.update([roots[0]])).toThrow('complete');
        expect(() => tileset.update([...roots, ...getTerrainChildren(roots[0])])).toThrow('non-overlapping');
        const unbalanced = refined.flatMap(tile => tile.zoom === 3 && tile.column === 1 && tile.row === 0 ? getTerrainChildren(tile) : [tile]);
        expect(() => tileset.update(unbalanced)).toThrow('balanced');
    } finally {tileset.destroy();}
});

test('failed fine siblings retain a complete coarse cover and retry only missing acquisitions', async () => {
    let fail = true;
    const tileset = new TerrainTileset({hierarchical: true, minZoom: 1, maxZoom: 4,
        fetch: async tile => {if (fail && tile.zoom === 3 && tile.column === 0 && tile.row === 0) throw new Error('fixture unavailable'); return new ArrayBuffer(1);},
        decode: async () => createTerrainStreamFixture(), onChange() {}});
    try {
        const roots = Array.from({length: 16}, (_, index) => ({zoom: 2, column: index % 4, row: Math.floor(index / 4)}));
        tileset.update(roots.flatMap((tile, index) => index === 0 ? getTerrainChildren(tile) : [tile])); await tileset.waitForIdle();
        expect(tileset.getStatistics().failed).toBe(1); expect(tileset.getDrawableTiles()).toHaveLength(16); expectBalanced(tileset.getDrawableTiles().map(tile => tile.coordinate));
        fail = false; tileset.retry(); await tileset.waitForIdle(); expect(tileset.getDrawableTiles()).toHaveLength(19);
    } finally {tileset.destroy();}
});

test('partially loaded deep detail remains balanced when an intermediate ancestor fails', async () => {
    const selection = selectGlobeTerrainDetail(new GlobeViewport({longitude: 0, latitude: 0, zoom: 6, width: 512, height: 320}), {maxTiles: 64});
    let tileset: TerrainTileset | undefined;
    const failures: unknown[] = [];
    tileset = new TerrainTileset({hierarchical: true, minZoom: 1, maxZoom: 12,
        fetch: async tile => {if (tile.zoom === 2 && tile.column === 2 && tile.row === 1) throw new Error('missing intermediate tile'); return new ArrayBuffer(1);},
        decode: async () => createTerrainStreamFixture(), onChange() {
            try {
                const drawable = tileset?.getDrawableTiles() ?? [];
                for (const tile of drawable) for (const other of drawable) if (terrainTilesTouch(tile.coordinate, other.coordinate)) expect(Math.abs(tile.coordinate.zoom - other.coordinate.zoom)).toBeLessThanOrEqual(1);
            } catch (error) {failures.push(error);}
        }});
    try {
        tileset.update(selection.tiles); await tileset.waitForIdle();
        expect(tileset.getStatistics().failed).toBe(1); expect(failures).toEqual([]);
        expectBalanced(tileset.getDrawableTiles().map(tile => tile.coordinate));
    } finally {tileset.destroy();}
});

test('hard retained-array admission keeps global fallback when fine detail exceeds the cap', async () => {
    const tileset = new TerrainTileset({hierarchical: true, minZoom: 1, maxZoom: 3, maxResidentBytes: 2600,
        fetch: async () => new ArrayBuffer(1), decode: async () => createTerrainStreamFixture(), onChange() {}});
    try {
        const roots = Array.from({length: 16}, (_, index) => ({zoom: 2, column: index % 4, row: Math.floor(index / 4)}));
        tileset.update(roots); await tileset.waitForIdle();
        expect(tileset.getStatistics().failed).toBe(0);
        tileset.update(roots.flatMap((tile, index) => index === 0 ? getTerrainChildren(tile) : [tile])); await tileset.waitForIdle();
        expect(tileset.getStatistics().failed).toBeGreaterThan(0);
        expect(tileset.getStatistics().bytes).toBeLessThanOrEqual(2600);
        expect(tileset.getDrawableTiles()).toHaveLength(16); expectBalanced(tileset.getDrawableTiles().map(tile => tile.coordinate));
    } finally {tileset.destroy();}
});
