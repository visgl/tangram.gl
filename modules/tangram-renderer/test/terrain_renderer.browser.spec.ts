// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {requireTileManager} from './helpers/scene-owners';
import {expect, test, vi} from 'vitest';
import Renderer from '../src/scene/renderer';
import Scene from '../src/scene/scene';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';
import {Matrix4} from '@math.gl/core';
import HostFrame from '../src/scene/host_frame';
import {DrapedTerrainSurfaceSnapshot} from '../src/selection/draped-terrain-surface';
import {TerrainResourceBudget} from '../src/map-logic/terrain-resource-budget';
import {normalizeTerrainDraping} from '../src/procedures/terrain-draping';
import WorkerBroker from '../src/utils/worker_broker';

test('input admission rejects before starting a rebuild and releases all reservations on destruction', async () => {
    const budget = new TerrainResourceBudget(1);
    const scene = Scene.create({}, {terrain: {grids: []}, terrainResourceBudget: budget});
    await expect(scene.rebuild({preserveTileCache: true, preserveTime: true})).rejects.toThrow(/input\/query capacity/);
    expect(scene.building).toBeFalsy(); expect(scene.terrainTransaction).toBeFalsy();
    expect(budget.getStatistics()).toMatchObject({bytes: 0});
    scene.destroy(); expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0});
});

test.each([false, true])('input leases keep the old generation until staged settlement (failed=%s)', async failed => {
    const budget = new TerrainResourceBudget(100);
    const scene = Scene.create({}, {terrain: {grids: [field(0)], maxQueryIndexBytes: 3, maxProjectedQueryBytes: 1}, terrainResourceBudget: budget});
    scene.workers = [];
    const post = vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue([]);
    const manager = requireTileManager(scene);
    vi.spyOn(manager, 'publishTerrainDisplay').mockImplementation(() => {});
    vi.spyOn(manager, 'updateLabels').mockResolvedValue({});
    vi.spyOn(scene, 'logFirstBuild').mockImplementation(() => {});
    try {
        await scene.syncConfigToWorker();
        expect(budget.getStatistics().retainedBytes).toBe(28);
        scene.terrain = normalizeTerrainDraping({grids: [field(10)], maxQueryIndexBytes: 3, maxProjectedQueryBytes: 1});
        scene.terrainTransaction = true;
        await scene.syncConfigToWorker();
        expect(budget.getStatistics().retainedBytes).toBe(56);
        Object.assign(scene, {building: {resolve: vi.fn(), reject: vi.fn(), ...(failed ? {error: new Error('fixture')} : {})}});
        scene.tileManagerBuildDone();
        expect(budget.getStatistics().retainedBytes).toBe(failed ? 56 : 28);
    } finally {scene.destroy(); post.mockRestore();}
    expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0, peakBytes: 56});
});

test.each([false, true])('failed worker inputs remain reserved through asynchronous recovery (recovery fails=%s)', async failedRecovery => {
    const budget = new TerrainResourceBudget(120);
    const options = {grids: [field(0)], maxQueryIndexBytes: 3, maxProjectedQueryBytes: 1};
    const renderer = Renderer.create({}, {terrain: options, terrainResourceBudget: budget});
    const scene = renderer.scene;
    if (!(scene instanceof Scene)) throw new Error('Missing concrete scene fixture');
    const manager = requireTileManager(scene);
    scene.workers = [{postMessage: vi.fn(), addEventListener: vi.fn()}];
    const post = vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue([]);
    vi.spyOn(manager, 'publishTerrainDisplay').mockImplementation(() => {});
    vi.spyOn(manager, 'updateLabels').mockResolvedValue({});
    vi.spyOn(manager, 'updateTilesForView').mockImplementation(() => {});
    vi.spyOn(scene, 'logFirstBuild').mockImplementation(() => {});
    let acknowledgeRecovery: () => void = () => {}, rejectRecovery: (error: Error) => void = () => {};
    const recovery = new Promise<unknown[]>((resolve, reject) => {acknowledgeRecovery = () => resolve([]); rejectRecovery = reject;});
    let recoveryStarted: () => void = () => {};
    const recovering = new Promise<void>(resolve => {recoveryStarted = resolve;});
    try {
        await scene.syncConfigToWorker();
        expect(budget.getStatistics().retainedBytes).toBe(48);
        let configurations = 0;
        post.mockImplementation((_workers, method) => {
            if (method !== 'self.updateConfig') return Promise.resolve([]);
            configurations++;
            if (configurations === 1) return Promise.reject(new Error('replacement worker configuration'));
            if (configurations === 2) {recoveryStarted(); return recovery;}
            return Promise.resolve([]);
        });
        const replacement = {...options, grids: [field(10)], previousGrids: []};
        const update = renderer.setTerrain(replacement).catch((error: unknown) => error);
        await recovering;
        // Even an empty tile queue cannot release worker copies before configuration acknowledges.
        scene.tileManagerBuildDone();
        expect(scene.building).toBeTruthy();
        expect(budget.getStatistics().retainedBytes).toBe(96);
        expect(budget.reserve('transient', 25)).toBeNull();
        if (failedRecovery) {
            rejectRecovery(new Error('recovery worker configuration'));
            expect(await update).toBeInstanceOf(AggregateError);
            expect(budget.getStatistics().retainedBytes).toBe(96);
            // A third input cannot spend the failed snapshot's reservation. Recovery can reuse
            // the incumbent reservation, acknowledge it, and make room for an explicit retry.
            await expect(renderer.setTerrain(replacement)).rejects.toThrow(/input\/query capacity/);
        } else {
            acknowledgeRecovery();
            expect(await update).toMatchObject({message: 'replacement worker configuration'});
        }
        expect(budget.getStatistics().retainedBytes).toBe(48);
        await renderer.setTerrain(replacement);
        expect(budget.getStatistics().retainedBytes).toBe(48);
    } finally {renderer.destroy(); post.mockRestore();}
    expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0, peakBytes: 96});
});

