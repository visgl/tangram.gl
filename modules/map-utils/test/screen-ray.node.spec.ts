// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {containsScreenPixel, unprojectScreenSegment} from '@tangram.gl/map-utils/screen-ray';

const viewport = {x: 50, y: 100, width: 200, height: 100};
const identity = {transform: (point: readonly number[]) => point};

test('owns only the half-open eye rectangle', () => {
  expect(containsScreenPixel(viewport, [50, 100])).toBe(true);
  expect(containsScreenPixel(viewport, [250, 100])).toBe(false);
  expect(containsScreenPixel(viewport, [50, 200])).toBe(false);
  expect(containsScreenPixel(viewport, [49, 100])).toBe(false);
  expect(containsScreenPixel(viewport, [50, 99])).toBe(false);
  expect(containsScreenPixel(viewport, [NaN, 120])).toBe(false);
  expect(containsScreenPixel({...viewport, width: 0}, [50, 100])).toBe(false);
  expect(containsScreenPixel({...viewport, height: Infinity}, [50, 100])).toBe(false);
});

test('unprojects top-origin coordinates without imposing a viewport clipping policy', () => {
  expect(unprojectScreenSegment(identity, viewport, [50, 100])).toEqual({
    origin: [-1, 1, -1], direction: [0, 0, 2]
  });
  expect(unprojectScreenSegment(identity, {width: 2, height: 2}, [3, 1])).toEqual({
    origin: [2, 0, -1], direction: [0, 0, 2]
  });
});

test('divides each homogeneous endpoint before computing the displacement', () => {
  const inverse = {transform: ([x, y, z]: readonly number[]) =>
    Float64Array.of(x + 4, y + 8, z + 6, z + 3)};
  expect(unprojectScreenSegment(inverse, viewport, [150, 150])).toEqual({
    origin: [2, 4, 2.5], direction: [-1, -2, -0.75]
  });
});

test.each([[0, 0, 0, 0], [0, Infinity, 0, 1], [0, 0, 0], [1, 1, 1, Number.MIN_VALUE]])(
  'rejects unusable homogeneous endpoints (%s, %s, %s, %s)',
  (...point) => {
    expect(unprojectScreenSegment({transform: () => point}, viewport, [50, 100])).toBeNull();
  }
);
