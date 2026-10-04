// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4, Quaternion} from '@math.gl/core';
import {describe, expect, test} from 'vitest';
import {WebXRInputAdapter, WebXRSurfaceGrabber, createXRPlacementMatrix, pickXRSurface,
  type XRInteractionIntent, type XRMapPlacement, type XRGlobePlacement, type XRSpatialRay,
  type XRSurfaceGrabContext} from '@vis.gl/tangram-layers/experimental/webxr';

/** Geographic content deliberately crossing the antimeridian at high latitude. */
const map: XRMapPlacement = {type: 'map', anchor: [179.9, 65, 0], metersPerXRUnit: 1000,
  pose: {position: [0, 0.7, -2]}, surface: {type: 'bounded', width: 1, height: 1}};
const globe: XRGlobePlacement = {type: 'globe', anchor: [179.9, 65], radius: 0.5,
  rotation: 23, pose: {position: [0, 1, -2]}};

/** Deterministic map pointer in room meters, independent of geographic scaling. */
function mapRay(horizontal = 0, depth = -2): XRSpatialRay {
  return {origin: [horizontal, 1.7, depth], direction: [0, -1, 0]};
}

/** Room pointer aimed at a fixed sphere centered two meters in front of the user. */
function globeRay(horizontal = 0): XRSpatialRay {
  return {origin: [horizontal, 1, 0], direction: [0, 0, -1]};
}

/** Give each synthetic pointer an explicit owner and optional activation source. */
function point(action: 'grab' | 'hover' | 'release' | 'cancel', pointer: XRSpatialRay = mapRay(),
  inputId = 'left:0', button?: 'select' | 'squeeze'): XRInteractionIntent {
  return {type: 'point', action, pointer, inputId, button};
}

