// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {MVTWriter} from '@loaders.gl/tiles/mvt';
import {createStreetsRoadRules} from '../../examples/deck/streets-cartography';
import {createUnlitVectorStyles} from '../../examples/deck/basemap-styling';
import {createComparisonStyle} from '../../examples/deck/comparison-style';
import {mountMapLibreComparison} from '../../examples/deck/maplibre-comparison';
import {getOpenMapTilesAnchor} from './openmaptiles-scene';
import {RenderingHarness, readCanvasPixels, DEVICE_TYPE} from './harness';

let harness: RenderingHarness | undefined;
let comparison: Awaited<ReturnType<typeof mountMapLibreComparison>> | undefined;
let root: HTMLElement | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors ?? []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
    if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName ?? 'streets-roads', harness.canvas.toDataURL());
  } finally {comparison?.destroy(); comparison = undefined; root?.remove(); root = undefined; harness?.destroy(); harness = undefined;}
});

test.each([
  {format: 'GeoJSON', bridge: false, tunnel: false}, {format: 'GeoJSON', bridge: true, tunnel: false},
  {format: 'GeoJSON', bridge: false, tunnel: true},
  {format: 'MVT', bridge: false, tunnel: false}, {format: 'MVT', bridge: true, tunnel: false},
  {format: 'MVT', bridge: false, tunnel: true}
] as const)(`${DEVICE_TYPE}: $format Streets road grade precedence; bridge=$bridge tunnel=$tunnel`, async ({format, bridge, tunnel}) => {
  harness = new RenderingHarness('flat'); harness.tileZoom = 15;
  const {longitude, latitude} = getOpenMapTilesAnchor();
  harness.presentation.setViewState({longitude, latitude, zoom: 15});
  const geometry = {type: 'FeatureCollection' as const, features: [
    {type: 'Feature' as const, properties: {class: 'primary', ...(tunnel ? {brunnel: 'tunnel'} : {})}, geometry: {type: 'LineString' as const,
      coordinates: [[longitude - 0.004, latitude], [longitude + 0.004, latitude]]}},
    {type: 'Feature' as const, properties: {class: 'service', ...(bridge ? {brunnel: 'bridge'} : {})}, geometry: {type: 'LineString' as const,
      coordinates: [[longitude, latitude - 0.004], [longitude, latitude + 0.004]]}}
  ]};
  const bytes = format === 'MVT' ? new Uint8Array(MVTWriter.encodeSync(geometry, {mvt: {layerName: 'transportation',
    tileIndex: {z: 14, x: Math.floor((longitude + 180) / 360 * 2 ** 14),
      y: Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 2 ** 14)}, extent: 4096}})) : null;
  const url = bytes ? `data:application/vnd.mapbox-vector-tile;base64,${btoa(String.fromCharCode(...bytes))}#/{z}/{x}/{y}`
    : `data:application/json,${encodeURIComponent(JSON.stringify(geometry))}`;
  const roads = createStreetsRoadRules();
  await harness.initialize({styles: createUnlitVectorStyles(), sources: {fixture: {type: format, url, max_zoom: 14, tile_size: 512}},
    layers: {roads: {...roads, data: {source: 'fixture', ...(bytes ? {layer: 'transportation'} : {})}}}});
  await harness.settle();
  const image = await harness.pixels();
  const center = (160 * image.width + 256) * 4;
  expect(Array.from(image.data.slice(center, center + 3))).toEqual(bridge || tunnel ? [255, 255, 255] : [245, 200, 121]);
  let uninterrupted = 0;
  for (let column = 80; column < 432; column++) {
    if (Math.abs(column - 256) < 20) continue;
    const offset = (160 * image.width + column) * 4;
    if (image.data[offset] === 245 && image.data[offset + 1] === 200 && image.data[offset + 2] === 121) uninterrupted++;
  }
  expect(uninterrupted).toBeGreaterThan(250);

  root = document.createElement('div'); root.style.cssText = 'position:relative;width:1024px;height:320px'; document.body.append(root);
  const referenceStyle = createComparisonStyle('streetsVector', 'mapFlat');
  referenceStyle.sources = {basemap: bytes ? {type: 'vector', tiles: [url], maxzoom: 14} : {type: 'geojson', data: geometry}};
  referenceStyle.layers = referenceStyle.layers.filter(layer => layer.type === 'line' && layer['source-layer'] === 'transportation').map(layer => {
    if (bytes || layer.type !== 'line') return layer;
    const {'source-layer': _sourceLayer, ...remaining} = layer;
    return remaining;
  });
  const referenceErrors: string[] = [];
  comparison = await mountMapLibreComparison({container: root, camera: {longitude, latitude, zoom: 15}, viewMode: 'mapFlat',
    style: referenceStyle, preserveDrawingBuffer: true,
    stylesheetUrl: new URL('../../examples/dist/maplibre.css', import.meta.url).href,
    workerUrl: new URL('../../examples/dist/maplibre-worker.js', import.meta.url).href,
    onChange: () => {}, onError: error => referenceErrors.push(error.message)});
  const canvas = root.querySelector('canvas'); if (!canvas) throw new Error('Missing road reference canvas');
  await expect.poll(async () => {
    expect(referenceErrors).toEqual([]);
    const reference = await readCanvasPixels(canvas);
    const offset = (Math.floor(reference.height / 2) * reference.width + Math.floor(reference.width / 2)) * 4;
    return Array.from(reference.data.slice(offset, offset + 3));
  }, {timeout: 15000}).toEqual(bridge || tunnel ? [255, 255, 255] : [245, 200, 121]);
});
