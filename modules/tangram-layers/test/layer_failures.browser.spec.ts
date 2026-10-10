// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {WebMercatorViewport} from '@deck.gl/core';
import {expect, test, vi} from 'vitest';
import createTangramLayerClass from '../src/tangram-layer';

/** Lightweight renderer boundary: no network, workers, or GPU allocation. */
function createHarness() {
  class BaseLayer {}
  const renderer = {scene: {}, subscribe: vi.fn(), load: vi.fn(async () => undefined),
    destroy: vi.fn(), setFrame: vi.fn(), getTerrainAt: vi.fn().mockReturnValue({coordinate: [0, 0, 100], renderViewId: 'right'}),
    getFeatureAt: vi.fn().mockResolvedValue({feature: {id: 7}, renderViewId: 'right'})};
  const create = vi.fn((_source: unknown, _options: {requestRedraw: () => void}) => renderer);
  const Layer = createTangramLayerClass({Layer: BaseLayer, ClassicWebGLRenderer: {create}, Renderer: undefined});
  const layer = new Layer();
  layer.props = {...Layer.defaultProps, scene: 'scene.yaml', onSceneLoad: vi.fn(), onSceneError: vi.fn()};
  layer.state = {};
  layer.raiseError = vi.fn();
  layer.setNeedsRedraw = vi.fn();
  const canvas = document.createElement('canvas');
  const viewport = new WebMercatorViewport({width: 800, height: 400, latitude: 40, longitude: -74, zoom: 14});
  const device = {type: 'webgpu', createBuffer: vi.fn(), createShader: vi.fn(), createTexture: vi.fn(),
    createRenderPipeline: vi.fn(), createVertexArray: vi.fn()};
  layer.context = {device, viewport, deck: {getCanvas: () => canvas, getViewports: () => [viewport]}};
  return {layer, renderer, create, canvas, device};
}

test('ordinary layers forward canvas/eye query options to the renderer and keep the current owner drawing', async () => {
  const {layer, renderer} = createHarness();
  expect(await layer.getFeatureAt({x: 500, y: 100})).toBeUndefined();
  const owner = createHarness().layer;
  const record = layer._createTangramRecord(layer.props);
  if (!record) throw new Error('Expected a renderer record');
  layer.state.tangramRecord = record;
  await record.loadPromise;
  record.owner = owner;
  const options = {coordinateSpace: 'canvas' as const, renderViewId: 'right', radius: 3};
  expect(await layer.getFeatureAt({x: 500, y: 100}, options)).toEqual({feature: {id: 7}, renderViewId: 'right'});
  expect(renderer.getFeatureAt).toHaveBeenCalledExactlyOnceWith({x: 500, y: 100}, options);
  expect(owner.setNeedsRedraw).toHaveBeenCalledOnce();
  record.loadFailed = true;
  expect(await layer.getFeatureAt({x: 500, y: 100})).toBeUndefined();
  layer.finalizeState();
});

test('terrain queries forward the supplied surface and eye policy without allocating or redrawing', async () => {
  const {layer, renderer} = createHarness();
  const surface = {projection: 'web-mercator' as const, intersectRay: vi.fn()};
  const uninitialized = createHarness().layer;
  uninitialized.state = undefined;
  expect(uninitialized.getTerrainAt({x: 50, y: 20}, surface)).toBeNull();
  expect(layer.getTerrainAt({x: 50, y: 20}, surface)).toBeNull();
  const record = layer._createTangramRecord(layer.props);
  if (!record) throw new Error('Expected renderer record');
  layer.state.tangramRecord = record;
  expect(layer.getTerrainAt({x: 50, y: 20}, surface)).toBeNull();
  await record.loadPromise;
  const options = {coordinateSpace: 'canvas' as const, renderViewId: 'right'};
  expect(layer.getTerrainAt({x: 50, y: 20}, surface, options)).toEqual({coordinate: [0, 0, 100], renderViewId: 'right'});
  expect(renderer.getTerrainAt).toHaveBeenCalledExactlyOnceWith({x: 50, y: 20}, surface, options);
  record.loadFailed = true;
  expect(layer.getTerrainAt({x: 50, y: 20}, surface)).toBeNull();
  record.loadFailed = false;
  layer.finalizeState();
  expect(layer.getTerrainAt({x: 50, y: 20}, surface)).toBeNull();
  expect(renderer.getTerrainAt).toHaveBeenCalledOnce();
});