describe('room-space surface grabbing', () => {
  test('slides a bounded map in room meters without changing geographic state or scale', () => {
    const grabber = new WebXRSurfaceGrabber();
    const context = {placement: map};
    const before = JSON.stringify(context);
    expect(grabber.dispatchInteractionIntent(point('grab'), context)).toBeNull();
    expect(grabber.isGrabbing()).toBe(true);
    const update = grabber.dispatchInteractionIntent(point('hover', mapRay(0.4, -2.25)), context);
    [0.4, 0.7, -2.25].forEach((value, index) => expect(update?.pose?.position?.[index]).toBeCloseTo(value, 7));
    expect(update?.anchor).toEqual(map.anchor);
    expect(update?.type === 'map' && update.metersPerXRUnit).toBe(1000);
    expect(update?.type === 'map' && update.surface).toEqual(map.surface);
    expect(JSON.stringify(context)).toBe(before);
    // A bounded surface gates acquisition, not movement after the grab begins.
    expect(grabber.dispatchInteractionIntent(point('hover', mapRay(2)), context)?.pose?.position?.[0]).toBe(2);
    grabber.dispatchInteractionIntent(point('release'), context);
    expect(grabber.isGrabbing()).toBe(false);
    expect(grabber.dispatchInteractionIntent(point('hover'), context)).toBeNull();
  });

  test('uses a frozen baseline instead of accumulating application placement feedback', () => {
    const grabber = new WebXRSurfaceGrabber();
    const context = {placement: map};
    grabber.dispatchInteractionIntent(point('grab'), context);
    const first = grabber.dispatchInteractionIntent(point('hover', mapRay(0.2)), context);
    if (!first) throw new Error('Expected map update');
    const second = grabber.dispatchInteractionIntent(point('hover', mapRay(0.4)), {placement: first});
    [0.4, 0.7, -2].forEach((value, index) => expect(second?.pose?.position?.[index]).toBeCloseTo(value, 7));
    // Returned objects and application-owned start snapshots cannot mutate the baseline.
    expect(first.anchor).not.toBe(map.anchor);
    expect(first.pose?.orientation).not.toBe(map.pose?.orientation);
    expect(first.type === 'map' && first.surface).not.toBe(map.surface);
  });

  test('slides a tilted map in its own initial plane', () => {
    const orientation = new Quaternion().rotateX(Math.PI / 6);
    const placement: XRMapPlacement = {...map, pose: {position: [0, 0.7, -2],
      orientation: [orientation[0], orientation[1], orientation[2], orientation[3]]}};
    const normal = [0, Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)];
    const origin: [number, number, number] = [0, 0.7 + normal[1], -2 + normal[2]];
    const pointer: XRSpatialRay = {origin, direction: [0, -normal[1], -normal[2]]};
    const grabber = new WebXRSurfaceGrabber();
    grabber.dispatchInteractionIntent(point('grab', pointer), {placement});
    const update = grabber.dispatchInteractionIntent(point('hover', {...pointer,
      origin: [0.25, origin[1], origin[2]]}), {placement});
    expect(update?.pose?.position?.[0]).toBeCloseTo(0.25, 7);
    expect(update?.pose?.position?.[1]).toBeCloseTo(0.7, 7);
    expect(update?.pose?.position?.[2]).toBeCloseTo(-2, 7);
    expect(update?.pose?.orientation).toEqual(placement.pose?.orientation);
  });

  test('rotates a globe so the initial picked location follows the pointer, keeping radius and center', () => {
    const context = {placement: globe};
    const initial = pickXRSurface({...context, pointer: globeRay()});
    const target = pickXRSurface({...context, pointer: globeRay(0.3)});
    if (!initial || !target) throw new Error('Expected sphere intersections');
    const grabber = new WebXRSurfaceGrabber();
    grabber.dispatchInteractionIntent(point('grab', globeRay()), context);
    const update = grabber.dispatchInteractionIntent(point('hover', globeRay(0.3)), context);
    if (!update || update.type !== 'globe') throw new Error('Expected globe rotation');
    const expected = createXRPlacementMatrix(globe).transform([...target.position, 1]);
    const actual = createXRPlacementMatrix(update).transform([...initial.position, 1]);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 7));
    expect(update.pose?.position).toEqual(globe.pose?.position);
    expect(update.radius).toBe(globe.radius);
    expect(update.rotation).toBe(globe.rotation);
    expect(Math.hypot(...update.pose!.orientation!)).toBeCloseTo(1, 7);
  });

  test('composes rotation with an existing non-identity room pose', () => {
    const placement: XRGlobePlacement = {...globe, pose: {...globe.pose,
      orientation: [0, Math.sin(0.3), 0, Math.cos(0.3)]}};
    const context = {placement, viewState: {longitude: -40, latitude: 20},
      placementMatrix: new Float64Array(createXRPlacementMatrix(placement, {longitude: -40, latitude: 20}))};
    const initial = pickXRSurface({...context, pointer: globeRay()});
    const target = pickXRSurface({...context, pointer: globeRay(0.2)});
    if (!initial || !target) throw new Error('Expected globe hits');
    const grabber = new WebXRSurfaceGrabber();
    grabber.dispatchInteractionIntent(point('grab', globeRay()), context);
    const update = grabber.dispatchInteractionIntent(point('hover', globeRay(0.2)), context);
    if (!update) throw new Error('Expected rotation');
    const actual = createXRPlacementMatrix(update, context.viewState).transform([...initial.position, 1]);
    const expected = new Matrix4().copy(context.placementMatrix).transform([...target.position, 1]);
    actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 7));
  });

  test('only the owning input and squeeze release can end the gesture', () => {
    const grabber = new WebXRSurfaceGrabber();
    const context = {placement: map};
    grabber.dispatchInteractionIntent(point('grab'), context);
    for (const action of ['grab', 'hover', 'release', 'cancel'] as const) {
      expect(grabber.dispatchInteractionIntent(point(action, mapRay(0.2), 'right:1'), context)).toBeNull();
      expect(grabber.isGrabbing()).toBe(true);
    }
    grabber.dispatchInteractionIntent(point('release', mapRay(), 'left:0', 'select'), context);
    expect(grabber.isGrabbing()).toBe(true);
    grabber.dispatchInteractionIntent(point('release', mapRay(), 'left:0', 'squeeze'), context);
    expect(grabber.isGrabbing()).toBe(false);
    grabber.dispatchInteractionIntent(point('grab', mapRay(), 'right:1'), context);
    expect(grabber.isGrabbing()).toBe(true);
    grabber.dispatchInteractionIntent(point('cancel', mapRay(), 'right:1'), context);
    expect(grabber.isGrabbing()).toBe(false);
  });

  test('missed sphere movement pauses rather than drops the grab; reset allows a new owner', () => {
    const grabber = new WebXRSurfaceGrabber();
    const context = {placement: globe};
    grabber.dispatchInteractionIntent(point('grab', globeRay()), context);
    expect(grabber.dispatchInteractionIntent(point('hover', globeRay(2)), context)).toBeNull();
    expect(grabber.isGrabbing()).toBe(true);
    expect(grabber.dispatchInteractionIntent(point('hover', globeRay(0.1)), context)).not.toBeNull();
    grabber.reset();
    expect(grabber.isGrabbing()).toBe(false);
    grabber.dispatchInteractionIntent(point('grab', globeRay(), 'right:1'), context);
    expect(grabber.isGrabbing()).toBe(true);
  });

  test.each([
    {origin: [0, 1.7, -2], direction: [1, 0, 0]},
    {origin: [0, 1.7, -2], direction: [0, 1, 0]},
    {origin: [NaN, 1.7, -2], direction: [0, -1, 0]},
    {origin: [0, 1.7, -2], direction: [0, 0, 0]},
    {origin: [0, 1.7, -2], direction: [0, -Infinity, 0]}
  ] satisfies XRSpatialRay[])('invalid or missed map movement does not corrupt gesture state: %j', pointer => {
    const grabber = new WebXRSurfaceGrabber();
    const context = {placement: map};
    grabber.dispatchInteractionIntent(point('grab'), context);
    expect(grabber.dispatchInteractionIntent(point('hover', pointer), context)).toBeNull();
    expect(grabber.dispatchInteractionIntent(point('hover', mapRay(0.1)), context)?.pose?.position?.[0]).toBeCloseTo(0.1, 7);
  });

  test('rejects acquisition outside finite bounds, screen pointers, and first-person ground', () => {
    const grabber = new WebXRSurfaceGrabber();
    const context = {placement: map};
    grabber.dispatchInteractionIntent(point('grab', mapRay(2)), context);
    grabber.dispatchInteractionIntent({type: 'point', action: 'grab', pointer: {x: 10, y: 10}}, context);
    const firstPerson: XRSurfaceGrabContext = {placement: {type: 'first-person', origin: [0, 0]}};
    grabber.dispatchInteractionIntent(point('grab', mapRay()), firstPerson);
    expect(grabber.isGrabbing()).toBe(false);
    expect(grabber.dispatchInteractionIntent({type: 'navigate', action: 'pan', delta: [1, 2]}, context)).toBeNull();
  });

  test.each([0, -1, NaN])('rejects invalid map scale %s even with a valid external matrix', scale => {
    const grabber = new WebXRSurfaceGrabber();
    grabber.dispatchInteractionIntent(point('grab'), {placement: {...map, metersPerXRUnit: scale},
      placementMatrix: createXRPlacementMatrix(map)});
    expect(grabber.isGrabbing()).toBe(false);
  });
});

