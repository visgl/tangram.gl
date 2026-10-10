// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import {MapView, FirstPersonView, _GlobeView as GlobeView} from '@deck.gl/core';
import {describe, expect, test} from 'vitest';
import {TerrainMeshSurface} from '@vis.gl/tangram-renderer/core';
import {WebXRPresentation, WebXRMapView, WebXRGlobeView, WebXRFirstPersonView,
  createXRPlacementMatrix, intersectXRGlobe, intersectXRMap, pickXRSurface,
  type XRPlacement, type XRSpatialRay} from '@vis.gl/tangram-layers/experimental/webxr';

/** Real deck views with deterministic scene-independent cameras. */
function createPresentation(type: 'map' | 'globe' | 'first-person', mode: 'mono' | 'stereo-preview' = 'mono') {
  const view = type === 'globe' ? new WebXRGlobeView({id: type}) : type === 'map'
    ? new WebXRMapView({id: type}) : new WebXRFirstPersonView({id: type, far: 20000});
  return new WebXRPresentation({view, mode, viewState: {
    longitude: 179.95, latitude: 65, bearing: 35, pitch: type === 'globe' ? 0 : 45,
    ...(type === 'first-person' ? {position: [0, 0, 200]} : {zoom: type === 'globe' ? 2 : 14})
  }});
}

describe('rendered-eye surface picking', () => {
  test.each(['map', 'globe', 'first-person'] as const)('%s: matches the logical viewport in mono and center-eye mode', type => {
    const presentation = createPresentation(type);
    const frame = presentation.createFrame({width: 800, height: 400});
    const nativeView = type === 'globe' ? new GlobeView() : type === 'map' ? new MapView() : new FirstPersonView();
    const position: [number, number, number] = [0, 0, 200];
    const expected = nativeView.makeViewport({width: 800, height: 400,
      viewState: {longitude: 179.95, latitude: 65, zoom: type === 'globe' ? 2 : 14,
        bearing: 35, pitch: type === 'globe' ? 0 : 45,
        ...(type === 'first-person' ? {position} : {})}});
    // Check the public deck viewport independently of Tangram's camera adapter.
    if (!expected) throw new Error('Expected a native deck viewport');
    const coordinate = expected.unproject([350, 220], {targetZ: 0});
    for (const eye of [undefined, 'center'] as const) {
      const hit = pickXRSurface({pointer: {x: 350, y: 220, eye}, placement: presentation.placement, frame});
      expect(hit?.coordinate[0]).toBeCloseTo(coordinate[0], 5);
      expect(hit?.coordinate[1]).toBeCloseTo(coordinate[1], 5);
      expect(hit?.coordinate[2]).toBe(0);
    }
  });

  test.each(['map', 'globe'] as const)('%s: both stereo halves pick the same convergence anchor', type => {
    const presentation = createPresentation(type, 'stereo-preview');
    const frame = presentation.createFrame({width: 800, height: 400, interpupillaryDistance: 0.25});
    const before = JSON.stringify(frame.hostFrame);
    for (const [x, eye, id] of [[200, 'left', 'left-eye'], [600, 'right', 'right-eye']] as const) {
      const hit = pickXRSurface({pointer: {x, y: 200, eye}, placement: presentation.placement, frame});
      expect(hit?.coordinate[0]).toBeCloseTo(179.95, 5);
      expect(hit?.coordinate[1]).toBeCloseTo(65, 5);
      expect(hit?.renderViewId).toBe(id);
    }
    expect(JSON.stringify(frame.hostFrame)).toBe(before);
    expect(pickXRSurface({pointer: {x: 600, y: 200, eye: 'left'}, placement: presentation.placement, frame})).toBeNull();
    const center = pickXRSurface({pointer: {x: 400, y: 200, eye: 'center'}, placement: presentation.placement, frame});
    expect(center?.coordinate[0]).toBeCloseTo(179.95, 5);
    expect(center?.renderViewId).toBeUndefined();
  });

  test('picks the actual shifted eye camera rather than a rebuilt logical viewport', () => {
    const presentation = createPresentation('map', 'stereo-preview');
    const frame = presentation.createFrame({width: 800, height: 400});
    const rayHit = pickXRSurface({pointer: {x: 200, y: 200}, placement: presentation.placement, frame});
    const camera = frame.renderViews[0].camera;
    camera.view = new Matrix4(camera.view).translate([1000, 0, 0]);
    const shifted = pickXRSurface({pointer: {x: 200, y: 200}, placement: presentation.placement, frame});
    expect(shifted?.position[0]).toBeCloseTo(rayHit!.position[0] - 1000, 5);
  });

  test.each([[-1, 200], [800, 200], [200, -1], [200, 400], [NaN, 200]])('rejects out-of-canvas pointer %j', (x, y) => {
    const presentation = createPresentation('map');
    const frame = presentation.createFrame({width: 800, height: 400});
    expect(pickXRSurface({pointer: {x, y}, placement: presentation.placement, frame})).toBeNull();
  });

  test('misses the sky and outside the globe silhouette', () => {
    const presentation = createPresentation('first-person');
    presentation.setViewState({pitch: -80});
    let frame = presentation.createFrame({width: 800, height: 400});
    expect(pickXRSurface({pointer: {x: 400, y: 200}, placement: presentation.placement, frame})).toBeNull();
    const globe = createPresentation('globe');
    globe.setViewState({zoom: -1});
    frame = globe.createFrame({width: 800, height: 400});
    expect(pickXRSurface({pointer: {x: 0, y: 0}, placement: globe.placement, frame})).toBeNull();
  });

  test('limits screen hits to near/far planes and rejects singular cameras', () => {
    const presentation = createPresentation('map');
    const frame = presentation.createFrame({width: 100, height: 100});
    const camera = frame.renderViews[0].camera;
    camera.view = new Matrix4().lookAt({eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0]});
    for (const [near, far, intersects] of [[1, 5, false], [11, 20, false], [1, 20, true]] as const) {
      camera.projection = new Matrix4().perspective({fovy: Math.PI / 3, aspect: 1, near, far});
      expect(Boolean(pickXRSurface({pointer: {x: 50, y: 50}, placement: presentation.placement, frame}))).toBe(intersects);
    }
    camera.projection = new Array(16).fill(0);
    expect(pickXRSurface({pointer: {x: 50, y: 50}, placement: presentation.placement, frame})).toBeNull();
  });
});

