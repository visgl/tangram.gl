// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {containsScreenPixel} from '@tangram.gl/map-utils/screen-ray';

const viewport = {x: 50, y: 100, width: 200, height: 100};

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
