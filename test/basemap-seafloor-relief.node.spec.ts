// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {
  RAMP_OPTIONS,
  createSeafloorStyle,
  getColorReliefColor
} from '../examples/layers/basemap-seafloor-relief/style';

describe('seafloor relief example style', () => {
  test('draws color relief and hillshade from one terrarium raster-dem source', () => {
    const style = createSeafloorStyle('ocean-land', true);
    expect(style.sources.dem).toMatchObject({type: 'raster-dem', encoding: 'terrarium'});
    expect(style.layers.map(layer => [layer.type, 'source' in layer ? layer.source : null])).toEqual(
      [
        ['background', null],
        ['color-relief', 'dem'],
        ['hillshade', 'dem']
      ]
    );
  });

  test('leaves out the hillshade layer when it is off', () => {
    const style = createSeafloorStyle('ocean-land', false);
    expect(style.layers.map(layer => layer.type)).toEqual(['background', 'color-relief']);
  });

  test.each(RAMP_OPTIONS.map(option => option.value))(
    '%s is an interpolate ramp that changes from sea to land at 0 m',
    ramp => {
      const [kind, interpolation, input, ...stops] = getColorReliefColor(ramp);
      expect([kind, interpolation, input]).toEqual(['interpolate', ['linear'], ['elevation']]);
      const elevations = stops.filter((_, index) => index % 2 === 0) as number[];
      // `interpolate` needs strictly increasing stops.
      for (let index = 1; index < elevations.length; index++) {
        expect(elevations[index]).toBeGreaterThan(elevations[index - 1]);
      }
      // The coast: the last sea stop is 1 m below the first land stop at 0 m.
      const coast = elevations.indexOf(0);
      expect(coast).toBeGreaterThan(0);
      expect(elevations[coast - 1]).toBe(-1);
      expect(stops[2 * coast + 1]).not.toBe(stops[2 * coast - 1]);
    }
  );
});
