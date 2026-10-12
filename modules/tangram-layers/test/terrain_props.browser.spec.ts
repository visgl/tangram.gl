// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import createTangramLayerClass from '../src/tangram-layer';

test('terrain props rebuild the existing renderer, while enabling/disabling replaces attribute layouts', async () => {
    class BaseLayer {}
    const createRenderer = vi.fn(() => ({scene: {}, subscribe: vi.fn(), load: vi.fn(async () => undefined), destroy: vi.fn(),
        setTerrain: vi.fn(async (_terrain: object) => undefined), setTerrainExaggeration: vi.fn((_value: number) => {}), getAttributions: vi.fn(async () => []), getTerrainDrapingStatistics: vi.fn(() => ({enabled: true}))}));
    const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {create: createRenderer}, Renderer: undefined});
    const layer = new Layer(); layer.state = {tangramRecord: null};
    layer.setState = (state: Record<string, unknown>) => Object.assign(layer.state, state);
    layer.raiseError = vi.fn(); layer._synchronizeTangramScene = vi.fn();
    layer.context = {device: {type: 'webgpu', createBuffer: vi.fn(), createShader: vi.fn(), createTexture: vi.fn(), createRenderPipeline: vi.fn(), createVertexArray: vi.fn()}, deck: {getCanvas: () => document.createElement('canvas')}};
    const scene = {};
    const callbacks = {onSceneLoad: vi.fn(), onSceneError: vi.fn()};
    const terrain = {grids: []};
    try {
        layer.props = {scene, ...callbacks, terrain, terrainExaggeration: 1}; layer.updateState({props: layer.props});
        const first = layer.state.tangramRecord; await first.loadPromise;
        expect(createRenderer.mock.calls).toHaveLength(1); expect(first.terrain).toBe(terrain);
        expect(layer.getTerrainDrapingStatistics()).toEqual({enabled: true});
        const next = {grids: [], maxSegmentLength: 100};
        layer.props = {scene, ...callbacks, terrain: next, terrainExaggeration: 2}; layer.updateState({props: layer.props}); await Promise.resolve(); await Promise.resolve();
        expect(layer.state.tangramRecord).toBe(first); expect(first.renderer.setTerrain).toHaveBeenCalledWith(next);
        await expect.poll(() => first.renderer.setTerrainExaggeration.mock.calls.at(-1)?.[0]).toBe(2);
        let finish: () => void = () => {};
        first.renderer.setTerrain.mockImplementationOnce(() => new Promise<void>(resolve => {finish = resolve;}));
        first.renderer.setTerrainExaggeration.mockClear();
        const replacement = {grids: [], previousGrids: []};
        layer.props = {scene, ...callbacks, terrain: replacement, terrainExaggeration: 1000}; layer.updateState({props: layer.props});
        await Promise.resolve(); await Promise.resolve();
        expect(first.renderer.setTerrainExaggeration).not.toHaveBeenCalled();
        // Exaggeration-only updates during the rebuild also wait, and the latest owner wins.
        layer.props = {...layer.props, terrainExaggeration: 500}; layer.updateState({props: layer.props});
        expect(first.renderer.setTerrainExaggeration).not.toHaveBeenCalled();
        finish();
        await expect.poll(() => first.renderer.setTerrainExaggeration.mock.calls.at(-1)?.[0]).toBe(500);
        layer.props = {scene, ...callbacks}; layer.updateState({props: layer.props}); await layer.state.tangramRecord.loadPromise;
        expect(first.renderer.destroy).toHaveBeenCalledOnce();
        const flat = layer.state.tangramRecord;
        layer.props = {scene, ...callbacks, terrain}; layer.updateState({props: layer.props}); await layer.state.tangramRecord.loadPromise;
        expect(flat.renderer.destroy).toHaveBeenCalledOnce(); expect(createRenderer).toHaveBeenCalledTimes(3);
        const renderer = layer.state.tangramRecord.renderer;
        renderer.setTerrain.mockRejectedValueOnce(new Error('limit'));
        layer.props = {scene, ...callbacks, terrain: {grids: []}}; layer.updateState({props: layer.props});
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(layer.raiseError).toHaveBeenCalled();
        layer.raiseError.mockClear(); renderer.setTerrainExaggeration.mockImplementationOnce(() => {throw new Error('range');});
        layer.updateState({props: layer.props}); expect(layer.raiseError).toHaveBeenCalled();
    } finally {layer.finalizeState();}
});