test('a failed terrain configuration drains every worker reply before recovery can release its inputs', async () => {
    const budget = new TerrainResourceBudget(200);
    const scene = Scene.create({}, {terrain: {grids: [field(0)], maxQueryIndexBytes: 3, maxProjectedQueryBytes: 1}, terrainResourceBudget: budget});
    scene.workers = Array.from({length: 2}, () => ({postMessage: vi.fn(), addEventListener: vi.fn()}));
    const post = vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue([]);
    const manager = requireTileManager(scene);
    vi.spyOn(manager, 'publishTerrainDisplay').mockImplementation(() => {});
    vi.spyOn(manager, 'updateLabels').mockResolvedValue({});
    vi.spyOn(manager, 'updateTilesForView').mockImplementation(() => {});
    vi.spyOn(scene, 'logFirstBuild').mockImplementation(() => {});
    let acknowledgeLateWorker: () => void = () => {}, startedLateWorker: () => void = () => {};
    const lateWorker = new Promise<unknown[]>(resolve => {acknowledgeLateWorker = () => resolve([]);});
    const lateWorkerStarted = new Promise<void>(resolve => {startedLateWorker = resolve;});
    try {
        await scene.syncConfigToWorker();
        const original = scene.terrain;
        scene.terrain = normalizeTerrainDraping({grids: [field(10)], maxQueryIndexBytes: 3, maxProjectedQueryBytes: 1});
        let configurations = 0;
        post.mockImplementation((_worker, method) => {
            if (method !== 'self.updateConfig') return Promise.resolve([]);
            configurations++;
            if (configurations === 1) return Promise.reject(new Error('first worker'));
            if (configurations === 2) {startedLateWorker(); return lateWorker;}
            return Promise.resolve([]);
        });
        const update = scene.rebuild({preserveTileCache: true, preserveTime: true}).catch((error: unknown) => error);
        await lateWorkerStarted;
        manager.checkBuildQueue();
        expect(scene.building).toBeTruthy();
        expect(budget.getStatistics().retainedBytes).toBe(136);
        acknowledgeLateWorker();
        expect(await update).toMatchObject({message: 'first worker'});
        expect(budget.getStatistics().retainedBytes).toBe(136);
        scene.terrain = original;
        await scene.rebuild({preserveTileCache: true, preserveTime: true});
        expect(budget.getStatistics().retainedBytes).toBe(68);
    } finally {scene.destroy(); post.mockRestore();}
    expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0, peakBytes: 136});
});

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