describe('room-space surface picking', () => {
  test('derives first-person body heading from the frame when explicit view state is omitted', () => {
    const presentation = createPresentation('first-person');
    const frame = presentation.createFrame({width: 800, height: 400});
    const pointer = {origin: [100, 2, 300] as const, direction: [0, -1, 0] as const};
    const options = {pointer, frame, placement: presentation.placement};
    const inferred = pickXRSurface(options);
    const explicit = pickXRSurface({...options, viewState: presentation.getViewState()});
    expect(inferred).not.toBeNull();
    expect(inferred?.coordinate).toEqual(explicit?.coordinate);
  });

  test('converts offset native XR framebuffer rectangles to top-origin screen input', () => {
    const presentation = createPresentation('map');
    const placement = {type: 'map' as const, anchor: [0, 0] as const, metersPerXRUnit: 1000};
    presentation.setViewState({longitude: 0, latitude: 0});
    presentation.setPlacement(placement);
    const frame = presentation.createFrame({width: 800, height: 600, mode: 'immersive-vr',
      frameState: {views: [{index: 0, eye: 'left', viewport: [100, 100, 400, 200],
        viewMatrix: new Matrix4().lookAt({eye: [0, 2, 3], center: [0, 0, 0], up: [0, 1, 0]}),
        projectionMatrix: new Matrix4().perspective({fovy: Math.PI / 3, aspect: 2, near: 0.1, far: 100})}]}});
    const before = JSON.stringify(frame);
    const hit = pickXRSurface({pointer: {x: 300, y: 400, eye: 'left'}, placement, frame});
    expect(hit?.coordinate[0]).toBeCloseTo(0, 6);
    expect(hit?.coordinate[1]).toBeCloseTo(0, 6);
    expect(pickXRSurface({pointer: {x: 300, y: 200}, placement, frame})).toBeNull();
    expect(JSON.stringify(frame)).toBe(before);
  });

  test.each(['map', 'globe', 'first-person'] as const)('%s: mock XR screen and controller ray agree after placement', type => {
    const placement: XRPlacement = type === 'globe'
      ? {type, anchor: [179, 70], radius: 1}
      : type === 'map' ? {type, anchor: [179, 70], metersPerXRUnit: 1000}
        : {type, origin: [179, 70], position: [100, 0, 0]};
    const presentation = createPresentation(type);
    presentation.setViewState({longitude: 179, latitude: 70, bearing: 0});
    presentation.setPlacement(placement);
    const viewMatrix = new Matrix4().lookAt({eye: [0, 2, 3], center: [0, 0, 0], up: [0, 1, 0]});
    const projectionMatrix = new Matrix4().perspective({fovy: Math.PI / 3, aspect: 2, near: 0.1, far: 100});
    const frame = presentation.createFrame({width: 800, height: 400, frameState: {views: [{index: 0, eye: 'left',
      viewport: [0, 0, 800, 400], viewMatrix, projectionMatrix}]}, mode: 'immersive-vr'});
    const ray: XRSpatialRay = {origin: [0, 2, 3], direction: [0, -2, -3]};
    const spatial = pickXRSurface({pointer: ray, placement, frame});
    const screen = pickXRSurface({pointer: {x: 400, y: 200}, placement, frame});
    expect(spatial).not.toBeNull();
    spatial!.coordinate.forEach((value, index) => expect(screen?.coordinate[index]).toBeCloseTo(value, 5));
    expect(pickXRSurface({pointer: {x: 400, y: 200, eye: 'center'}, placement, frame})).toBeNull();
  });

  test('uses animated placement overrides and respects tabletop bounds', () => {
    const placement = {type: 'map' as const, anchor: [0, 0] as const, metersPerXRUnit: 1000,
      surface: {type: 'bounded' as const, width: 2, height: 1}};
    const ray = {origin: [3, 1, 0] as const, direction: [0, -1, 0] as const};
    expect(pickXRSurface({pointer: ray, placement})).toBeNull();
    const matrix = new Matrix4().translate([3, 0, 0]).multiplyRight(createXRPlacementMatrix(placement));
    const hit = pickXRSurface({pointer: ray, placement, placementMatrix: matrix});
    expect(hit?.coordinate).toEqual([expect.closeTo(0, 7), expect.closeTo(0, 7), 0]);
    expect(pickXRSurface({pointer: ray, placement: {...placement, surface: {type: 'unbounded'}}})).not.toBeNull();
  });

  test('matches existing map/globe helpers and handles non-unit directions', () => {
    const map = {type: 'map' as const, anchor: [-74, 40] as const, metersPerXRUnit: 1000};
    const globe = {type: 'globe' as const, anchor: [-74, 40] as const, radius: 1};
    const mapRay = {origin: [0, 1, 0] as const, direction: [0, -5, 0] as const};
    const globeRay = {origin: [0, 0, 2] as const, direction: [0, 0, -5] as const};
    expect(pickXRSurface({pointer: mapRay, placement: map})?.coordinate).toEqual(intersectXRMap(mapRay, map));
    expect(pickXRSurface({pointer: globeRay, placement: globe})?.coordinate).toEqual(intersectXRGlobe(globeRay, globe));
    expect(pickXRSurface({pointer: {...mapRay, direction: [0, -1e-100, 0]}, placement: map})?.coordinate).toEqual(intersectXRMap(mapRay, map));
  });

  test.each([Float32Array, Float64Array])('preserves %s room placement matrices', MatrixArray => {
    const placement = {type: 'map' as const, anchor: [0, 0] as const, metersPerXRUnit: 1000};
    const matrix = new MatrixArray(new Matrix4().translate([3, 0, 0])
      .multiplyRight(createXRPlacementMatrix(placement)));
    const before = Array.from(matrix);
    const hit = pickXRSurface({pointer: {origin: [3, 1, 0], direction: [0, -1, 0]},
      placement, placementMatrix: matrix});
    expect(hit?.coordinate[0]).toBeCloseTo(0, 6);
    expect(hit?.coordinate[1]).toBeCloseTo(0, 6);
    expect(Array.from(matrix)).toEqual(before);
  });

  test.each([
    {origin: [0, 1, 0], direction: [0, 0, 0]},
    {origin: [Infinity, 1, 0], direction: [0, -1, 0]},
    {origin: [0, 1, 0], direction: [NaN, -1, 0]},
    {origin: [0, 1, 0], direction: [1, 0, 0]},
    {origin: [0, 1, 0], direction: [0, 1, 0]}
  ] satisfies XRSpatialRay[])('rejects invalid, parallel and away-pointing rays: %j', pointer => {
    expect(pickXRSurface({pointer, placement: {type: 'map', anchor: [0, 0], metersPerXRUnit: 1000}})).toBeNull();
  });

  test('rejects singular room placement and screen input without a frame', () => {
    const placement = {type: 'map' as const, anchor: [0, 0] as const, metersPerXRUnit: 1000};
    expect(pickXRSurface({pointer: {origin: [0, 1, 0], direction: [0, -1, 0]}, placement,
      placementMatrix: new Array(16).fill(0)})).toBeNull();
    expect(pickXRSurface({pointer: {x: 10, y: 10}, placement})).toBeNull();
  });
});

