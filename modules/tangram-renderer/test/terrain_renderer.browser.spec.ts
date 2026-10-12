// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import Renderer from '../src/scene/renderer';

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
