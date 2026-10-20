// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Map as MapLibreMap, setWorkerUrl} from 'maplibre-gl';
import {_GlobeViewport as GlobeViewport} from '@deck.gl/core';
import {createComparisonStyle} from '../../examples/deck/comparison-style';

test('globe geographic landmarks align with the MapLibre perspective camera', async () => {
  const container = document.createElement('div');
  container.style.cssText = 'width:512px;height:320px';
  document.body.append(container);
  setWorkerUrl(new URL('../../examples/dist/maplibre-worker.js', import.meta.url).href);
  const map = new MapLibreMap({container, style: {version: 8,
    projection: createComparisonStyle('streetsVector', 'globe').projection, sources: {}, layers: []},
    center: [0, 40], zoom: 3, attributionControl: false});
  try {
    await new Promise<void>(resolve => map.once('load', () => resolve()));
    for (const [width, height] of [[512, 320], [320, 512]]) {
      container.style.width = `${width}px`; container.style.height = `${height}px`; map.resize();
      for (const latitude of [-60, 0, 40, 80]) {
        for (const zoom of [1, 3, 11, 11.5, 12, 14]) {
          const bearing = 30;
          map.jumpTo({center: [0, latitude], zoom, bearing});
          expect(map.getZoom()).toBeCloseTo(zoom, 6);
          const viewport = new GlobeViewport({width, height, longitude: 0, latitude, zoom, bearing});
          const offset = zoom > 10 ? 0.001 : 2;
          for (const point of [[0, latitude], [offset, latitude], [-offset, latitude - offset], [0, latitude + offset]]) {
            const reference = map.project([point[0], point[1]]);
            const actual = viewport.project(point);
            expect(actual[0]).toBeCloseTo(reference.x, 3);
            expect(actual[1]).toBeCloseTo(reference.y, 3);
          }
        }
      }
    }
  } finally {map.remove(); container.remove();}
});