test('explicit terrain supplies altitude for room rays and never substitutes a flat plane for a hole', () => {
  const terrain = new TerrainMeshSurface({projection: 'web-mercator',
    positions: [-2000, -2000, 100, 2000, -2000, 100, 0, 2000, 100], indices: [0, 1, 2]});
  const placement = {type: 'map' as const, anchor: [0, 0] as const, metersPerXRUnit: 1000};
  const hit = pickXRSurface({pointer: {origin: [0, 1, 0], direction: [0, -1, 0]}, placement, terrain});
  expect(hit?.coordinate).toEqual([0, 0, 100]);
  expect(hit?.terrain).toMatchObject({triangleIndex: 0, normal: [0, 0, 1]});
  expect(pickXRSurface({pointer: {origin: [5, 1, 0], direction: [0, -1, 0]}, placement, terrain})).toBeNull();
  expect(pickXRSurface({pointer: {origin: [1, 1, 0], direction: [0, -1, 0]}, terrain,
    placement: {...placement, surface: {type: 'bounded', width: 0.5, height: 0.5}}})).toBeNull();
  const globe = new TerrainMeshSurface({projection: 'globe', positions: [], indices: []});
  expect(pickXRSurface({pointer: {origin: [0, 1, 0], direction: [0, -1, 0]}, placement, terrain: globe})).toBeNull();
});

