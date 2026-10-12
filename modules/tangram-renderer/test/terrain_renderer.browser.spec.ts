// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import Renderer from '../src/scene/renderer';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';

/** Physical fields small enough to exercise generation policy without GPU fixtures. */
function field(height: number, verticalDatum: TerrainHeightGrid['verticalDatum'] = 'orthometric'): TerrainHeightGrid {
    return {width: 2, height: 2, bounds: [-1, -1, 1, 1], heights: new Float32Array(4).fill(height), valid: new Uint8Array(4).fill(1), registration: 'grid-node', verticalDatum};
}

test('automatic previous fields enforce joint budgets and datum, then release obsolete height limits', async () => {
    const renderer = Renderer.create({}, {terrain: {grids: [field(-10000)]}});
    vi.spyOn(renderer.scene, 'rebuild').mockResolvedValue(undefined);
    await renderer.setTerrain({grids: [field(0)]});
    expect(renderer.scene.terrain?.minimumHeight).toBe(-10000);
    expect(renderer.scene.terrain?.previousGrids[0].heights[0]).toBe(-10000);
    expect(() => renderer.setTerrainExaggeration(1000)).toThrow(/invert/);
    await renderer.setTerrain({grids: [field(0)]});
    expect(renderer.scene.terrain?.minimumHeight).toBe(0);
    expect(() => renderer.setTerrainExaggeration(1000)).not.toThrow();
    const admitted = renderer.scene.terrain;
    await expect(renderer.setTerrain({grids: [field(0)], maxGridBytes: 30})).rejects.toThrow(/current\/previous/);
    await expect(renderer.setTerrain({grids: [field(0, 'ellipsoidal')]})).rejects.toThrow(/datum/);
    expect(renderer.scene.terrain).toBe(admitted);
    await renderer.setTerrain({grids: [field(0, 'ellipsoidal')], previousGrids: []});
    expect(renderer.scene.terrain?.previousGrids).toHaveLength(0);
    expect(renderer.scene.terrain?.byteLength).toBe(20);
    renderer.destroy();
});

test('queued terrain snapshots coalesce, serialize and keep source caches warm', async () => {
    const renderer = Renderer.create({}, {terrain: {grids: []}});
    const rebuild = vi.spyOn(renderer.scene, 'rebuild').mockResolvedValue(undefined);
    const redraw = vi.spyOn(renderer.scene, 'requestRedraw').mockImplementation(() => {});
    await Promise.all([renderer.setTerrain({grids: [], maxSegmentLength: 50}), renderer.setTerrain({grids: [], maxSegmentLength: 100}), renderer.setTerrain({grids: [], maxSegmentLength: 200})]);
    expect(rebuild).toHaveBeenCalledOnce(); expect(rebuild).toHaveBeenCalledWith({preserveTileCache: true, preserveTime: true});
    expect(renderer.scene.terrain?.maxSegmentLength).toBe(200);
    renderer.setTerrainExaggeration(5); renderer.setTerrainExaggeration(5);
    expect(renderer.scene.terrainExaggeration).toBe(5); expect(redraw).toHaveBeenCalledTimes(2);
    for (const value of [-1, NaN, Infinity, 1001]) expect(() => renderer.setTerrainExaggeration(value)).toThrow(/exaggeration/);
    renderer.destroy();
    await expect(renderer.setTerrain({grids: []})).rejects.toThrow(/live/);
    expect(() => renderer.setTerrainExaggeration(1)).toThrow(/live/);
});

test('failed terrain rebuild restores workers and meshes; failed recovery fails closed until a correction', async () => {
    const renderer = Renderer.create({}, {terrain: {grids: []}});
    const original = renderer.scene.terrain;
    const rebuild = vi.spyOn(renderer.scene, 'rebuild').mockRejectedValueOnce(new Error('limit')).mockResolvedValue(undefined);
    await expect(renderer.setTerrain({grids: [], maxSegmentLength: 50})).rejects.toThrow('limit');
    expect(renderer.scene.terrain).toBe(original); expect(rebuild).toHaveBeenCalledTimes(2);
    rebuild.mockRejectedValue(new Error('worker'));
    await expect(renderer.setTerrain({grids: []})).rejects.toThrow(/recovery failed/);
    expect(renderer.render()).toBe(false);
    rebuild.mockResolvedValue(undefined);
    await renderer.setTerrain({grids: [], transitionDuration: 0});
    expect(renderer.scene.terrain?.transitionDuration).toBe(0);
    renderer.destroy();
});

test('terrain disabled creation and destroyed pending work cannot enable attributes or resurrect a scene', async () => {
    const disabled = Renderer.create({});
    await expect(disabled.setTerrain({grids: []})).rejects.toThrow(/enabled/); disabled.destroy();
    const renderer = Renderer.create({}, {terrain: {grids: []}});
    const rebuild = vi.spyOn(renderer.scene, 'rebuild').mockResolvedValue(undefined);
    const update = renderer.setTerrain({grids: []}); renderer.destroy();
    await expect(update).rejects.toThrow(/destroyed/); expect(rebuild).not.toHaveBeenCalled();
});

test('an active terrain rebuild drains before the latest pending snapshot is admitted', async () => {
    const renderer = Renderer.create({}, {terrain: {grids: []}});
    let finish: () => void = () => {};
    const rebuild = vi.spyOn(renderer.scene, 'rebuild').mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;})).mockResolvedValue(undefined);
    const first = renderer.setTerrain({grids: [], maxSegmentLength: 50}); await Promise.resolve();
    const second = renderer.setTerrain({grids: [], maxSegmentLength: 100});
    const third = renderer.setTerrain({grids: [], maxSegmentLength: 200});
    expect(rebuild).toHaveBeenCalledOnce(); finish(); await Promise.all([first, second, third]);
    expect(rebuild).toHaveBeenCalledTimes(2); expect(renderer.scene.terrain?.maxSegmentLength).toBe(200);
    renderer.destroy();
});
