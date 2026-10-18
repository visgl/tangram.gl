// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import createTangramLayerClass from '../src/tangram-layer';
import {DrapedTerrainSurfaceSnapshot} from '@vis.gl/tangram-renderer/core';
import {createContextFixture, createRecordFixture, createRendererFixture, getLiveRecord} from './fixtures/lifecycle';
import type {Scene} from '@vis.gl/tangram-renderer';
import type {TangramLayerProps} from '../src/tangram-layer';
import {TerrainResourceBudget} from '@vis.gl/tangram-renderer/map-logic';

test('the borrowed terrain budget reaches the renderer and a different pool recreates its owner', async () => {
    class BaseLayer {}
    const construct = vi.fn((_scene: unknown, _options: Record<string, unknown>) => createRendererFixture({}));
    const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {create: construct}});
    const layer = new Layer(); layer.state = {tangramRecord: null}; layer.setState = value => Object.assign(layer.state, value);
    layer.context = createContextFixture(); layer.setNeedsRedraw = vi.fn(); layer.raiseError = vi.fn(); layer._synchronizeTangramScene = vi.fn();
    const scene = {}, terrain = {grids: []}, first = new TerrainResourceBudget(100), second = new TerrainResourceBudget(200);
    try {
        layer.props = {scene, terrain, terrainResourceBudget: first, onSceneLoad: vi.fn(), onSceneError: vi.fn(), onAttributionChange: vi.fn()}; layer.updateState({props: layer.props});
        const record = getLiveRecord(layer); await record.loadPromise;
        expect(construct.mock.calls[0][1].terrainResourceBudget).toBe(first);
        layer.props = {...layer.props, terrainResourceBudget: second}; layer.updateState({props: layer.props});
        await getLiveRecord(layer).loadPromise;
        expect(record.renderer.destroy).toHaveBeenCalledOnce(); expect(construct).toHaveBeenCalledTimes(2);
        expect(construct.mock.calls[1][1].terrainResourceBudget).toBe(second);
    } finally {layer.finalizeState();}
});

test('public scene callbacks accept explicit Scene handlers and retain the supported Scene methods', async () => {
    class BaseLayer {}
    const renderer = createRendererFixture({});
    const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {create: () => renderer}});
    const layer = new Layer(); layer.state = {tangramRecord: null};
    layer.setState = state => Object.assign(layer.state, state);
    layer.context = createContextFixture(); layer.setNeedsRedraw = vi.fn(); layer.raiseError = vi.fn();
    layer._synchronizeTangramScene = vi.fn();
    const onSceneLoad = vi.fn((scene: Scene) => {void scene.updateConfig({rebuild: false});});
    const callbacks: Pick<TangramLayerProps, 'onSceneLoad' | 'onSceneError' | 'onAttributionChange'> = {
        onSceneLoad,
        onSceneError: (_error, scene) => {void scene.setDataSource('fixture', {type: 'GeoJSON', url: 'fixture.json'});},
        onAttributionChange: (_credits, scene) => {void scene.getSourceMetadata();}
    };
    layer.props = {scene: {}, ...callbacks};
    try {
        layer.updateState({props: layer.props}); const record = getLiveRecord(layer); await record.loadPromise;
        expect(onSceneLoad).toHaveBeenCalledExactlyOnceWith(renderer.scene);
        expect(record.scene).toBe(renderer.scene);
        expect(renderer.scene.updateConfig).toHaveBeenCalledWith({rebuild: false});
        layer._reportSceneError(record, new Error('fixture'), false);
        expect(renderer.scene.setDataSource).toHaveBeenCalledWith('fixture', {type: 'GeoJSON', url: 'fixture.json'});
        await vi.waitFor(() => expect(renderer.scene.getSourceMetadata).toHaveBeenCalled());
    } finally {layer.finalizeState();}
});

test('ground surface and implicit picking delegate only to a live loaded record', () => {
    class BaseLayer {}
    const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {}, Renderer: undefined});
    const layer = new Layer(), snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [], 4, 0, 1);
    const renderer = createRendererFixture({getDrapedTerrainSurface: vi.fn(() => snapshot), getTerrainAt: vi.fn(() => null)});
    expect(layer.getDrapedTerrainSurface()).toBeNull();
    layer.state = {tangramRecord: null}; expect(layer.getDrapedTerrainSurface()).toBeNull();
    const record = createRecordFixture(layer, {renderer, loaded: false, disposed: false, loadFailed: false}); layer.state.tangramRecord = record;
    expect(layer.getDrapedTerrainSurface()).toBeNull(); record.loaded = true; record.loadFailed = true;
    expect(layer.getDrapedTerrainSurface()).toBeNull(); record.loadFailed = false; record.disposed = true;
    expect(layer.getDrapedTerrainSurface()).toBeNull(); record.disposed = false;
    expect(layer.getDrapedTerrainSurface()).toBe(snapshot); expect(renderer.getDrapedTerrainSurface).toHaveBeenCalledOnce();
    expect(layer.getTerrainAt({x: 1, y: 2})).toBeNull();
    expect(renderer.getTerrainAt).toHaveBeenCalledWith({x: 1, y: 2}, undefined, {});
});

