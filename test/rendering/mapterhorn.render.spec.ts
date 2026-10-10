// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test} from 'vitest';
import Tangram, {type Scene, type SceneDefinition} from '@vis.gl/tangram-renderer';
import {parseSceneYamlLegacy} from '../../modules/tangram-renderer/src/procedures/scene-yaml-legacy';
import {changedPixels, DEVICE_TYPE, readCanvasPixels} from './harness';

/** Minimal classic lifecycle surface used to render the actual POC shader. */
type TerrainScene = Scene & {
  canvas: HTMLCanvasElement;
  view_complete: boolean;
  view: {setView(state: {lng: number; lat: number; zoom: number}): void};
  styles: Record<string, {program: {compiled: boolean}}>;
  update(options: {force: boolean}): void;
  processTasks(): void;
};

let scene: TerrainScene | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => { scene?.destroy(); container?.remove(); scene = undefined; container = undefined; });

/** Lossless local Terrarium pixels: zero-height flat ground or a steep eastward ramp. */
function createTerrainImage(slope: boolean): string {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Missing fixture canvas context');
  const image = context.createImageData(512, 512);
  for (let row = 0; row < 512; row++) {
    for (let column = 0; column < 512; column++) {
      const encoded = 32768 + (slope ? column * 60 : 0), offset = (row * 512 + column) * 4;
      image.data[offset] = Math.floor(encoded / 256);
      image.data[offset + 1] = encoded % 256;
      image.data[offset + 2] = 0;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Replace only live data with a tiny geographic fixture; preserve the POC's shader definition. */
async function renderTerrain(definition: object, slope: boolean, latitude = 0) {
  scene?.destroy();
  const fixture: SceneDefinition = {...definition,
    sources: {elevation: {type: 'Raster', url: createTerrainImage(slope), tile_size: 512,
      filtering: 'nearest', max_zoom: 12, bounds: [-0.1, latitude - 0.1, 0.1, latitude + 0.1]}},
    layers: {terrain: {data: {source: 'elevation', layer: '_default'}, draw: {'mapterhorn-hillshade': {order: 0}}}}};
  scene = Tangram.Scene.create(fixture, {container, disableRenderLoop: true, numWorkers: 1,
    highDensityDisplay: false, webGLContextOptions: {preserveDrawingBuffer: true}}) as TerrainScene;
  const errors: string[] = [];
  scene.subscribe({error: event => errors.push(JSON.stringify(event))});
  scene.view.setView({lng: 0, lat: latitude, zoom: 11});
  await scene.load();
  await expect.poll(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    scene!.update({force: true}); scene!.processTasks();
    expect(errors).toEqual([]);
    return scene!.view_complete;
  }, {timeout: 15000}).toBe(true);
  expect(scene.styles['mapterhorn-hillshade'].program.compiled).toBe(true);
  const pixels = await readCanvasPixels(scene.canvas);
  // Prove a real tile rendered, not only the background, before comparing height fields.
  let terrainPixels = 0;
  for (let offset = 0; offset < pixels.data.length; offset += 4) {
    if (pixels.data[offset + 1] > pixels.data[offset] && pixels.data[offset + 1] < 200) terrainPixels++;
  }
  expect(terrainPixels).toBeGreaterThan(10000);
  return pixels;
}

test.runIf(DEVICE_TYPE === 'webgl')('Mapterhorn POC compiles and shades decoded height rather than encoded RGB', async () => {
  container = document.createElement('div');
  container.style.cssText = 'position:relative;width:600px;height:400px'; document.body.append(container);
  const definition = parseSceneYamlLegacy(await (await fetch('/examples/classic/styles/mapterhorn.yaml')).text());
  if (!definition || typeof definition !== 'object') throw new Error('Missing terrain scene fixture');
  const flat = await renderTerrain(definition, false);
  const slope = await renderTerrain(definition, true);
  expect(changedPixels(flat, slope)).toBeGreaterThan(10000);
  const alpineSlope = await renderTerrain(definition, true, 46.6);
  const offset = (Math.floor(slope.height / 2) * slope.width + Math.floor(slope.width * 0.6)) * 4;
  // The same height gradient gets steeper as Mercator ground spacing shrinks with latitude.
  // Wrapped procedural coordinates previously made both latitudes appear equatorial.
  expect(Math.abs(alpineSlope.data[offset + 1] - slope.data[offset + 1])).toBeGreaterThan(2);
});
