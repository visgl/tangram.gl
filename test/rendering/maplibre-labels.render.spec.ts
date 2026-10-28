// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Map as MapLibreMap, setWorkerUrl} from 'maplibre-gl';
import {MVTWriter} from '@loaders.gl/mvt';
import {createComparisonStyle} from '../../examples/deck/comparison-style';
import {getOpenMapTilesAnchor} from './openmaptiles-scene';
import {readCanvasPixels} from './harness';

/** Encode a tiny block glyph assigned to X: exercise native SDF loading without network or font fixtures. */
function createGlyphFixture(): string {
  const variable = (value: number): number[] => {
    const result: number[] = [];
    do {const remainder = value % 128; value = Math.floor(value / 128); result.push(remainder + (value ? 128 : 0));} while (value);
    return result;
  };
  const message = (field: number, bytes: number[]): number[] => [field * 8 + 2, ...variable(bytes.length), ...bytes];
  const bitmap = Array.from({length: 18 * 24}, (_, index) => {
    const column = index % 18, row = Math.floor(index / 18);
    return column >= 3 && column < 15 && row >= 3 && row < 21 ? 255 : 0;
  });
  const glyph = [8, 88, ...message(2, bitmap), 24, 12, 32, 18, 40, 0, 48, 36, 56, 14];
  return `data:application/x-protobuf;base64,${btoa(String.fromCharCode(...message(1, message(3, glyph))))}#/{fontstack}/{range}.pbf`;
}

test.each(['streetsVector', 'tron'])('%s renders native MVT place labels and resolves rank collisions offline', async basemap => {
  const {longitude, latitude} = getOpenMapTilesAnchor();
  const geometry = {type: 'FeatureCollection' as const, features: [1, 10].map(rank => ({type: 'Feature' as const, id: rank,
    properties: {name: 'XXX', rank}, geometry: {type: 'Point' as const, coordinates: [longitude, latitude]}}))};
  const bytes = new Uint8Array(MVTWriter.encodeSync(geometry, {mvt: {layerName: 'place',
    tileIndex: {z: 14, x: Math.floor((longitude + 180) / 360 * 2 ** 14),
      y: Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 2 ** 14)}, extent: 4096}}));
  const style = createComparisonStyle(basemap, 'mapFlat');
  style.glyphs = createGlyphFixture();
  style.sources = {basemap: {type: 'vector', maxzoom: 14,
    tiles: [`data:application/vnd.mapbox-vector-tile;base64,${btoa(String.fromCharCode(...bytes))}#/{z}/{x}/{y}`]}};
  style.layers = style.layers.filter(layer => layer.type === 'symbol');
  const container = document.createElement('div'); container.style.cssText = 'width:512px;height:320px'; document.body.append(container);
  setWorkerUrl(new URL('../../examples/dist/maplibre-worker.js', import.meta.url).href);
  const errors: string[] = [];
  const map = new MapLibreMap({container, style, center: [longitude, latitude], zoom: 15,
    attributionControl: false, fadeDuration: 0, canvasContextAttributes: {preserveDrawingBuffer: true}});
  map.on('error', event => errors.push(event.error.message));
  try {
    await expect.poll(() => {expect(errors).toEqual([]); return map.isStyleLoaded();}, {timeout: 15000}).toBe(true);
    await expect.poll(() => {expect(errors).toEqual([]); return map.queryRenderedFeatures({layers: ['place-labels']}).map(feature => feature.properties.rank);},
      {timeout: 15000}).toEqual([1]);
    const image = await readCanvasPixels(map.getCanvas());
    let visible = 0;
    for (let index = 3; index < image.data.length; index += 4) if (image.data[index] > 100) visible++;
    expect(visible).toBeGreaterThan(30);
  } finally {map.remove(); container.remove();}
});
