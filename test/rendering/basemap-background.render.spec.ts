// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Deck, FirstPersonView} from '@deck.gl/core';
import {MVTWriter} from '@loaders.gl/tiles/mvt';
import {BasemapLayer} from '@tangram.gl/basemap-layers';
import {createBasemapBackground} from '../../examples/deck/basemap-background';
import {RenderingHarness, DEVICE_TYPE, readCanvasPixels} from './harness';
import {getOpenMapTilesAnchor} from './openmaptiles-scene';

let harness: RenderingHarness | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors ?? []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
    if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName ?? 'background', harness.canvas.toDataURL());
  } finally {harness?.destroy(); harness = undefined;}
});

test.each([
  {kind: 'flat', sourceType: 'GeoJSON'}, {kind: 'globe', sourceType: 'GeoJSON'},
  {kind: 'flat', sourceType: 'MVT'}, {kind: 'globe', sourceType: 'MVT'}
] as const)(`${DEVICE_TYPE}: $kind $sourceType courtyard holes reveal land, not the host clear color`, async ({kind, sourceType}) => {
  harness = new RenderingHarness(kind);
  const span = 0.003 * harness.scale, hole = 0.001 * harness.scale;
  const dataZoom = kind === 'globe' ? 3 : 14;
  // MVT bytes are encoded for one fixed tile pyramid level. Keep this geometry
  // regression independent of the globe adapter's separate detail policy.
  harness.tileZoom = dataZoom + 1;
  const {longitude, latitude} = getOpenMapTilesAnchor(dataZoom);
  harness.presentation.setViewState({longitude, latitude, zoom: kind === 'globe' ? 5 : 15});
  const point = (east: number, north: number) => [longitude + east, latitude + north];
  const geometry = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
    type: 'MultiPolygon', coordinates: [[
      [point(-span, -span), point(span, -span), point(span, span), point(-span, span), point(-span, -span)],
      [point(-hole, -hole), point(-hole, hole), point(hole, hole), point(hole, -hole), point(-hole, -hole)]
    ], [
      [point(span * 1.5, -hole), point(span * 2, 0), point(span * 1.5, hole), point(span * 1.5, -hole)]
    ]]
  }}]};
  const tileIndex = {z: dataZoom, x: Math.floor((longitude + 180) / 360 * 2 ** dataZoom),
    y: Math.floor((1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2 * 2 ** dataZoom)};
  const bytes = sourceType === 'MVT' ? new Uint8Array(MVTWriter.encodeSync(geometry, {mvt: {tileIndex, layerName: 'courtyard', extent: 4096}})) : null;
  const url = bytes
    ? `data:application/vnd.mapbox-vector-tile;base64,${btoa(String.fromCharCode(...bytes))}#/{z}/{x}/{y}`
    : `data:application/json,${encodeURIComponent(JSON.stringify(geometry))}`;
  const courtyard = {
    scene: {background: {color: '#f5f3ef'}},
    sources: {courtyard: {type: sourceType, url, max_zoom: dataZoom, tile_size: 512}},
    styles: {courtyard: {base: 'polygons', lighting: false}},
    layers: {courtyard: {data: {source: 'courtyard', ...(sourceType === 'MVT' ? {layer: 'courtyard'} : {})},
      draw: {courtyard: {order: 1, color: '#20d0b0'}}}}
  };
  await harness.initialize(courtyard); await harness.settle();
  const withoutBackground = await harness.pixels();
  const center = (160 * 512 + 256) * 4;
  expect(Array.from(withoutBackground.data.slice(center, center + 3))).toEqual([0, 0, 0]);

  const background = createBasemapBackground('#f5f3ef');
  await harness.renderer.load({...courtyard, sources: {...background.sources, ...courtyard.sources},
    styles: {...background.styles, ...courtyard.styles}, layers: {...background.layers, ...courtyard.layers}}, {blocking: false});
  await harness.settle();
  const withBackground = await harness.pixels();
  expect(Array.from(withBackground.data.slice(center, center + 3))).toEqual([245, 243, 239]);
  // Keep the actual polygon roof, including its hole; do not fill or retessellate it to hide black pixels.
  let roofPixels = 0;
  for (let offset = 0; offset < withBackground.data.length; offset += 4) {
    if (Math.abs(withBackground.data[offset] - 32) < 3 && Math.abs(withBackground.data[offset + 1] - 208) < 3 &&
      Math.abs(withBackground.data[offset + 2] - 176) < 3) roofPixels++;
  }
  expect(roofPixels).toBeGreaterThan(100);
});

