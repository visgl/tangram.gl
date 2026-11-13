// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Deck, OrbitView} from '@deck.gl/core';
import {PolygonLayer} from '@deck.gl/layers';
import {Matrix4} from '@math.gl/core';
import {pickTerrainSurface} from '../../modules/basemap-layers/src/terrain-query';
import {createFixtureTerrain} from '../../examples/layers/terrain-contract/terrain-fixture';
import {RenderingHarness, DEVICE_TYPE} from './harness';

test(`${DEVICE_TYPE}: rendered OrbitView and terrain queries agree across relief changes`, async () => {
  const harness = new RenderingHarness();
  await harness.initializeDevice();
  let rendered = 0;
  const deck = new Deck({
    canvas: harness.canvas,
    device: harness.device,
    useDevicePixels: false,
    width: 600,
    height: 400,
    views: new OrbitView({id: 'terrain-camera', orbitAxis: 'Z'}),
    initialViewState: {target: [1000, 1000, 60], rotationX: 40, rotationOrbit: -25, zoom: -2},
    onAfterRender: () => {
      rendered++;
    }
  });
  try {
    for (const exaggeration of [4, 0, 10]) {
      const terrain = createFixtureTerrain(exaggeration),
        before = rendered;
      deck.setProps({
        layers: [
          new PolygonLayer({
            id: 'terrain-camera-mesh',
            data: terrain.polygons,
            coordinateSystem: 'cartesian',
            getPolygon: item => item.polygon,
            getFillColor: [65, 155, 105],
            stroked: false,
            pickable: true
          })
        ]
      });
      await expect.poll(() => rendered, {timeout: 15000}).toBeGreaterThan(before);
      const viewport = deck.getViewports()[0];
      for (const [horizontal, vertical, elevation, triangleIndex] of [
        [500, 500, 17.5, 0],
        [1500, 1500, 12.5, 1]
      ]) {
        const displayed = [horizontal, vertical, elevation * exaggeration];
        const pixel = viewport.project(displayed);
        // deck.gl's synchronous GPU picking currently requires WebGL readback.
        // WebGPU still exercises the rendered viewport and CPU ray agreement below.
        if (DEVICE_TYPE === 'webgl') {
          expect(deck.pickObject({x: pixel[0], y: pixel[1], radius: 1})?.layer?.id).toBe(
            'terrain-camera-mesh'
          );
        }
        const hit = pickTerrainSurface(
          viewport,
          [pixel[0], pixel[1]],
          terrain.surface,
          new Matrix4()
        );
        expect(hit?.triangleIndex).toBe(triangleIndex);
        expect(hit?.coordinate[2]).toBeCloseTo(elevation, 5);
        displayed.forEach((value, axis) => expect(hit?.position[axis]).toBeCloseTo(value, 4));
      }
    }
  } finally {
    deck.finalize();
    harness.destroy();
  }
}, 60000);