test.each([false, true])('view-dependent road refinement coalesces both eyes, including fully suppressed roads (%s)', async suppressed => {
    const renderer = Renderer.create({}, {terrain: {grids: [], groundMeshResolution: 4}});
    Object.assign(renderer.scene, {setFeatureSelectionView: vi.fn()});
    renderer.scene.terrainRibbonStyles = suppressed;
    vi.spyOn(renderer.scene, 'updateScene').mockReturnValue(true);
    vi.spyOn(renderer.scene, 'processTasks').mockImplementation(() => {});
    const manager = requireTileManager(renderer.scene);
    const statistics = manager.getTerrainDrapingStatistics(renderer.scene.terrain);
    vi.spyOn(manager, 'getTerrainDrapingStatistics').mockReturnValue({...statistics, ribbonMeshes: suppressed ? 0 : 1});
    vi.spyOn(manager, 'updateProjectedLabels').mockImplementation(() => {});
    vi.spyOn(manager, 'getDrapedTerrainQueryEntries').mockReturnValue([]);
    const complete: (() => void)[] = [];
    const rebuild = vi.spyOn(renderer.scene, 'rebuild').mockImplementation(options => {
        renderer.scene.terrainRibbonZoom = options.terrainRibbonZoom ?? renderer.scene.terrainRibbonZoom;
        return new Promise<void>(resolve => {complete.push(resolve);});
    });
    const frame = (zoom: number) => new HostFrame({viewport: {width: 200, height: 100}, geographicAnchor: {longitude: 0, latitude: 0, zoom},
        renderViews: ['left', 'right'].map((id, index) => ({id, viewport: {x: index * 100, width: 100, height: 100},
            camera: {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 100]}}))});
    try {
        const first = frame(16.25);
        renderer.render({frame: first, renderViewId: 'left'}); renderer.render({frame: first, renderViewId: 'right'});
        await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
        expect(rebuild).toHaveBeenLastCalledWith({preserveTileCache: true, preserveTime: true, terrainRibbonZoom: 16.25});
        const next = frame(16.75); renderer.render({frame: next, renderViewId: 'left'}); renderer.render({frame: next, renderViewId: 'right'});
        expect(rebuild).toHaveBeenCalledTimes(1);
        complete.shift()?.();
        await vi.waitFor(() => expect(renderer.getTerrainDrapingStatistics().ribbonRefinement?.pending).toBe(false));
        renderer.render({frame: next, renderViewId: 'left'});
        await vi.waitFor(() => expect(rebuild).toHaveBeenCalledTimes(2));
        expect(rebuild).toHaveBeenLastCalledWith({preserveTileCache: true, preserveTime: true, terrainRibbonZoom: 16.75});
        complete.shift()?.();
        await vi.waitFor(() => expect(renderer.getTerrainDrapingStatistics().ribbonRefinement).toMatchObject({admittedZoom: 16.75, pending: false}));
    } finally {for (const finish of complete) finish(); renderer.destroy();}
});

test('ribbon-only rebuilds do not serialize or clone immutable terrain inputs', async () => {
    const scene = Scene.create({}, {terrain: {grids: [field(0)], groundMeshResolution: 4}});
    scene.workers = [{postMessage: vi.fn(), addEventListener: vi.fn()}];
    const post = vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue([]);
    const manager = requireTileManager(scene);
    vi.spyOn(manager, 'publishTerrainDisplay').mockImplementation(() => {});
    vi.spyOn(manager, 'updateLabels').mockResolvedValue({});
    vi.spyOn(manager, 'updateTilesForView').mockImplementation(() => {});
    vi.spyOn(scene, 'logFirstBuild').mockImplementation(() => {});
    try {
        await scene.syncConfigToWorker(); post.mockClear();
        const terrain = scene.terrain;
        await scene.rebuild({preserveTileCache: true, preserveTime: true, terrainRibbonZoom: 16.25});
        expect(scene.terrain).toBe(terrain); expect(scene.terrain?.transitionGeneration).toBe(0);
        const payloads = post.mock.calls.filter(call => call[1] === 'self.updateTerrainView');
        expect(payloads).toHaveLength(1);
        expect(payloads[0][2]).toEqual({generation: scene.generation, ribbonZoom: 16.25});
        expect(post.mock.calls.some(call => call[1] === 'self.updateConfig')).toBe(false);
    } finally {scene.destroy(); post.mockRestore();}
});

test('queued scene rebuilds report superseded versus completed publication', async () => {
    const scene = Scene.create({});
    scene.building = {initial: false, resolve: vi.fn(), reject: vi.fn()};
    try {
        const superseded = scene.rebuild({preserveTime: true, terrainRibbonZoom: 16.25});
        const completed = scene.rebuild({preserveTime: true});
        await expect(superseded).resolves.toBe(false);
        scene.building.queued?.resolve(true);
        await expect(completed).resolves.toBe(true);
    } finally {scene.building = null; scene.destroy();}
});

