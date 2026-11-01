// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {createWorkerResource} from '@math.gl/core/tasks';
import {GeoJsonTask} from '../modules/basemap-layers/src/geojson-task';
import {decodeTile} from '../modules/basemap-layers/src/geojson-tiler';
import {getGeoJsonTileFeatures} from '../modules/basemap-layers/src/geojson-source';

test('GeoJSON source loads its task worker and tiles data in the browser', async () => {
  const OriginalWorker = globalThis.Worker;
  const workers: Worker[] = [];
  const errors: Event[] = [];
  vi.stubGlobal('Worker', class extends OriginalWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.addEventListener('error', event => errors.push(event));
      workers.push(this);
    }
  });
  try {
    const data = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {name: 'test'}, geometry: {type: 'Point', coordinates: [0, 0]}}]};
    const features = await getGeoJsonTileFeatures({type: 'geojson', data}, {x: 0, y: 0, z: 0});
    expect(features[0].properties).toMatchObject({name: 'test'});
    // More concurrent requests than math.gl's default queue limit must still share the resource.
    const source = {type: 'geojson', data};
    const concurrent = await Promise.all(Array.from({length: 64}, () =>
      getGeoJsonTileFeatures(source, {x: 0, y: 0, z: 0})
    ));
    for (const result of concurrent) expect(result[0].properties).toMatchObject({name: 'test'});
    expect(workers).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('packaged GeoJSON task worker retains independent source indexes', async () => {
  const workerUrl = `${location.origin}/modules/basemap-layers/dist/geojson-task-worker.js`;
  const resource = await createWorkerResource(GeoJsonTask, null, {
    'tangram-geojson': {workerUrl},
    workerType: 'module',
    inputOwnership: 'copy'
  });
  const options = {maxZoom: 0, extent: 4096, buffer: 0, tolerance: 0};
  const feature = (name: string) => ({type: 'Feature', properties: {name, values: new Uint8Array([1, 2, 3])}, geometry: {type: 'Point', coordinates: [0, 0]}});
  try {
    await resource.run({type: 'features', source: 1, features: [feature('one')]});
    await resource.run({type: 'index', source: 1, options});
    await resource.run({type: 'index', source: 2, data: {type: 'FeatureCollection', features: [feature('two')]}, options});
    const first = await resource.run({type: 'tile', source: 1, request: 1, x: 0, y: 0, z: 0});
    const second = await resource.run({type: 'tile', source: 2, request: 2, x: 0, y: 0, z: 0});
    expect('tile' in first && first.tile && decodeTile(first.tile)[0].properties).toMatchObject({name: 'one'});
    expect('tile' in second && second.tile && decodeTile(second.tile)[0].properties).toMatchObject({name: 'two'});
    const repeated = await resource.run({type: 'tile', source: 1, request: 4, x: 0, y: 0, z: 0});
    expect('tile' in first && first.tile && decodeTile(first.tile)[0].properties).toMatchObject({values: new Uint8Array([1, 2, 3])});
    expect('tile' in repeated && repeated.tile && decodeTile(repeated.tile)[0].properties).toMatchObject({values: new Uint8Array([1, 2, 3])});
    await resource.run({type: 'remove', source: 1});
    expect(await resource.run({type: 'tile', source: 1, request: 3, x: 0, y: 0, z: 0})).toEqual({error: 'GeoJSON source has no index'});
  } finally {
    await resource.destroy();
  }
});

test('uncloneable GeoJSON falls back to main-thread tiling', async () => {
  const marker = () => 'local';
  const source = {type: 'geojson', data: {type: 'FeatureCollection', features: [
    {type: 'Feature', properties: {marker}, geometry: {type: 'Point', coordinates: [0, 0]}}
  ]}};
  const result = await getGeoJsonTileFeatures(source, {x: 0, y: 0, z: 0});
  expect(result[0].properties).toMatchObject({marker});
});

test('the legacy GeoJSON worker URL supports both legacy messages and task resources', async () => {
  const workerUrl = `${location.origin}/modules/basemap-layers/dist/geojson-worker.js`;
  const data = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {name: 'legacy'}, geometry: {type: 'Point', coordinates: [0, 0]}}]};
  const options = {maxZoom: 0, extent: 4096, buffer: 0, tolerance: 0};
  const worker = new Worker(workerUrl, {type: 'module'});
  try {
    const reply = new Promise<MessageEvent>(resolve => worker.addEventListener('message', resolve, {once: true}));
    worker.postMessage({type: 'index', source: 1, data, options});
    worker.postMessage({type: 'tile', source: 1, request: 1, x: 0, y: 0, z: 0});
    const response = (await reply).data;
    expect(response.request).toBe(1);
    expect(decodeTile(response.tile)[0].properties).toMatchObject({name: 'legacy'});
  } finally {
    worker.terminate();
  }
  const resource = await createWorkerResource(GeoJsonTask, null, {
    'tangram-geojson': {workerUrl}, workerType: 'module', inputOwnership: 'copy'
  });
  try {
    await resource.run({type: 'index', source: 2, data, options});
    const result = await resource.run({type: 'tile', source: 2, request: 2, x: 0, y: 0, z: 0});
    expect('tile' in result && result.tile && decodeTile(result.tile)[0].properties).toMatchObject({name: 'legacy'});
  } finally {
    await resource.destroy();
  }
});