describe('controller activation lifecycle', () => {
  /** luma.gl target rays point along local negative Z. */
  function snapshot(index = 0, handedness = 'left', squeezeActive = true, selectActive = false) {
    return {index, handedness, squeezeActive, selectActive,
      targetRayMatrix: new Matrix4().translate([0, 1.7, -2]).rotateX(-Math.PI / 2)};
  }

  test('emits explicit owner/button transitions without repeating a held grab', () => {
    const adapter = new WebXRInputAdapter();
    const points = adapter.update([snapshot()]).filter(intent => intent.type === 'point');
    expect(points.map(intent => intent.action)).toEqual(['hover', 'grab']);
    expect(points[1]).toMatchObject({inputId: 'left:0', button: 'squeeze'});
    expect(adapter.update([snapshot()]).filter(intent => intent.type === 'point').map(intent => intent.action)).toEqual(['hover']);
    expect(adapter.update([snapshot(0, 'left', true, true)]).find(intent => intent.type === 'point' && intent.action === 'select'))
      .toMatchObject({inputId: 'left:0', button: 'select'});
    expect(adapter.update([snapshot()]).find(intent => intent.type === 'point' && intent.action === 'release'))
      .toMatchObject({inputId: 'left:0', button: 'select'});
    expect(adapter.update([snapshot(0, 'left', false)]).find(intent => intent.type === 'point' && intent.action === 'release'))
      .toMatchObject({inputId: 'left:0', button: 'squeeze'});
  });

  test('disconnect cancels the active controller once and frees the grab owner', () => {
    const adapter = new WebXRInputAdapter();
    const grabber = new WebXRSurfaceGrabber();
    const context = {placement: map};
    for (const intent of adapter.update([snapshot()])) grabber.dispatchInteractionIntent(intent, context);
    expect(grabber.isGrabbing()).toBe(true);
    const intents = adapter.update([]);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({type: 'point', action: 'cancel', inputId: 'left:0'});
    for (const intent of intents) grabber.dispatchInteractionIntent(intent, context);
    expect(grabber.isGrabbing()).toBe(false);
    expect(adapter.update([])).toEqual([]);
  });

  test.each([null, Array(16).fill(NaN)])('loss of tracking cancels, and holding squeeze does not silently restart: %j', targetRayMatrix => {
    const adapter = new WebXRInputAdapter();
    adapter.update([snapshot()]);
    const missing = {...snapshot(), targetRayMatrix};
    expect(adapter.update([missing])).toContainEqual(expect.objectContaining({action: 'cancel', inputId: 'left:0'}));
    expect(adapter.update([missing]).filter(intent => intent.type === 'point')).toEqual([]);
    expect(adapter.update([snapshot()]).filter(intent => intent.type === 'point').map(intent => intent.action)).toEqual(['hover']);
    adapter.update([snapshot(0, 'left', false)]);
    expect(adapter.update([snapshot()])).toContainEqual(expect.objectContaining({action: 'grab'}));
    adapter.reset();
    expect(adapter.update([])).toEqual([]);
  });
});
