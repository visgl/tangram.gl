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
