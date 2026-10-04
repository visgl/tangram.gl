// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {FirstPersonViewport, WebMercatorViewport, _GlobeViewport as GlobeViewport} from '@deck.gl/core';
import {expect, test, vi} from 'vitest';
import createTangramLayerClass from '../src/tangram-layer';
import {WebXRPresentation} from '../src/experimental/webxr/presentation';
import {WebXRMapView, WebXRGlobeView, WebXRFirstPersonView} from '../src/experimental/webxr/views';

test.each([
  new WebMercatorViewport({width: 800, height: 400, longitude: 0, latitude: 0, zoom: 2}),
  new GlobeViewport({width: 800, height: 400, longitude: 0, latitude: 0, zoom: 2}),
  new FirstPersonViewport({width: 800, height: 400, longitude: 0, latitude: 0,
    position: [0, 0, 200], pitch: 0, far: 20000})
])('forwards resource policy changes and omission without recreating the layer scene: $id', viewport => {
  class BaseLayer {}
  const createRenderer = vi.fn();
  const Layer = createTangramLayerClass({Layer: BaseLayer,
    ClassicWebGLRenderer: {create: createRenderer}, Renderer: undefined});
  const layer = new Layer();
  const setFrame = vi.fn();
  layer.raiseError = vi.fn();
  layer.props = {scene: 'scene.yaml', sceneBasePath: null, apiKey: null,
    tileResources: {maxConcurrentBuilds: 1}, onSceneError: vi.fn()};
  layer.context = {viewport, deck: {getViewports: () => [viewport]}};
  const record = {renderer: {setFrame}, deckCanvas: document.createElement('canvas'),
    sceneSource: 'scene.yaml', sceneBasePath: null, apiKey: null};
  layer.state = {tangramRecord: record};
  for (const tileResources of [{maxConcurrentBuilds: 1}, {maxCachedTiles: 0}, undefined]) {
    layer.props = {...layer.props, tileResources};
    layer.updateState({props: layer.props});
    layer._synchronizeTangramScene(record);
    expect(setFrame.mock.calls.at(-1)?.[0].tileResources).toEqual(tileResources);
  }
  expect(layer.raiseError).not.toHaveBeenCalled();
  expect(createRenderer).not.toHaveBeenCalled();
  expect(setFrame).toHaveBeenCalledTimes(3);
});

test('worker load capacity is passed at renderer creation and changes replace the immutable worker pool', async () => {
  class BaseLayer {}
  const createRenderer = vi.fn((_scene: unknown, _options: Record<string, unknown>) =>
    ({scene: {}, subscribe: vi.fn(), load: vi.fn(async () => undefined), destroy: vi.fn()}));
  const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {create: createRenderer}, Renderer: undefined});
  const layer = new Layer();
  const synchronize = vi.spyOn(layer, '_synchronizeTangramScene').mockImplementation(() => {});
  layer.raiseError = vi.fn();
  layer.setState = (state: Record<string, unknown>) => { Object.assign(layer.state, state); };
  layer.props = {scene: 'scene.yaml', sceneBasePath: null, apiKey: null,
    maxConcurrentTileLoadsPerWorker: 2, onSceneLoad: vi.fn(), onSceneError: vi.fn()};
  layer.state = {tangramRecord: null};
  const device = {type: 'webgpu', createBuffer: vi.fn(), createShader: vi.fn(), createTexture: vi.fn(),
    createRenderPipeline: vi.fn(), createVertexArray: vi.fn()};
  layer.context = {device, deck: {getCanvas: () => document.createElement('canvas')}};
  try {
    layer.updateState({props: layer.props});
    const first = layer.state.tangramRecord;
    await first.loadPromise;
    expect(createRenderer.mock.calls[0][1].maxConcurrentTileLoadsPerWorker).toBe(2);
    layer.updateState({props: layer.props});
    expect(layer.state.tangramRecord).toBe(first);
    layer.props = {...layer.props, maxConcurrentTileLoadsPerWorker: null};
    layer.updateState({props: layer.props});
    const second = layer.state.tangramRecord;
    await second.loadPromise;
    expect(first.disposed).toBe(true);
    expect(createRenderer.mock.calls[1][1].maxConcurrentTileLoadsPerWorker).toBeUndefined();
    layer.updateState({props: layer.props});
    expect(layer.state.tangramRecord).toBe(second);
    expect(createRenderer).toHaveBeenCalledTimes(2);
    expect(layer.raiseError).not.toHaveBeenCalled();
  } finally { layer.finalizeState(); synchronize.mockRestore(); }
});

test.each([
  new WebXRMapView({id: 'map'}),
  new WebXRGlobeView({id: 'globe'}),
  new WebXRFirstPersonView({id: 'first-person', far: 20000})
])('shares a single resource policy across mono and stereo eyes: $id', view => {
  const presentation = new WebXRPresentation({view,
    viewState: {longitude: 0, latitude: 0, zoom: 2, position: [0, 0, 200]}});
  const tileResources = {maxConcurrentBuilds: 2, maxCachedTiles: 8, maxCachedMeshBytes: 1024};
  try {
    for (const mode of ['mono', 'stereo-preview'] as const) {
      const frame = presentation.createFrame({width: 800, height: 400, mode, tileResources});
      expect(frame.hostFrame.tileResources).toEqual(tileResources);
      expect(frame.hostFrame.renderViews).toHaveLength(mode === 'mono' ? 1 : 2);
    }
    expect(presentation.createFrame({width: 800, height: 400}).hostFrame.tileResources).toBeUndefined();
  } finally {
    presentation.finalize();
  }
});