test('standalone comparison has a viewport-height canvas without relying on a parent HTML height', async () => {
  const stylesheet = document.createElement('link'); stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('../../examples/deck/main.css', import.meta.url).href;
  const loaded = new Promise<void>((resolve, reject) => {
    stylesheet.onload = () => resolve(); stylesheet.onerror = () => reject(new Error('Example stylesheet failed to load'));
  });
  const root = document.createElement('div'); root.id = 'deck-container';
  const previousHeight = document.documentElement.style.height;
  try {
    document.documentElement.style.height = 'auto';
    document.body.classList.add('tangram-deck-standalone');
    document.head.append(stylesheet); document.body.append(root); await loaded;
    expect(root.getBoundingClientRect().height).toBeGreaterThan(300);
  } finally {
    root.remove(); stylesheet.remove(); document.body.classList.remove('tangram-deck-standalone');
    document.documentElement.style.height = previousHeight;
  }
});

test(`${DEVICE_TYPE}: BasemapLayer's background stays visible along the first-person camera path`, async () => {
  harness = new RenderingHarness('first-person');
  await harness.initializeDevice();
  const {canvas, device, errors} = harness;
  const camera = {longitude: -122.4194, latitude: 37.7749, pitch: 60, bearing: 0};
  const deck = new Deck({
    canvas, device, width: 554, height: 480, useDevicePixels: false,
    views: new FirstPersonView({fovy: 36.86989764584402, near: 0.1, far: 20000}),
    viewState: {...camera, position: [0, 0, 600]},
    layers: [new BasemapLayer({
      id: 'background-fixture',
      style: {version: 8, sources: {}, layers: [
        {id: 'ground', type: 'background', paint: {'background-color': '#18202c'}}
      ]}
    })],
    onError: error => {errors.push(error.message);}
  });

  try {
    const positions: [number, number, number][] = [
      [0, 0, 600], [0, 23.5, 600], [0, 43.5, 600], [0, 63.5, 600],
      [2.2568, 12.1962, 600], [0, -20.5, 600], [40, 0, 600]
    ];
    for (const position of positions) {
      deck.setProps({viewState: {...camera, position}});
      await expect.poll(async () => {
        const {data, width, height} = await readCanvasPixels(canvas);
        let covered = 0;
        for (let index = 0; index < data.length; index += 4) {
          if (data[index] === 24 && data[index + 1] === 32 && data[index + 2] === 44) covered++;
        }
        return covered / (width * height);
      }, {timeout: 3500, interval: 50, message: `Ground coverage at ${position.join(', ')}`}).toBeGreaterThan(0.999);
    }
    deck.setProps({viewState: {...camera, position: [0, 0, 600], pitch: 0}});
    await expect.poll(async () => {
      const {data, width, height} = await readCanvasPixels(canvas);
      const sky = (Math.floor(height / 4) * width + Math.floor(width / 2)) * 4;
      const ground = (Math.floor(height * 3 / 4) * width + Math.floor(width / 2)) * 4;
      return [data[sky], data[sky + 1], data[sky + 2], data[ground], data[ground + 1], data[ground + 2]];
    }, {timeout: 3500, interval: 50}).toEqual([0, 0, 0, 24, 32, 44]);
  } finally {
    deck.finalize();
  }
});
