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
  sources: Record<string, object>;
  update(options: {force: boolean}): void;
  processTasks(): void;
};

let scene: TerrainScene | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => { scene?.destroy(); container?.remove(); scene = undefined; container = undefined; });

/** Lossless local Terrarium pixels: flat ground or a directional 60-meter-per-pixel ramp. */
function createTerrainImage(slope: 'flat' | 'east' | 'north' | 'south'): string {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Missing fixture canvas context');
  const image = context.createImageData(512, 512);
  for (let row = 0; row < 512; row++) {
    for (let column = 0; column < 512; column++) {
      const height = slope === 'east' ? column * 60 : slope === 'north' ? (511 - row) * 60 :
        slope === 'south' ? row * 60 : 0;
      const encoded = 32768 + height, offset = (row * 512 + column) * 4;
      image.data[offset] = Math.floor(encoded / 256);
      image.data[offset + 1] = encoded % 256;
      image.data[offset + 2] = 0;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  // A fragment tile template uses the production RasterTileSource path while every
  // tile reads the identical local pixels. Image requests ignore the URL fragment.
  return `${canvas.toDataURL('image/png')}#{z}/{x}/{y}`;
}

/** Replace only live data with a tiny geographic fixture; preserve the POC's shader definition. */
async function renderTerrain(definition: object, slope: 'flat' | 'east' | 'north' | 'south', latitude = 0) {
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
  expect(scene.sources.elevation).not.toHaveProperty('images');
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
  const flat = await renderTerrain(definition, 'flat');
  const slope = await renderTerrain(definition, 'east');
  expect(changedPixels(flat, slope)).toBeGreaterThan(10000);
  const offset = (Math.floor(slope.height / 2) * slope.width + Math.floor(slope.width * 0.6)) * 4;
  const equatorialNorth = await renderTerrain(definition, 'north');
  const risingNorth = await renderTerrain(definition, 'north', 46.6);
  // The same height gradient gets steeper as Mercator ground spacing shrinks with latitude.
  // Wrapped procedural coordinates previously made both latitudes appear equatorial.
  expect(Math.abs(risingNorth.data[offset + 1] - equatorialNorth.data[offset + 1])).toBeGreaterThan(2);
  const risingSouth = await renderTerrain(definition, 'south', 46.6);
  // NW illumination must brighten a north-facing normal, not a south-facing one.
  expect(risingSouth.data[offset + 1]).toBeGreaterThan(risingNorth.data[offset + 1] + 30);
  // At display zoom 11, a 512-pixel raster uses source zoom 10. Compare actual
  // color against the slope in meters, including latitude and NW light direction.
  const spacing = 40075016.68557849 / 2 ** 10 / 512 * Math.cos(46.6 * Math.PI / 180);
  const gradient = 60 / spacing;
  for (const [image, northGradient] of [[risingNorth, gradient], [risingSouth, -gradient]] as const) {
    const diffuse = Math.max(0, (1 - northGradient) / Math.hypot(northGradient, 1) / Math.sqrt(3));
    const expectedGreen = 255 * 0.86 * (0.35 + 0.65 * diffuse);
    expect(Math.abs(image.data[offset + 1] - expectedGreen)).toBeLessThan(4);
  }
});