test.each(['scene', 'canvas', 'device', 'pipeline', 'webgl-state', 'webgl-canvas'] as const)
  ('rejects missing or mismatched %s before allocating a renderer', missing => {
    const {layer, create, canvas, device} = createHarness();
    if (missing === 'scene') layer.props.scene = null;
    if (missing === 'canvas') layer.context.deck.getCanvas = () => null;
    if (missing === 'device') layer.context.device = null;
    if (missing === 'pipeline') layer.context.device = {...device, createRenderPipeline: undefined};
    if (missing === 'webgl-state') layer.context.device = {...device, type: 'webgl', handle: {canvas}};
    if (missing === 'webgl-canvas') layer.context.device = {...device, type: 'webgl',
      handle: {canvas: document.createElement('canvas')}, pushState: vi.fn(), popState: vi.fn()};
    expect(layer._createTangramRecord(layer.props)).toBeNull();
    expect(layer.raiseError).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

test.each([new Error('Creation failed'), {error: new Error('Creation failed')},
  {message: 'Creation failed'}, 'Creation failed'])('normalizes renderer creation failure: %j', failure => {
  const {layer, create} = createHarness();
  create.mockImplementation(() => {throw failure;});
  expect(layer._createTangramRecord(layer.props)).toBeNull();
  expect(layer.raiseError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message: 'Creation failed'}), 'TangramLayer bridge');
});

test('disposed before the load microtask never loads or notifies and destroys exactly once', async () => {
  const {layer, renderer, create} = createHarness();
  const record = layer._createTangramRecord(layer.props);
  if (!record) throw new Error('Expected a renderer record');
  layer.state.tangramRecord = record;
  layer.finalizeState();
  expect(renderer.destroy).not.toHaveBeenCalled();
  await record.loadPromise;
  layer.finalizeState();
  expect(renderer.load).not.toHaveBeenCalled();
  expect(renderer.destroy).toHaveBeenCalledTimes(1);
  expect(layer.props.onSceneLoad).not.toHaveBeenCalled();
  expect(layer.isLoaded).toBe(false);
  // A pending redraw callback must not wake a disposed layer.
  const options = create.mock.calls[0][1];
  options.requestRedraw();
  expect(layer.setNeedsRedraw).not.toHaveBeenCalled();
});

test('scene errors are deduplicated and stale callbacks are ignored after destruction', async () => {
  const {layer, renderer} = createHarness();
  const record = layer._createTangramRecord(layer.props);
  if (!record) throw new Error('Expected a renderer record');
  layer.state.tangramRecord = record;
  await record.loadPromise;
  expect(layer.isLoaded).toBe(true);
  const listeners = renderer.subscribe.mock.calls[0][0];
  listeners.error({type: 'scene_import', message: 'Optional import failed'});
  listeners.error({type: 'scene_import', message: 'Optional import failed'});
  expect(layer.isLoaded).toBe(true);
  expect(layer.props.onSceneError).toHaveBeenCalledTimes(1);
  listeners.error({type: 'scene', error: new Error('Fatal error')});
  expect(layer.isLoaded).toBe(false);
  expect(layer.props.onSceneError).toHaveBeenCalledTimes(2);
  layer.finalizeState();
  listeners.error({type: 'scene', message: 'Late callback'});
  expect(layer.props.onSceneError).toHaveBeenCalledTimes(2);
  expect(renderer.destroy).toHaveBeenCalledTimes(1);
});