test('terrain props rebuild the existing renderer, while enabling/disabling replaces attribute layouts', async () => {
    class BaseLayer {}
    const createRenderer = vi.fn(() => createRendererFixture({scene: {}, subscribe: vi.fn(), load: vi.fn(async () => undefined), destroy: vi.fn(),
        setTerrain: vi.fn(async (_terrain: object) => undefined), setTerrainExaggeration: vi.fn((_value: number) => {}), getAttributions: vi.fn(async () => [])}));
    const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {create: createRenderer}, Renderer: undefined});
    const layer = new Layer(); layer.state = {tangramRecord: null};
    layer.setState = (state: Record<string, unknown>) => Object.assign(layer.state, state);
    layer.raiseError = vi.fn(); layer._synchronizeTangramScene = vi.fn();
    layer.context = createContextFixture({deck: {getCanvas: () => document.createElement('canvas')}});
    const scene = {};
    const callbacks = {onSceneLoad: vi.fn(), onSceneError: vi.fn()};
    const terrain = {grids: []};
    try {
        layer.props = {scene, ...callbacks, terrain, terrainExaggeration: 1}; layer.updateState({props: layer.props});
        const first = getLiveRecord(layer); await first.loadPromise;
        expect(createRenderer.mock.calls).toHaveLength(1); expect(first.terrain).toBe(terrain);
        expect(layer.getTerrainDrapingStatistics()).toMatchObject({enabled: true});
        const next = {grids: [], maxSegmentLength: 100};
        layer.props = {scene, ...callbacks, terrain: next, terrainExaggeration: 2}; layer.updateState({props: layer.props}); await Promise.resolve(); await Promise.resolve();
        expect(layer.state.tangramRecord).toBe(first); expect(first.renderer.setTerrain).toHaveBeenCalledWith(next);
        await expect.poll(() => vi.mocked(first.renderer.setTerrainExaggeration).mock.calls.at(-1)?.[0]).toBe(2);
        let finish: () => void = () => {};
        vi.mocked(first.renderer.setTerrain).mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        vi.mocked(first.renderer.setTerrainExaggeration).mockClear();
        const replacement = {grids: [], previousGrids: []};
        layer.props = {scene, ...callbacks, terrain: replacement, terrainExaggeration: 1000}; layer.updateState({props: layer.props});
        await Promise.resolve(); await Promise.resolve();
        expect(first.renderer.setTerrainExaggeration).not.toHaveBeenCalled();
        // Exaggeration-only updates during the rebuild also wait, and the latest owner wins.
        layer.props = {...layer.props, terrainExaggeration: 500}; layer.updateState({props: layer.props});
        expect(first.renderer.setTerrainExaggeration).not.toHaveBeenCalled();
        finish();
        await expect.poll(() => vi.mocked(first.renderer.setTerrainExaggeration).mock.calls.at(-1)?.[0]).toBe(500);
        layer.props = {scene, ...callbacks}; layer.updateState({props: layer.props}); await getLiveRecord(layer).loadPromise;
        expect(first.renderer.destroy).toHaveBeenCalledOnce();
        const flat = getLiveRecord(layer);
        layer.props = {scene, ...callbacks, terrain}; layer.updateState({props: layer.props}); await getLiveRecord(layer).loadPromise;
        expect(flat.renderer.destroy).toHaveBeenCalledOnce(); expect(createRenderer).toHaveBeenCalledTimes(3);
        const renderer = getLiveRecord(layer).renderer;
        vi.mocked(renderer.setTerrain).mockRejectedValueOnce(new Error('limit'));
        layer.props = {scene, ...callbacks, terrain: {grids: []}}; layer.updateState({props: layer.props});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(layer.raiseError).toHaveBeenCalled();
        vi.mocked(layer.raiseError).mockClear(); vi.mocked(renderer.setTerrainExaggeration).mockImplementationOnce(() => {throw new Error('range');});
        layer.updateState({props: layer.props}); expect(layer.raiseError).toHaveBeenCalled();
    } finally {layer.finalizeState();}
});
