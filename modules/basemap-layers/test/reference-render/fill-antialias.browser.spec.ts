// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Compares the antialiasing outline of a fill without `fill-outline-color` with MapLibre GL JS's.
 * MapLibre draws that outline in `fill-color`, one pixel wide. It closes the crack between two
 * polygons that almost meet, as the pieces of an ocean do, and it draws a polygon narrower than a
 * pixel, as a river is at a low zoom. `BasemapLayer` used to draw neither: the styles that have
 * such data showed dashed cracks in the sea and lost their thin rivers.
 *
 * The scene has no network data: one GeoJSON source, drawn by two consecutive fill layers on
 * black. With `VITE_FILL_ANTIALIAS_OUTPUT=1`, a comparison image is written to `__output__/`.
 */

import {expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import {VIEWPORT, type ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_FILL_ANTIALIAS_OUTPUT === '1';

const SCENE: ReferenceScene = {
  id: 'fill-antialias-z10',
  style: 'ofm-positron',
  center: [0, 0],
  zoom: 10
};

/** Degrees per pixel at the scene's zoom, at the equator. */
const DEGREES_PER_PIXEL = 360 / (512 * 2 ** SCENE.zoom);

/** A position in pixels from the viewport's center, x to the right and y down, as `[lng, lat]`. */
function at(x: number, y: number): [number, number] {
  return [x * DEGREES_PER_PIXEL, -y * DEGREES_PER_PIXEL];
}

function polygon(kind: string, points: Array<[number, number]>) {
  const ring = points.map(([x, y]) => at(x, y));
  return {
    type: 'Feature',
    properties: {kind},
    geometry: {type: 'Polygon', coordinates: [[...ring, ring[0]]]}
  };
}

function rectangle(kind: string, left: number, top: number, right: number, bottom: number) {
  return polygon(kind, [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom]
  ]);
}

/** The crack between the two pieces of land: 0.6 pixels wide, in the pixel column at x = 256. */
const CRACK = {left: 0.2, right: 0.8, top: -100, bottom: -20};
/** The sliver of water: 0.15 pixels wide, below the land. */
const SLIVER = {left: -150, right: 150, top: 40, bottom: 100, width: 0.15};
/** The water over the lower left corner of the land, which covers two of its edges. */
const COVER = {left: -190, top: -60, right: -110, bottom: 10};

const DATA = {
  type: 'FeatureCollection',
  features: [
    rectangle('land', -150, CRACK.top, CRACK.left, CRACK.bottom),
    rectangle('land', CRACK.right, CRACK.top, 150, CRACK.bottom),
    polygon('water', [
      [SLIVER.left, SLIVER.top],
      [SLIVER.right, SLIVER.bottom],
      [SLIVER.right, SLIVER.bottom + SLIVER.width],
      [SLIVER.left, SLIVER.top + SLIVER.width]
    ]),
    rectangle('water', COVER.left, COVER.top, COVER.right, COVER.bottom)
  ]
};

const STYLE = {
  version: 8,
  // Without simplification, which would drop the sliver in both renderers.
  sources: {shapes: {type: 'geojson', data: DATA, tolerance: 0}},
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#000000'}},
    {
      id: 'land',
      type: 'fill',
      source: 'shapes',
      filter: ['==', ['get', 'kind'], 'land'],
      paint: {'fill-color': '#c05030'}
    },
    {
      id: 'water',
      type: 'fill',
      source: 'shapes',
      filter: ['==', ['get', 'kind'], 'water'],
      paint: {'fill-color': '#2080d0'}
    }
  ]
};

const {width, height} = VIEWPORT;
const CENTER_X = width / 2;
const CENTER_Y = height / 2;

/** The pixel at an offset from the viewport's center. */
function pixelAt(pixels: Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const index = (Math.floor(CENTER_Y + y) * width + Math.floor(CENTER_X + x)) * 4;
  return [pixels[index], pixels[index + 1], pixels[index + 2]];
}

/**
 * The mean, over the rows of the crack, of the darkest red among the pixels at and beside it. The
 * land's red is 192; the background's is 0.
 */
function getCrackRed(pixels: Uint8ClampedArray): number {
  let sum = 0;
  let rows = 0;
  for (let y = CRACK.top + 10; y < CRACK.bottom - 10; y++) {
    let darkest = 255;
    for (let x = -2; x <= 2; x++) {
      darkest = Math.min(darkest, pixelAt(pixels, x, y)[0]);
    }
    sum += darkest;
    rows++;
  }
  return sum / rows;
}

/** The pixels of the sliver: blue ones, in the rows below the land. */
function countSliverPixels(pixels: Uint8ClampedArray): number {
  let count = 0;
  for (let y = SLIVER.top - 10; y < SLIVER.bottom + 10; y++) {
    for (let x = SLIVER.left - 10; x < SLIVER.right + 10; x++) {
      const [red, , blue] = pixelAt(pixels, x, y);
      if (blue - red > 60) {
        count++;
      }
    }
  }
  return count;
}

/** The reddish pixels inside the water that covers the land's corner, away from its own edges. */
function countLandOverCover(pixels: Uint8ClampedArray): number {
  let count = 0;
  for (let y = COVER.top + 3; y < COVER.bottom - 3; y++) {
    for (let x = COVER.left + 3; x < COVER.right - 3; x++) {
      const [red, , blue] = pixelAt(pixels, x, y);
      if (red > blue) {
        count++;
      }
    }
  }
  return count;
}

async function writeComparison(reference: Uint8ClampedArray, candidate: Uint8ClampedArray) {
  const canvas = document.createElement('canvas');
  canvas.width = width * 2;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(reference), width, height), 0, 0);
  context.putImageData(new ImageData(new Uint8ClampedArray(candidate), width, height), width, 0);
  await commands.writeFile(
    'modules/basemap-layers/test/reference-render/__output__/fill-antialias.png',
    canvas.toDataURL('image/png').split(',')[1],
    'base64'
  );
}

test("a fill's antialiasing outline closes cracks and draws slivers, as in MapLibre", async () => {
  const reference = await renderMapLibre(structuredClone(STYLE), SCENE);
  const candidate = await renderBasemapLayer(structuredClone(STYLE), SCENE);
  if (OUTPUT) {
    await writeComparison(reference.pixels, candidate.pixels);
  }
  expect(reference.problems).toEqual([]);
  expect(candidate.problems).toEqual([]);

  // MapLibre closes the crack: the land's red, 192. Without the outline: 77.
  const referenceCrack = getCrackRed(reference.pixels);
  const candidateCrack = getCrackRed(candidate.pixels);
  expect(referenceCrack, "MapLibre's crack").toBeGreaterThan(170);
  expect(Math.abs(candidateCrack - referenceCrack), 'red at the crack').toBeLessThan(20);

  // MapLibre draws the sliver as a line about 300 pixels long. Without the outline: 0 pixels.
  const referenceSliver = countSliverPixels(reference.pixels);
  const candidateSliver = countSliverPixels(candidate.pixels);
  expect(referenceSliver, "MapLibre's sliver").toBeGreaterThan(200);
  expect(candidateSliver / referenceSliver, 'share of the sliver drawn').toBeGreaterThan(0.8);
  expect(candidateSliver / referenceSliver, 'share of the sliver drawn').toBeLessThan(1.25);

  // The two fills share a sublayer. The land's outline stays below the water that covers it.
  expect(countLandOverCover(reference.pixels), 'land over water in MapLibre').toBe(0);
  expect(countLandOverCover(candidate.pixels), 'land over water').toBe(0);
});
