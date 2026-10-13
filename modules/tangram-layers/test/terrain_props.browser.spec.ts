// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import createTangramLayerClass from '../src/tangram-layer';
import {DrapedTerrainSurfaceSnapshot} from '@vis.gl/tangram-renderer/core';
import {createContextFixture, createRecordFixture, createRendererFixture, getLiveRecord} from './fixtures/lifecycle';

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