test('terrain screen rays use their actual stereo camera, near/far range and eye identifier', () => {
  const presentation = createPresentation('map', 'stereo-preview');
  presentation.setViewState({longitude: 0, latitude: 0});
  const frame = presentation.createFrame({width: 800, height: 400});
  const terrain = new TerrainMeshSurface({projection: 'web-mercator',
    positions: [-2000, -2000, 100, 2000, -2000, 100, 0, 2000, 100], indices: [0, 1, 2]});
  for (const [index, x] of [[0, 200], [1, 600]]) {
    frame.renderViews[index].camera.view = new Matrix4().translate([0, 0, -1000]);
    frame.renderViews[index].camera.projection = new Matrix4().ortho({left: -1000, right: 1000,
      bottom: -1000, top: 1000, near: 1, far: 2000});
    const options = {pointer: {x, y: 200}, placement: presentation.placement, frame, terrain};
    expect(pickXRSurface(options)).toMatchObject({coordinate: [0, 0, 100], renderViewId: index ? 'right-eye' : 'left-eye'});
    frame.renderViews[index].camera.projection = new Matrix4().ortho({left: -1000, right: 1000,
      bottom: -1000, top: 1000, near: 1, far: 500});
    expect(pickXRSurface(options)).toBeNull();
  }
});
