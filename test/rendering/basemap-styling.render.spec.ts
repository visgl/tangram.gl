// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {createUnlitVectorStyles, openMapTilesBuildingExtrusion} from '../../examples/deck/basemap-styling';
import {createBlueMarbleScene} from '../../examples/classic/app/nasa-basemap.js';
import {RenderingHarness, changedPixels, DEVICE_TYPE} from './harness';
import {createOpenMapTilesScene, createOpenMapTilesUrl, getOpenMapTilesAnchor} from './openmaptiles-scene';

let harness: RenderingHarness | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors ?? []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
    if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName ?? 'basemap-style', harness.canvas.toDataURL());
  } finally {harness?.destroy(); harness = undefined;}
});

test.each([
  {kind: 'flat', raster: false}, {kind: 'perspective', raster: false}, {kind: 'globe', raster: false},
  {kind: 'flat', raster: true}, {kind: 'perspective', raster: true}, {kind: 'globe', raster: true}
] as const)(`${DEVICE_TYPE}: $kind cartographic surface keeps authored color; raster=$raster`, async ({kind, raster}) => {
  harness = new RenderingHarness(kind);
  harness.presentation.setViewState({latitude: 40, zoom: kind === 'globe' ? 3 : 15});
  const extent = kind === 'globe' ? 30 : 0.01;
  const geometry = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
    type: 'Polygon', coordinates: [[[-extent, 40 - extent], [extent, 40 - extent],
      [extent, 40 + extent], [-extent, 40 + extent], [-extent, 40 - extent]]]
  }}]};
  const source = `data:application/json,${encodeURIComponent(JSON.stringify(geometry))}`;
  const vector = {
    sources: {surface: {type: 'GeoJSON', url: source, max_zoom: kind === 'globe' ? 3 : 14}},
    styles: createUnlitVectorStyles(),
    layers: {surface: {data: {source: 'surface'}, draw: {polygons: {style: 'basemap-polygons', order: 0, color: '#5080b0'}}}}
  };
  const imagery = createBlueMarbleScene();
  const image = document.createElement('canvas'); image.width = image.height = 2;
  const context = image.getContext('2d'); if (!context) throw new Error('Missing fixture canvas context');
  context.fillStyle = '#5080b0'; context.fillRect(0, 0, 2, 2);
  imagery.sources.blueMarble.url = `${image.toDataURL()}#/{z}/{x}/{y}`;
  await harness.initialize({...(raster ? imagery : vector),
    // A deliberately colored light must not tint either 2D map surface.
    lights: [{type: 'ambient', color: [255, 0, 0], intensity: 0.25}]});
  await harness.settle();
  const pixels = await harness.pixels();
  for (const horizontal of [208, 256, 304]) {
    for (const vertical of [128, 160, 192]) {
      const offset = (vertical * pixels.width + horizontal) * 4;
      for (const [channel, expected] of [80, 128, 176].entries()) {
        expect(Math.abs(pixels.data[offset + channel] - expected)).toBeLessThan(3);
      }
    }
  }
});

test(`${DEVICE_TYPE}: packaged worker gives TRON roofs and outlines OpenMapTiles render heights`, async () => {
  harness = new RenderingHarness('perspective');
  harness.presentation.setViewState(getOpenMapTilesAnchor());
  const fixture = createOpenMapTilesScene(createOpenMapTilesUrl(), false, true, false);
  const scene = (extrusion: boolean | [number, number] | typeof openMapTilesBuildingExtrusion) => ({...fixture,
    layers: {...fixture.layers, buildings: {...fixture.layers.buildings, draw: {
      polygons: {...fixture.layers.buildings.draw.polygons, extrude: extrusion},
      lines: {order: 3, color: '#50c0ff', width: '2px', extrude: extrusion}
    }}}
  });
  await harness.initialize(scene([20, 120])); await harness.settle();
  const expected = await harness.pixels();
  await harness.renderer.load(scene(openMapTilesBuildingExtrusion)); await harness.settle();
  expect(changedPixels(expected, await harness.pixels())).toBe(0);
  // The old automatic-height path reads height/min_height, absent in this MVT.
  await harness.renderer.load(scene(true)); await harness.settle();
  expect(changedPixels(expected, await harness.pixels())).toBeGreaterThan(100);
});
