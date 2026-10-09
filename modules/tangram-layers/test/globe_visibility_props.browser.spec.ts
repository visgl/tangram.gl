// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import {FirstPersonViewport} from '@deck.gl/core';
import {expect, test, vi} from 'vitest';
import createTangramLayerClass from '../src/tangram-layer';

test('updates globe visibility props without recreating the scene and reports invalid heights', () => {
  class BaseLayer {}
  class GlobeViewport {}
  const viewport = Object.assign(new GlobeViewport(), {
    width: 800, height: 600, longitude: 0, latitude: 0, zoom: 2,
    isGeospatial: true, cameraPosition: [0, -1000, 0],
    viewMatrix: new Matrix4(), projectionMatrix: new Matrix4(),
    getBounds: () => [-120, -60, 120, 60]
  });
  const createRenderer = vi.fn();
  const Layer = createTangramLayerClass({Layer: BaseLayer,
    ClassicWebGLRenderer: {create: createRenderer}, Renderer: undefined});
  const layer = new Layer();
  const setFrame = vi.fn();
  const raiseError = vi.fn();
  layer.raiseError = raiseError;
  layer.props = {scene: 'scene.yaml', sceneBasePath: null, apiKey: null,
    globeMaxElevation: 3000, globeVisibleBounds: [-180, -85, 180, 85], onSceneError: vi.fn()};
  layer.context = {viewport, deck: {getViewports: () => [viewport]}};
  const record = {renderer: {setFrame}, deckCanvas: document.createElement('canvas'),
    sceneSource: 'scene.yaml', sceneBasePath: null, apiKey: null};
  layer.state = {tangramRecord: record};
  layer._synchronizeTangramScene(record);
  expect(raiseError).not.toHaveBeenCalled();
  expect(setFrame.mock.calls.at(-1)?.[0].projection).toEqual({
    type: 'globe', visibleBounds: [-180, -85, 180, 85], maxElevation: 3000
  });
  layer.props = {...layer.props, globeMaxElevation: 9000};
  layer.updateState({props: layer.props});
  layer._synchronizeTangramScene(record);
  expect(createRenderer).not.toHaveBeenCalled();
  expect(setFrame.mock.calls.at(-1)?.[0].projection.maxElevation).toBe(9000);
  layer.props = {...layer.props, globeMaxElevation: -1};
  const frames = setFrame.mock.calls.length;
  layer._synchronizeTangramScene(record);
  expect(setFrame).toHaveBeenCalledTimes(frames);
  expect(raiseError.mock.calls.at(-1)?.[0].message).toMatch(/maxElevation/);
});

test('updates first-person extent without recreating the scene and reports invalid extents', () => {
  class BaseLayer {}
  const viewport = new FirstPersonViewport({width: 800, height: 600,
    longitude: 0, latitude: 0, position: [0, 0, 200], pitch: 0, far: 20000});
  const createRenderer = vi.fn();
  const Layer = createTangramLayerClass({Layer: BaseLayer,
    ClassicWebGLRenderer: {create: createRenderer}, Renderer: undefined});
  const layer = new Layer();
  const setFrame = vi.fn();
  const raiseError = vi.fn();
  layer.raiseError = raiseError;
  layer.props = {scene: 'scene.yaml', sceneBasePath: null, apiKey: null,
    firstPersonMaxGroundExtent: 1000, onSceneError: vi.fn()};
  layer.context = {viewport, deck: {getViewports: () => [viewport]}};
  const record = {renderer: {setFrame}, deckCanvas: document.createElement('canvas'),
    sceneSource: 'scene.yaml', sceneBasePath: null, apiKey: null};
  layer.state = {tangramRecord: record};
  layer._synchronizeTangramScene(record);
  const before = setFrame.mock.calls.at(-1)?.[0].projection.visibleBounds;
  layer.props = {...layer.props, firstPersonMaxGroundExtent: 2000};
  layer.updateState({props: layer.props});
  layer._synchronizeTangramScene(record);
  expect(raiseError).not.toHaveBeenCalled();
  expect(createRenderer).not.toHaveBeenCalled();
  const after = setFrame.mock.calls.at(-1)?.[0].projection.visibleBounds;
  expect(after[2] - after[0]).toBeGreaterThan(before[2] - before[0]);
  const frames = setFrame.mock.calls.length;
  layer.props = {...layer.props, firstPersonMaxGroundExtent: 0};
  layer._synchronizeTangramScene(record);
  expect(setFrame).toHaveBeenCalledTimes(frames);
  expect(raiseError.mock.calls.at(-1)?.[0].message).toMatch(/maxGroundExtent/);
});

test('updates first-person elevation candidates without recreating the scene or changing the camera', () => {
  class BaseLayer {}
  const viewport = new FirstPersonViewport({width: 800, height: 600,
    longitude: 179.99, latitude: 60, position: [0, 0, 600], pitch: -80, far: 20000});
  const createRenderer = vi.fn();
  const Layer = createTangramLayerClass({Layer: BaseLayer,
    ClassicWebGLRenderer: {create: createRenderer}, Renderer: undefined});
  const layer = new Layer();
  const setFrame = vi.fn();
  layer.raiseError = vi.fn();
  layer.props = {scene: 'scene.yaml', sceneBasePath: null, apiKey: null,
    firstPersonElevationRange: [0, 0], onSceneError: vi.fn()};
  layer.context = {viewport, deck: {getViewports: () => [viewport]}};
  const record = {renderer: {setFrame}, deckCanvas: document.createElement('canvas'),
    sceneSource: 'scene.yaml', sceneBasePath: null, apiKey: null};
  layer.state = {tangramRecord: record};
  layer._synchronizeTangramScene(record);
  const before = setFrame.mock.calls.at(-1)?.[0];
  expect(before.projection.visibleBounds).toBeNull();
  layer.props = {...layer.props, firstPersonElevationRange: [0, 1500]};
  layer.updateState({props: layer.props});
  layer._synchronizeTangramScene(record);
  const after = setFrame.mock.calls.at(-1)?.[0];
  expect(after.projection.visibleBounds).not.toBeNull();
  expect(after.camera).toEqual(before.camera);
  expect(createRenderer).not.toHaveBeenCalled();
  expect(layer.raiseError).not.toHaveBeenCalled();
  const frames = setFrame.mock.calls.length;
  layer.props = {...layer.props, firstPersonElevationRange: [1500, 0]};
  layer._synchronizeTangramScene(record);
  expect(setFrame).toHaveBeenCalledTimes(frames);
  expect(layer.raiseError.mock.calls.at(-1)?.[0].message).toMatch(/Elevation range/);
});
