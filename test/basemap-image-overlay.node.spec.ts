// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {
  CHART_CORNERS,
  SKEW_OFFSET,
  getChartCorners,
  getChartStyle
} from '../examples/layers/basemap-image-overlay/chart';
import {
  getImageWarp,
  isDrawableImageSource
} from '../modules/basemap-layers/src/image-source-layer';

// The corners and the style of the image overlay example, checked against the image source code
// of `BasemapLayer`.

describe('image overlay example', () => {
  test('draws the chart as an image source', () => {
    for (const skew of [false, true]) {
      const style = getChartStyle({opacity: 0.5, skew});
      expect(isDrawableImageSource(style.sources.chart)).toBe(true);
      expect(style.layers[0]).toMatchObject({type: 'raster', source: 'chart'});
      expect(style.layers[0].paint['raster-opacity']).toBe(0.5);
    }
  });

  test('without skew, the corners make a rectangle that is not warped', () => {
    expect(getChartCorners(false)).toEqual(CHART_CORNERS);
    expect(getImageWarp(getChartCorners(false))).toEqual([0, 0, 1]);
  });

  test('skew moves the bottom right corner only, and warps the image as a perspective view', () => {
    const corners = getChartCorners(true);
    expect(corners[0]).toEqual(CHART_CORNERS[0]);
    expect(corners[1]).toEqual(CHART_CORNERS[1]);
    expect(corners[3]).toEqual(CHART_CORNERS[3]);
    expect(corners[2]).toEqual([
      CHART_CORNERS[2][0] + SKEW_OFFSET[0],
      CHART_CORNERS[2][1] + SKEW_OFFSET[1]
    ]);
    const [perspectiveX, perspectiveY, blend] = getImageWarp(corners);
    expect(Math.hypot(perspectiveX, perspectiveY)).toBeGreaterThan(0);
    expect(blend).toBeLessThan(1);
  });
});
