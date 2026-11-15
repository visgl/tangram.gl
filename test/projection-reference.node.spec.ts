// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {projectionEngine} from '@math.gl/geospatial/projection';
import {
  CLARKE_1866,
  CONUS_ALBERS_PROJ,
  createWorldTransverseMercatorCRS,
  projectAlbers,
  projectConusAlbers,
  projectTransverseMercator,
  projectUtm32N,
  unprojectTransverseMercator
} from './projection-reference';

describe('test projection reference', () => {
  test('Albers matches the worked example of Snyder (1987), page 292', () => {
    const [x, y] = projectAlbers([-75, 35], {
      ellipsoid: CLARKE_1866,
      latitudeOfOrigin: 23,
      centralMeridian: -96,
      standardParallels: [29.5, 45.5]
    });
    expect(x).toBeCloseTo(1885472.7, 0);
    expect(y).toBeCloseTo(1535925.0, 0);
  });

  test('Transverse Mercator matches the worked example of Snyder (1987), page 269', () => {
    // Clarke 1866, origin on the equator at 75 degrees west, scale factor 0.9996.
    const [x, y] = projectTransverseMercator([-73.5, 40.5], {
      ellipsoid: CLARKE_1866,
      centralMeridian: -75,
      falseEasting: 0
    });
    expect(x).toBeCloseTo(127106.5, 0);
    expect(y).toBeCloseTo(4484124.4, 0);
  });

  test('the inverse of Transverse Mercator returns each position, also far from the meridian', () => {
    for (const point of [[9, 48], [10.5, 48], [-30, 20], [60, -70], [80, 5], [120, 60], [-150, -40]]) {
      const projected = projectTransverseMercator(point, {centralMeridian: 9});
      const back = unprojectTransverseMercator(projected, {centralMeridian: 9});
      // The series loses digits far from the central meridian.
      expect(back[0]).toBeCloseTo(point[0], 4);
      expect(back[1]).toBeCloseTo(point[1], 4);
    }
    // The projection has no number for the equator a quarter turn from the central meridian.
    expect(Math.abs(projectTransverseMercator([99, 0], {centralMeridian: 9})[0])).toBeGreaterThan(1e8);
    const crs = createWorldTransverseMercatorCRS(9).converter.WGS84;
    expect(crs.to(crs.from([10.5, 48, 5]))[0]).toBeCloseTo(10.5, 6);
    expect(crs.from([10.5, 48, 5])[2]).toBe(5);
    const output = [0, 0, 0];
    expect(crs.normalize([400, 95, 1], output)).toBe(output);
    expect(output).toEqual([400, 95, 1]);
  });

  test('math.gl projects as the reference does, to a millimeter', async () => {
    const cases = [
      {crs: 'EPSG:32632', project: projectUtm32N, points: [[9, 48], [10.5, 48], [6.2, 2], [11.9, 83]]},
      {crs: CONUS_ALBERS_PROJ, project: projectConusAlbers, points: [[-96, 23], [-80, 40], [-120, 48], [-70, 25]]}
    ];
    for (const {crs, project, points} of cases) {
      const converter = (await projectionEngine.getCRS(crs)).converter.WGS84;
      for (const point of points) {
        const expected = project(point);
        const actual = converter.from(converter.normalize([...point, 0]));
        expect(actual[0]).toBeCloseTo(expected[0], 3);
        expect(actual[1]).toBeCloseTo(expected[1], 3);
      }
    }
  });
});
