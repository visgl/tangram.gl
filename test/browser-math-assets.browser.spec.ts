// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import coreSource from '../examples/browser-dependencies/dist/core.js?raw';
import cullingSource from '../examples/browser-dependencies/dist/culling.js?raw';
import spheroidSource from '../examples/browser-dependencies/dist/spheroid.js?raw';
import projectionSource from '../examples/browser-dependencies/dist/projection-core.js?raw';
import equalEarthSource from '../examples/browser-dependencies/dist/eqearth.js?raw';
import albersSource from '../examples/browser-dependencies/dist/aea.js?raw';
import cylindricalSource from '../examples/browser-dependencies/dist/eqc.js?raw';
import mercatorSource from '../examples/browser-dependencies/dist/merc.js?raw';

test('emitted browser math runs without a CDN and shares the same core classes', async () => {
  const urls: string[] = [];
  /** Load emitted bytes without Vite rewriting their package imports. */
  async function loadAsset<Module>(source: string): Promise<Module> {
    const url = URL.createObjectURL(new Blob([source], {type: 'text/javascript'}));
    urls.push(url);
    return import(/* @vite-ignore */ url);
  }
  try {
    const core = await loadAsset<typeof import('@math.gl/core')>(coreSource);
    const coreUrl = urls[0];
    /** Substitute the import map's one shared core URL in the isolated blob graph. */
    const mapCore = (source: string) => source.replaceAll('"@math.gl/core"', JSON.stringify(coreUrl));
    const culling = await loadAsset<typeof import('@math.gl/culling')>(mapCore(cullingSource));
    const spheroid = await loadAsset<typeof import('@math.gl/core/spheroid')>(mapCore(spheroidSource));
    const projection = await loadAsset<typeof import('@math.gl/projection/core')>(mapCore(projectionSource));
    const equalEarth = await loadAsset<typeof import('@math.gl/projection/projections/eqearth')>(mapCore(equalEarthSource));
    const albers = await loadAsset<typeof import('@math.gl/projection/projections/aea')>(mapCore(albersSource));
    const cylindrical = await loadAsset<typeof import('@math.gl/projection/projections/eqc')>(mapCore(cylindricalSource));
    const mercator = await loadAsset<typeof import('@math.gl/projection/projections/merc')>(mapCore(mercatorSource));
    expect(new culling.Ray().origin).toBeInstanceOf(core.Vector3);
    expect(new core.Matrix4().transformAsPoint([1, 2, 3])).toEqual([1, 2, 3]);
    const point = {x: 0, y: 0, z: 0};
    expect(spheroid.spheroidToCartesian(point, {semiMajorAxis: 1, semiMinorAxis: 1, eccentricitySquared: 0})).toBe(true);
    expect(point).toEqual({x: 1, y: 0, z: 0});
    const engine = projection.createProjectionEngine({projections: [equalEarth.equalEarth, albers.albersEqualArea, cylindrical.equidistantCylindrical, mercator.mercator]});
    for (const definition of ['+proj=eqearth', '+proj=aea +lat_1=29.5 +lat_2=45.5', '+proj=eqc', '+proj=merc']) {
      const transform = engine.createProjection({from: '+proj=longlat +R=6378137', to: `${definition} +R=6378137 +units=m`});
      const projected = transform.projectSync([-100, 40]);
      expect(projected.every(Number.isFinite)).toBe(true);
      const unprojected = transform.unprojectSync(projected);
      expect(unprojected[0]).toBeCloseTo(-100, 8);
      expect(unprojected[1]).toBeCloseTo(40, 8);
    }
  } finally {
    urls.forEach(url => URL.revokeObjectURL(url));
  }
});
