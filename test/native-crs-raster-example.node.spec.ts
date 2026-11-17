// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';

import {
  formatGridValue,
  getGridLines,
  getGridStep,
  getMajorGridStep,
  intersectBounds,
  snapBoundsOut
} from '../examples/layers/basemap-native-crs-raster/grid';
import {
  containsBounds,
  getRasterWindow,
  selectRasterLevel,
  toRGBA,
  type RasterLevel
} from '../examples/layers/basemap-native-crs-raster/raster-window';
import {getStatusText, type StatusState} from '../examples/layers/basemap-native-crs-raster/status';

/** The levels of a 10980 pixel raster of 10 m pixels, as a Sentinel-2 image has them. */
const LEVELS: RasterLevel[] = [
  {index: 0, width: 10980, height: 10980, resolution: 10},
  {index: 1, width: 5490, height: 5490, resolution: 20},
  {index: 2, width: 2745, height: 2745, resolution: 40},
  {index: 3, width: 1373, height: 1373, resolution: 109800 / 1373}
];
const RASTER_BOUNDS: [number, number, number, number] = [300000, 6690240, 409800, 6800040];

describe('native CRS raster example: projected grid', () => {
  test('the grid step is 1, 2 or 5 times a power of ten near the target size', () => {
    expect(getGridStep(1, 120)).toBe(100);
    expect(getGridStep(1.5, 120)).toBe(200);
    expect(getGridStep(2.5, 120)).toBe(200);
    expect(getGridStep(4, 120)).toBe(500);
    expect(getGridStep(8, 120)).toBe(1000);
    expect(getGridStep(142, 120)).toBe(20000);
  });

  test('the major step is the next power of ten', () => {
    expect(getMajorGridStep(1000)).toBe(10000);
    expect(getMajorGridStep(2000)).toBe(10000);
    expect(getMajorGridStep(5000)).toBe(10000);
  });

  test('lines are on multiples of the step, in the bounds, with major lines marked', () => {
    const lines = getGridLines([295000, 6690000, 325000, 6705000], 5000, 4);
    const eastings = lines.filter(line => line.axis === 'x');
    const northings = lines.filter(line => line.axis === 'y');
    expect(eastings.map(line => line.value)).toEqual([
      295000, 300000, 305000, 310000, 315000, 320000, 325000
    ]);
    expect(northings.map(line => line.value)).toEqual([6690000, 6695000, 6700000, 6705000]);
    expect(eastings.filter(line => line.major).map(line => line.value)).toEqual([
      300000, 310000, 320000
    ]);
    // A line of constant x keeps its x, and goes from the south edge to the north edge.
    expect(eastings[1].path).toHaveLength(5);
    expect(eastings[1].path[0]).toEqual([300000, 6690000]);
    expect(eastings[1].path[4]).toEqual([300000, 6705000]);
    expect(northings[0].path[0]).toEqual([295000, 6690000]);
    expect(northings[0].path[4]).toEqual([325000, 6690000]);
  });

  test('bounds snap out to the cell, and intersect', () => {
    expect(snapBoundsOut([1001, -2999, 3999, -1001], 1000)).toEqual([1000, -3000, 4000, -1000]);
    expect(intersectBounds([0, 0, 10, 10], [5, 5, 20, 20])).toEqual([5, 5, 10, 10]);
    expect(intersectBounds([0, 0, 10, 10], [10, 0, 20, 10])).toBeNull();
  });

  test('coordinates have digit groups and a true minus sign', () => {
    expect(formatGridValue(6750000)).toBe('6 750 000');
    expect(formatGridValue(-1300000.4)).toBe('−1 300 000');
    expect(formatGridValue(980)).toBe('980');
  });
});

describe('native CRS raster example: raster windows', () => {
  test('the level is the coarsest that the screen can show in full', () => {
    expect(selectRasterLevel(LEVELS, 200).index).toBe(3);
    expect(selectRasterLevel(LEVELS, 30).index).toBe(2);
    expect(selectRasterLevel(LEVELS, 14).index).toBe(1);
    expect(selectRasterLevel(LEVELS, 10).index).toBe(0);
    // A view closer than the raster gets the full image.
    expect(selectRasterLevel(LEVELS, 0.5).index).toBe(0);
  });

  test('a window is on pixel edges and covers the requested bounds', () => {
    const window = getRasterWindow(RASTER_BOUNDS, LEVELS[0], [350003, 6740007, 350995, 6740498]);
    expect(window).toEqual({bounds: [350000, 6740000, 351000, 6740500], width: 100, height: 50});
  });

  test('a window stops at the edge of the raster', () => {
    const window = getRasterWindow(RASTER_BOUNDS, LEVELS[1], [290000, 6799000, 300100, 6900000]);
    expect(window).toEqual({bounds: [300000, 6799000, 300100, 6800040], width: 5, height: 52});
    const corner = getRasterWindow(RASTER_BOUNDS, LEVELS[0], [409700, 6690000, 420000, 6690300]);
    expect(corner).toEqual({bounds: [409700, 6690240, 409800, 6690300], width: 10, height: 6});
    expect(getRasterWindow(RASTER_BOUNDS, LEVELS[0], [0, 0, 100, 100])).toBeNull();
  });

  test('the window of the whole raster is the whole level', () => {
    const window = getRasterWindow(RASTER_BOUNDS, LEVELS[3], RASTER_BOUNDS);
    expect(window?.width).toBe(1373);
    expect(window?.height).toBe(1373);
    expect(containsBounds(window?.bounds || [0, 0, 0, 0], RASTER_BOUNDS)).toBe(true);
  });

  test('RGB samples become opaque pixels, and no-data pixels are transparent', () => {
    const rgba = toRGBA(new Uint8Array([10, 20, 30, 0, 0, 0, 0, 0, 5]), 3, 0);
    expect([...rgba]).toEqual([10, 20, 30, 255, 0, 0, 0, 0, 0, 0, 5, 255]);
  });

  test('gray samples take the color ramp', () => {
    const rgba = toRGBA(new Uint8Array([255, 0, 51]), 1, 0, [
      [0, 50, 100],
      [250, 250, 250]
    ]);
    expect([...rgba]).toEqual([250, 250, 250, 255, 0, 0, 0, 0, 50, 90, 130, 255]);
  });
});

describe('native CRS raster example: status line', () => {
  const LOADED: StatusState = {
    styleError: null,
    rasterErrors: [undefined, undefined],
    imagery: true,
    finest: 10.4,
    pendingReads: 0
  };

  test('shows the pixel size of the raster, and the reads in progress', () => {
    expect(getStatusText(LOADED)).toBe('Raster: 10 m pixels');
    expect(getStatusText({...LOADED, finest: Infinity, pendingReads: 2})).toBe('Raster · loading…');
  });

  test('keeps a raster error above the pixel size, which a later render changes', () => {
    const failed = {...LOADED, rasterErrors: [undefined, 'The raster did not load: 404']};
    expect(getStatusText(failed)).toBe('The raster did not load: 404\nRaster: 10 m pixels');
    expect(getStatusText({...failed, finest: 20, pendingReads: 1})).toBe(
      'The raster did not load: 404\nRaster: 20 m pixels · loading…'
    );
  });

  test('keeps a style error, also without the raster', () => {
    const failed = {...LOADED, styleError: 'The basemap style did not load: 503'};
    expect(getStatusText(failed)).toBe('The basemap style did not load: 503\nRaster: 10 m pixels');
    expect(
      getStatusText({...failed, imagery: false, rasterErrors: ['The raster did not load: 404']})
    ).toBe('The basemap style did not load: 503');
  });
});
