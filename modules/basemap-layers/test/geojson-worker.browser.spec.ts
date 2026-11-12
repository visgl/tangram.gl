// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {getGeoJsonTileFeatures, setGeoJsonWorkerEnabled} from '../src/geojson-source';
import type {GeoJsonWorkerRequest} from '../src/geojson-worker';

const VERTICES_PER_POLYGON = 48;
const POSITIONS_PER_POLYGON = VERTICES_PER_POLYGON + 1;
const POSITIONS_PER_BATCH = 100_000;

/** Polygons of `vertices` points each, scattered over Europe from a fixed seed. */
function makePolygons(count: number, vertices: number) {
  let seed = 1;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const features = new Array(count);
  for (let i = 0; i < count; i++) {
    const lng = -10 + random() * 40;
    const lat = 35 + random() * 25;
    const radius = 0.02 + random() * 0.08;
    const ring: number[][] = [];
    for (let v = 0; v < vertices; v++) {
      const angle = (v / vertices) * 2 * Math.PI;
      const r = radius * (0.7 + 0.3 * random());
      ring.push([lng + r * Math.cos(angle), lat + r * Math.sin(angle)]);
    }
    ring.push(ring[0]);
    features[i] = {
      type: 'Feature',
      properties: {id: i, name: `polygon ${i}`},
      geometry: {type: 'Polygon', coordinates: [ring]}
    };
  }
  return {type: 'FeatureCollection', features};
}

/** Tiles over Europe, at zoom 3, and at zoom 5 and 9, which the index cuts down to. */
const TILES = [
  {x: 4, y: 2, z: 3},
  {x: 16, y: 10, z: 5},
  {x: 266, y: 175, z: 9}
];

test('batches a large GeoJSON source before indexing it once in the worker', async () => {
  // Cross two batch boundaries without relying on elapsed time or CPU contention.
  const data = makePolygons(4_500, VERTICES_PER_POLYGON);
  const requestTiles = () => {
    const source = {type: 'geojson', data};
    return Promise.all(TILES.map(index => getGeoJsonTileFeatures(source, index)));
  };
  const postMessage = vi.spyOn(Worker.prototype, 'postMessage');
  try {
    const workerTiles = await requestTiles();
    const requests = postMessage.mock.calls.flatMap(([message]) => {
      const request = message?.payload?.input;
      const input: GeoJsonWorkerRequest | undefined =
        request?.operation === 'process' ? request.input : undefined;
      return input && input.type !== 'remove' ? [input] : [];
    });
    expect(requests.map(request => request.type)).toEqual([
      'features', 'features', 'features', 'index', 'tile', 'tile', 'tile'
    ]);
    expect(new Set(requests.map(request => request.source)).size).toBe(1);
    const batches = requests.filter(request => request.type === 'features');
    expect(batches.flatMap(batch => batch.features)).toEqual(data.features);
    for (const batch of batches) {
      const positions = batch.features.length * POSITIONS_PER_POLYGON;
      expect(positions).toBeGreaterThan(0);
      expect(positions).toBeLessThan(POSITIONS_PER_BATCH + POSITIONS_PER_POLYGON);
    }
    const index = requests.find(request => request.type === 'index');
    expect(index?.data).toBeUndefined();

    expect(workerTiles.every(tile => tile.length > 0)).toBe(true);
    setGeoJsonWorkerEnabled(false);
    expect(await requestTiles()).toEqual(workerTiles);
  } finally {
    setGeoJsonWorkerEnabled(true);
    postMessage.mockRestore();
  }
});
