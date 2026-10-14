// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {requireTileManager} from './helpers/scene-owners';
import {expect, test, vi} from 'vitest';
import Renderer from '../src/scene/renderer';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';
import {Matrix4} from '@math.gl/core';
import HostFrame from '../src/scene/host_frame';
import {DrapedTerrainSurfaceSnapshot} from '../src/selection/draped-terrain-surface';

test('query warming advances once per shared stereo frame and releases partial work on load and destruction', () => {
    const renderer = Renderer.create({}, {terrain: {grids: [], occludeAnnotations: true, queryPreparationBudgetMs: 1}});
    Object.assign(renderer.scene, {setFeatureSelectionView: vi.fn()});
    vi.spyOn(renderer.scene, 'updateScene').mockReturnValue(true);
    vi.spyOn(renderer.scene, 'processTasks').mockImplementation(() => {});
    vi.spyOn(requireTileManager(renderer.scene), 'updateProjectedLabels').mockImplementation(() => {});
    vi.spyOn(requireTileManager(renderer.scene), 'getDrapedTerrainQueryEntries').mockReturnValue([]);
    vi.spyOn(renderer.scene, 'load').mockReturnValue(Promise.resolve());
    const redraw = vi.spyOn(renderer.scene, 'requestRedraw').mockImplementation(() => {});
    const released = vi.fn();
    const preparation = vi.spyOn(DrapedTerrainSurfaceSnapshot.prototype, 'prepareQueryIndexSteps').mockImplementation(function* () {
        try {yield; yield;} finally {released();}
    });
    let time = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => ++time);
    const frame = new HostFrame({viewport: {width: 200, height: 100}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 16},
        renderViews: ['left', 'right'].map((id, index) => ({id, viewport: {x: index * 100, width: 100, height: 100},
            camera: {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 100]}}))});
    const draw = (renderViewId: string) => renderer.render({frame, renderViewId});
    let destroyed = false;
    try {
        draw('left'); draw('right'); expect(preparation).not.toHaveBeenCalled();
        draw('left'); expect(preparation).toHaveBeenCalledOnce(); expect(redraw).toHaveBeenCalled();
        const sharedTime = renderer.scene.terrainFrameTime;
        draw('right'); expect(preparation).toHaveBeenCalledOnce(); expect(renderer.scene.terrainFrameTime).toBe(sharedTime);
        expect(renderer.getTerrainDrapingStatistics().annotationQueries).toMatchObject({inputBytes: 0, queryIndexBytes: 0});
        renderer.load({}); expect(released).toHaveBeenCalledOnce();
        draw('left'); draw('right'); draw('left'); expect(preparation).toHaveBeenCalledTimes(2);
        destroyed = true; renderer.destroy(); expect(released).toHaveBeenCalledTimes(2);
    } finally {clock.mockRestore(); preparation.mockRestore(); if (!destroyed) renderer.destroy();}
});

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
    expect(renderer.scene.terrain?.transitionGeneration).toBe(1);
    await renderer.scene.rebuild({preserveTileCache: true, preserveTime: true});
    expect(renderer.scene.terrain?.transitionGeneration).toBe(1);
    await renderer.setTerrain({grids: [], transitionDuration: 0});
    expect(renderer.scene.terrain?.transitionGeneration).toBe(2);
    renderer.setTerrainExaggeration(5); renderer.setTerrainExaggeration(5);
    expect(renderer.scene.terrainExaggeration).toBe(5); expect(redraw).toHaveBeenCalledTimes(3);
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
    expect(renderer.scene.terrain?.transitionGeneration).toBe(1);
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

test('feature queries wait for terrain worker selection tables, then route through the corrected generation', async () => {
    const renderer = Renderer.create({}, {terrain: {grids: []}});
    let finish: () => void = () => {};
    vi.spyOn(renderer.scene, 'rebuild').mockImplementation(() => new Promise<void>(resolve => {finish = resolve;}));
    const select = vi.spyOn(renderer.scene, 'getFeatureAt').mockResolvedValue(undefined);
    const update = renderer.setTerrain({grids: [field(20)]}); await Promise.resolve();
    const query = renderer.getFeatureAt({x: 1, y: 2}); expect(select).not.toHaveBeenCalled();
    finish(); await update; await query;
    expect(select).toHaveBeenCalledOnce();
    expect(renderer.getDrapedTerrainSurface()).toBeNull(); renderer.destroy();
});

test('GPU-only relief changes protect the old displayed field while an explicit no-morph replacement is staged', async () => {
    const renderer = Renderer.create({}, {terrain: {grids: [field(-10000)]}});
    let finish: () => void = () => {};
    vi.spyOn(renderer.scene, 'rebuild').mockImplementation(() => new Promise<void>(resolve => {finish = resolve;}));
    const update = renderer.setTerrain({grids: [field(0)], previousGrids: []}); await Promise.resolve();
    expect(renderer.scene.terrain?.minimumHeight).toBe(0);
    expect(() => renderer.setTerrainExaggeration(1000)).toThrow(/invert/);
    finish(); await update;
    expect(() => renderer.setTerrainExaggeration(1000)).not.toThrow(); renderer.destroy();
});

test('surface snapshots follow submitted frames, not pending config or skipped draws', () => {
    const renderer = Renderer.create({}, {terrain: {grids: []}});
    Object.assign(renderer.scene, {setFeatureSelectionView: vi.fn()});
    const draw = vi.spyOn(renderer.scene, 'updateScene').mockReturnValue(true);
    vi.spyOn(renderer.scene, 'processTasks').mockImplementation(() => {});
    vi.spyOn(requireTileManager(renderer.scene), 'updateProjectedLabels').mockImplementation(() => {});
    vi.spyOn(requireTileManager(renderer.scene), 'getDrapedTerrainQueryEntries').mockReturnValue([]);
    const frame: import('../src/types').HostFrameOptions = {viewport: {width: 100, height: 100}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 16},
        projection: {type: 'web-mercator'}, renderViews: [{id: 'eye', viewport: {width: 100, height: 100}, camera: {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 100]}}]};
    expect(renderer.getDrapedTerrainSurface()).toBeNull(); renderer.render({frame});
    const first = renderer.getDrapedTerrainSurface(); expect(first?.exaggeration).toBe(1);
    renderer.setTerrainExaggeration(2); draw.mockReturnValue(false); renderer.render(); expect(renderer.getDrapedTerrainSurface()).toBe(first);
    draw.mockReturnValue(true); renderer.render(); expect(renderer.getDrapedTerrainSurface()?.exaggeration).toBe(2);
    renderer.destroy(); expect(renderer.getDrapedTerrainSurface()).toBeNull();
});
