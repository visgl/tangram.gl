// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {intersectContentSurface, longitudeLatitudeToMeters} from '../src/experimental/webxr/projection';
import type {XRPlacement, XRSpatialRay, XRVector3} from '../src/experimental/webxr/types';

const GLOBE_RADIUS = 256;
const GLOBE: XRPlacement = {type: 'globe', anchor: [0, 0], radius: 1};
const MAP: XRPlacement = {type: 'map', anchor: [0, 0], metersPerXRUnit: 1000};

/** Captured pre-migration sphere formula; used only with unit directions. */
function intersectLegacySphere(ray: XRSpatialRay): XRVector3 | null {
  const origin = ray.origin;
  const direction = ray.direction;
  const originDotDirection = origin.reduce((sum, value, index) => sum + value * direction[index], 0);
  const discriminant = originDotDirection ** 2 -
    (origin.reduce((sum, value) => sum + value ** 2, 0) - GLOBE_RADIUS ** 2);
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = -originDotDirection - root;
  const far = -originDotDirection + root;
  const distance = near >= 0 ? near : far >= 0 ? far : null;
  return distance === null ? null : [
    origin[0] + direction[0] * distance,
    origin[1] + direction[1] * distance,
    origin[2] + direction[2] * distance
  ];
}

/** Captured Tangram ground tolerance and forward-ray rule, independent of math.gl. */
function intersectLegacyGround(ray: XRSpatialRay): XRVector3 | null {
  if (Math.abs(ray.direction[2]) < 1e-8) return null;
  const distance = -ray.origin[2] / ray.direction[2];
  return distance >= 0 ? [ray.origin[0] + ray.direction[0] * distance,
    ray.origin[1] + ray.direction[1] * distance, 0] : null;
}

describe('math.gl WebXR surface conformance in the renderer browser runtime', () => {
  test.each([
    {origin: [0, -512, 0], direction: [0, 1, 0]},
    {origin: [0, 512, 0], direction: [0, -1, 0]},
    {origin: [0, 0, 512], direction: [0, 0, -1]},
    {origin: [512, 0, 0], direction: [-1, 0, 0]},
    {origin: [256, -512, 0], direction: [0, 1, 0]},
    {origin: [257, -512, 0], direction: [0, 1, 0]},
    {origin: [0, -512, 0], direction: [0, -1, 0]},
    {origin: [0, 0, 0], direction: [0, 1, 0]},
    {origin: [0, 128, 0], direction: [0, -1, 0]},
    {origin: [0, -256, 0], direction: [0, -1, 0]},
    {origin: [0, -256, 0], direction: [0, 1, 0]},
    {origin: [100, -512, 200], direction: [0, 1, 0]},
    {origin: [0, -300, 0], direction: [0.6, 0.8, 0]},
    {origin: [-300, -200, -100], direction: [1 / 3, 2 / 3, 2 / 3]},
    {origin: [100, 20, 50], direction: [-2 / 3, 1 / 3, 2 / 3]}
  ] satisfies XRSpatialRay[])('preserves near/exit/tangent/miss globe hits: %j', ray => {
    const before = structuredClone(ray);
    const expected = intersectLegacySphere(ray);
    const hit = intersectContentSurface(ray, GLOBE);
    if (expected) {
      expect(hit?.position).toEqual(expected.map(value => expect.closeTo(value, 8)));
      expect(Math.hypot(...hit!.position)).toBeCloseTo(GLOBE_RADIUS, 8);
      expect(hit?.coordinate[2]).toBe(0);
    } else {
      expect(hit).toBeNull();
    }
    expect(ray).toEqual(before);
  });

  test.each([
    {origin: [10, 20, 100], direction: [0, 0, -1]},
    {origin: [10, 20, -100], direction: [0, 0, 1]},
    {origin: [10, 20, 100], direction: [0, 0, 1]},
    {origin: [10, 20, 0], direction: [0, 0, 1]},
    {origin: [10, 20, 100], direction: [1, 0, 0]},
    {origin: [10, 20, 100], direction: [1, 0, -0.999e-8]},
    {origin: [10, 20, 100], direction: [1, 0, -1e-8]},
    {origin: [10, 20, 100], direction: [0, 1, -2]},
    {origin: [10, 20, 100], direction: [1, 0, -2]}
  ] satisfies XRSpatialRay[])('preserves +Z ground axes and the legacy parallel tolerance: %j', ray => {
    const before = structuredClone(ray);
    const expected = intersectLegacyGround(ray);
    const hit = intersectContentSurface(ray, MAP);
    expect(hit?.position ?? null).toEqual(expected);
    expect(ray).toEqual(before);
  });

  test.each([0.25, 1, 5])('keeps globe hit positions independent of direction length %s', scale => {
    for (const origin of [[0, -512, 0], [0, 0, 0], [128, -100, 0]] satisfies XRVector3[]) {
      const unit = intersectContentSurface({origin, direction: [0, 1, 0]}, GLOBE);
      const scaled = intersectContentSurface({origin, direction: [0, scale, 0]}, GLOBE);
      expect(scaled?.position).toEqual(unit?.position.map(value => expect.closeTo(value, 8)));
      expect(scaled?.coordinate).toEqual(unit?.coordinate.map(value => expect.closeTo(value, 8)));
    }
  });

  test.each([0, 65, 80])('keeps strict physical tabletop edges at latitude %s', latitude => {
    const placement: XRPlacement = {...MAP, type: 'map', anchor: [0, latitude],
      surface: {type: 'bounded', width: 2, height: 1}};
    const center = longitudeLatitudeToMeters(0, latitude);
    const latitudeScale = Math.cos(latitude * Math.PI / 180);
    for (const [east, north, inside] of [[1, 0, true], [0, 0.5, true],
      [1.000001, 0, false], [0, 0.500001, false]] as const) {
      const ray: XRSpatialRay = {origin: [center[0] + east * 1000 / latitudeScale,
        center[1] + north * 1000 / latitudeScale, 10], direction: [0, 0, -1]};
      const hit = intersectContentSurface(ray, placement);
      expect(Boolean(hit)).toBe(inside);
      expect(intersectContentSurface(ray, {...placement, surface: {type: 'unbounded'}})).not.toBeNull();
    }
  });

  test.each([
    {origin: [0, 0, 0], direction: [0, 0, 0]},
    {origin: [Infinity, 0, 0], direction: [0, 1, 0]},
    {origin: [0, NaN, 0], direction: [0, 1, 0]},
    {origin: [0, 0, 0], direction: [0, NaN, 1]}
  ] satisfies XRSpatialRay[])('rejects invalid content rays instead of producing a surface hit: %j', ray => {
    expect(intersectContentSurface(ray, MAP)).toBeNull();
    expect(intersectContentSurface(ray, GLOBE)).toBeNull();
  });
});
