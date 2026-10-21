// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Map as MapLibreMap, LngLat, setWorkerUrl} from 'maplibre-gl';
import {WebMercatorViewport} from '@deck.gl/core';
import {createComparisonCameraOptions} from '../../examples/deck/comparison-camera';

test('Mercator reference preserves the shared low-zoom camera across latitude and viewport shape', async () => {
  const container = document.createElement('div'); container.style.cssText = 'width:320px;height:512px'; document.body.append(container);
  setWorkerUrl(new URL('../../examples/dist/maplibre-worker.js', import.meta.url).href);
  const initial = {longitude: 10, latitude: 80, zoom: 0, bearing: 0, pitch: 0};
  const map = new MapLibreMap({container, style: {version: 8, sources: {}, layers: []}, attributionControl: false,
    ...createComparisonCameraOptions(initial, 'mapPerspective', (longitude, latitude) => new LngLat(longitude, latitude))});
  try {
    await new Promise<void>(resolve => map.once('load', () => resolve()));
    expect(map.getCenter().lat).toBeCloseTo(initial.latitude, 8);
    expect(map.getZoom()).toBeCloseTo(initial.zoom, 8);
    for (const [width, height] of [[320, 512], [512, 320]]) {
      container.style.width = `${width}px`; container.style.height = `${height}px`; map.resize();
      for (const latitude of [-80, 0, 40, 80]) {
        for (const zoom of [0, 0.5, 3, 15]) {
          for (const pitch of [0, 35, 50]) {
            const camera = {longitude: 10, latitude, zoom, bearing: 30, pitch};
            map.jumpTo({center: [camera.longitude, latitude], zoom, bearing: camera.bearing, pitch});
            expect(map.getZoom()).toBeCloseTo(zoom, 8);
            expect(map.getCenter().lat).toBeCloseTo(latitude, 8);
            const viewport = new WebMercatorViewport({width, height, ...camera});
            const offset = zoom > 10 ? 0.001 : 1;
            for (const [longitude, pointLatitude] of [[10, latitude], [10 + offset, latitude], [10, latitude - offset]]) {
              const reference = map.project([longitude, pointLatitude]);
              const actual = viewport.project([longitude, pointLatitude]);
              expect(actual[0]).toBeCloseTo(reference.x, 3);
              expect(actual[1]).toBeCloseTo(reference.y, 3);
            }
          }
        }
      }
    }
  } finally {map.remove(); container.remove();}
});