test('superseded road refinement is not admitted and the next frame retries it', async () => {
    const renderer = Renderer.create({}, {terrain: {grids: [], groundMeshResolution: 4}});
    Object.assign(renderer.scene, {setFeatureSelectionView: vi.fn(), terrainRibbonStyles: true});
    vi.spyOn(renderer.scene, 'updateScene').mockReturnValue(true);
    vi.spyOn(renderer.scene, 'processTasks').mockImplementation(() => {});
    const manager = requireTileManager(renderer.scene);
    vi.spyOn(manager, 'updateProjectedLabels').mockImplementation(() => {});
    vi.spyOn(manager, 'getDrapedTerrainQueryEntries').mockReturnValue([]);
    const rebuild = vi.spyOn(renderer.scene, 'rebuild').mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const frame = new HostFrame({viewport: {width: 100, height: 100}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 16.25},
        renderViews: [{id: 'eye', viewport: {width: 100, height: 100}, camera: {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 100]}}]});
    try {
        renderer.render({frame});
        await vi.waitFor(() => expect(renderer.getTerrainDrapingStatistics().ribbonRefinement?.pending).toBe(false));
        expect(renderer.getTerrainDrapingStatistics().ribbonRefinement?.admittedZoom).toBeUndefined();
        renderer.render({frame});
        await vi.waitFor(() => expect(renderer.getTerrainDrapingStatistics().ribbonRefinement).toMatchObject({admittedZoom: 16.25, pending: false}));
        expect(rebuild).toHaveBeenCalledTimes(2);
    } finally {renderer.destroy();}
});

test('configured line draw groups remain detectable without admitted meshes and reset on style reload', () => {
    const scene = Scene.create({});
    Object.assign(scene, {initialized: true});
    scene.config = {scene: {}, global: {}, sources: {}, styles: {roads: {base: 'lines'}}, layers: {}, textures: {}, cameras: {}, lights: {}, fonts: {}};
    const styles = scene.style_manager.build(scene.config.styles);
    vi.spyOn(scene.style_manager, 'build').mockReturnValue(styles);
    vi.spyOn(scene.style_manager, 'initStyles').mockImplementation(() => {});
    for (const style of Object.values(styles)) vi.spyOn(style, 'setGL').mockImplementation(() => {});
    try {
        for (const layers of [{roads: {draw: {roads: {}}}}, {nested: {child: {draw: {named: {style: 'roads'}}}}}]) {
            scene.config.layers = layers; scene.updateStyles(); expect(scene.terrainRibbonStyles).toBe(true);
        }
        scene.config.layers = {raster: {draw: {raster: {}}, properties: {draw: {roads: {}}}}};
        scene.updateStyles(); expect(scene.terrainRibbonStyles).toBe(false);
    } finally {scene.destroy();}
});

test.each([false, true])('failed road refinement recovers once without a frame-driven retry loop (recovery fails=%s)', async failedRecovery => {
    const renderer = Renderer.create({}, {terrain: {grids: [], groundMeshResolution: 4}});
    Object.assign(renderer.scene, {setFeatureSelectionView: vi.fn()});
    vi.spyOn(renderer.scene, 'updateScene').mockReturnValue(true);
    vi.spyOn(renderer.scene, 'processTasks').mockImplementation(() => {});
    const manager = requireTileManager(renderer.scene);
    const statistics = manager.getTerrainDrapingStatistics(renderer.scene.terrain);
    vi.spyOn(manager, 'getTerrainDrapingStatistics').mockReturnValue({...statistics, ribbonMeshes: 1});
    vi.spyOn(manager, 'updateProjectedLabels').mockImplementation(() => {});
    vi.spyOn(manager, 'getDrapedTerrainQueryEntries').mockReturnValue([]);
    const rebuild = vi.spyOn(renderer.scene, 'rebuild').mockRejectedValueOnce(new Error('ribbon admission fixture'));
    if (failedRecovery) rebuild.mockRejectedValueOnce(new Error('recovery fixture'));
    else rebuild.mockResolvedValueOnce(undefined);
    const frame = new HostFrame({viewport: {width: 100, height: 100}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 16.25},
        renderViews: [{id: 'eye', viewport: {width: 100, height: 100}, camera: {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 100]}}]});
    try {
        renderer.render({frame});
        await vi.waitFor(() => expect(renderer.getTerrainDrapingStatistics().ribbonRefinement).toMatchObject({pending: false, error: 'ribbon admission fixture'}));
        expect(rebuild).toHaveBeenCalledTimes(2);
        expect(rebuild).toHaveBeenLastCalledWith({preserveTileCache: true, preserveTime: true, terrainRibbonZoom: null});
        expect(renderer.render({frame})).toBe(!failedRecovery);
        renderer.render({frame}); await Promise.resolve();
        expect(rebuild).toHaveBeenCalledTimes(2);
        // Explicit field correction clears the failed zoom and permits one fresh attempt.
        rebuild.mockResolvedValue(undefined);
        await renderer.setTerrain({grids: [], groundMeshResolution: 4});
        renderer.render({frame});
        await vi.waitFor(() => expect(renderer.getTerrainDrapingStatistics().ribbonRefinement).toMatchObject({admittedZoom: 16.25, pending: false}));
        expect(rebuild).toHaveBeenCalledTimes(4);
    } finally {renderer.destroy();}
});
