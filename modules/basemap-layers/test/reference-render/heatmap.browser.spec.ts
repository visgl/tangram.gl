// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `heatmap` layers draw as MapLibre GL JS draws them: the same Gaussian kernels, summed into a
 * density a quarter of the canvas's size, colored by the same `heatmap-color` ramp.
 *
 * Most cases draw a GeoJSON source of clustered points that cross the zoom 4 tile edges, over a
 * colored background; one draws the points of interest of four recorded vector tiles. Both renderers
 * draw each case, and every pixel is compared. With `VITE_HEATMAP_OUTPUT=1`, a comparison image of
 * each case and the measured values are written to `__output__/`.
 */

import {afterAll, describe, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {loadReferenceStyle} from './fixtures';
import {renderBasemapLayer, renderMapLibre, type RenderOptions} from './renderers';
import {VIEWPORT, type ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_HEATMAP_OUTPUT === '1';

/** Around the corner of four zoom 4 tiles, at longitude 0 and latitude 40.98. */
const SCENE: ReferenceScene = {
  id: 'heatmap-z4',
  style: 'ofm-positron',
  center: [0, 41],
  zoom: 4
};

/** The points of interest of the four recorded New York tiles, which meet near the center. */
const NEW_YORK: ReferenceScene = {
  id: 'heatmap-new-york-z14.2',
  style: 'ofm-positron',
  center: [-73.99, 40.735],
  zoom: 14.2
};

/** A small linear congruential generator, so that the points are the same at every run. */
function getRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** Clusters of points around the scene's center, with a `mag` from 1 to 5. */
function getPoints(): any {
  const random = getRandom(7);
  const gaussian = () =>
    Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const clusters = [
    {center: [0.4, 41.2], spread: 1.2, count: 150},
    {center: [-6, 44], spread: 2.5, count: 120},
    {center: [7, 37], spread: 0.6, count: 60},
    {center: [-3, 36.5], spread: 3, count: 70}
  ];
  const features = [];
  for (const {center, spread, count} of clusters) {
    for (let index = 0; index < count; index++) {
      features.push({
        type: 'Feature',
        properties: {mag: 1 + Math.floor(random() * 5)},
        geometry: {
          type: 'Point',
          coordinates: [center[0] + gaussian() * spread, center[1] + gaussian() * spread * 0.75]
        }
      });
    }
  }
  return {type: 'FeatureCollection', features};
}

type HeatmapCase = {
  id: string;
  /** The heatmap layer's paint. */
  paint?: Record<string, unknown>;
  /** The scene; default `SCENE`. */
  scene?: ReferenceScene;
  options?: RenderOptions;
};

const RAMP = [
  'interpolate',
  ['linear'],
  ['heatmap-density'],
  0,
  'rgba(33, 102, 172, 0)',
  0.2,
  'rgb(103, 169, 207)',
  0.4,
  'rgb(209, 229, 240)',
  0.6,
  'rgb(253, 219, 199)',
  0.8,
  'rgb(239, 138, 98)',
  1,
  'rgb(178, 24, 43)'
];

const CASES: HeatmapCase[] = [
  {id: 'default paint'},
  {
    id: 'data-driven radius and weight, custom ramp',
    paint: {
      'heatmap-radius': ['*', 6, ['get', 'mag']],
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'mag'], 1, 0.2, 5, 1],
      'heatmap-intensity': 0.6,
      'heatmap-color': RAMP
    }
  },
  {
    id: 'stepped ramp, half opacity',
    paint: {
      'heatmap-radius': 18,
      'heatmap-intensity': 2,
      'heatmap-opacity': 0.5,
      'heatmap-color': [
        'step',
        ['heatmap-density'],
        'rgba(0, 0, 0, 0)',
        0.25,
        '#fee391',
        0.5,
        '#fe9929',
        0.75,
        '#cc4c02'
      ]
    }
  },
  // The density texture is a quarter of the canvas's device pixels.
  {id: 'device pixel ratio 2', options: {pixelRatio: 2}},
  // Kernels lie on the map: pitched, they are drawn foreshortened.
  {id: 'pitched 50°, turned 30°', options: {pitch: 50, bearing: 30}},
  {
    id: 'points of interest of vector tiles',
    scene: NEW_YORK,
    paint: {'heatmap-radius': 25, 'heatmap-intensity': 0.5}
  }
];

/**
 * The most the mean color may differ from MapLibre's, per channel, in 0-255. Without the
 * heatmap, the means differ by up to 60.
 */
const MEAN_TOLERANCE = 1;

/**
 * The most the median pixel may differ from MapLibre's at the same place, as the sum of its RGB
 * differences.
 */
const MEDIAN_PIXEL_TOLERANCE = 2;

/**
 * The most the 99th percentile pixel may differ. The point positions differ in their last bits
 * (MapLibre rounds them to its tile grid), and the density texture is a quarter of the canvas: a
 * steep ramp step moves by up to a texel.
 */
const P99_PIXEL_TOLERANCE = 30;

async function getHeatmapStyle({paint = {}, scene = SCENE}: HeatmapCase): Promise<any> {
  const heatmap = {id: 'heatmap', type: 'heatmap', paint};
  if (scene === NEW_YORK) {
    const reference = await loadReferenceStyle(scene.style);
    return {
      version: 8,
      sources: {openmaptiles: reference.sources.openmaptiles},
      layers: [
        {id: 'background', type: 'background', paint: {'background-color': '#1d2733'}},
        {...heatmap, source: 'openmaptiles', 'source-layer': 'poi'}
      ]
    };
  }
  return {
    version: 8,
    sources: {points: {type: 'geojson', data: getPoints()}},
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#1d2733'}},
      {...heatmap, source: 'points'}
    ]
  };
}

/** The mean RGB of each render, and the median and 99th percentile summed RGB differences. */
function compare(reference: Uint8ClampedArray, candidate: Uint8ClampedArray) {
  const sums = [0, 0, 0, 0, 0, 0];
  const differences: number[] = [];
  for (let index = 0; index < reference.length; index += 4) {
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) {
      sums[channel] += reference[index + channel];
      sums[channel + 3] += candidate[index + channel];
      difference += Math.abs(reference[index + channel] - candidate[index + channel]);
    }
    differences.push(difference);
  }
  const count = differences.length;
  differences.sort((a, b) => a - b);
  return {
    reference: sums.slice(0, 3).map(sum => sum / count),
    candidate: sums.slice(3).map(sum => sum / count),
    medianDifference: differences[Math.floor(count / 2)],
    p99Difference: differences[Math.floor(count * 0.99)],
    maxDifference: differences[count - 1]
  };
}

/** The share of pixels that differ from the background, which the heatmap colors. */
function getColoredShare(pixels: Uint8ClampedArray): number {
  let colored = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const difference =
      Math.abs(pixels[index] - 0x1d) +
      Math.abs(pixels[index + 1] - 0x27) +
      Math.abs(pixels[index + 2] - 0x33);
    if (difference > 6) {
      colored++;
    }
  }
  return colored / (pixels.length / 4);
}

async function writeComparison(
  id: string,
  reference: Uint8ClampedArray,
  candidate: Uint8ClampedArray,
  pixelRatio: number
) {
  const width = VIEWPORT.width * pixelRatio;
  const height = VIEWPORT.height * pixelRatio;
  const canvas = document.createElement('canvas');
  canvas.width = width * 3;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(reference), width, height), 0, 0);
  context.putImageData(new ImageData(new Uint8ClampedArray(candidate), width, height), width, 0);
  // The difference, amplified 8 times, black where the renders agree.
  const difference = new Uint8ClampedArray(reference.length);
  for (let index = 0; index < reference.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      difference[index + channel] =
        Math.abs(reference[index + channel] - candidate[index + channel]) * 8;
    }
    difference[index + 3] = 255;
  }
  context.putImageData(new ImageData(difference, width, height), width * 2, 0);
  const name = id.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  await commands.writeFile(
    `modules/basemap-layers/test/reference-render/__output__/heatmap-${name}.png`,
    canvas.toDataURL('image/png').split(',')[1],
    'base64'
  );
}

const measured: Record<string, unknown> = {};

describe('heatmap', () => {
  test.each(CASES)('$id', async heatmapCase => {
    const style = await getHeatmapStyle(heatmapCase);
    const scene = heatmapCase.scene ?? SCENE;
    const options = heatmapCase.options ?? {};
    const reference = await renderMapLibre(structuredClone(style), scene, options);
    const candidate = await renderBasemapLayer(structuredClone(style), scene, {}, options);
    if (OUTPUT) {
      await writeComparison(
        heatmapCase.id,
        reference.pixels,
        candidate.pixels,
        options.pixelRatio ?? 1
      );
    }
    expect(reference.problems).toEqual([]);
    expect(candidate.problems).toEqual([]);

    const colors = compare(reference.pixels, candidate.pixels);
    const coloredShare = getColoredShare(reference.pixels);
    measured[heatmapCase.id] = {...colors, coloredShare};
    expect(coloredShare, 'share of the view MapLibre colors').toBeGreaterThan(0.1);
    for (let channel = 0; channel < 3; channel++) {
      const offset = Math.abs(colors.candidate[channel] - colors.reference[channel]);
      expect(offset, `mean ${'RGB'[channel]} offset from MapLibre`).toBeLessThanOrEqual(
        MEAN_TOLERANCE
      );
    }
    expect(colors.medianDifference, 'median pixel difference from MapLibre').toBeLessThanOrEqual(
      MEDIAN_PIXEL_TOLERANCE
    );
    expect(colors.p99Difference, '99th percentile pixel difference').toBeLessThanOrEqual(
      P99_PIXEL_TOLERANCE
    );
  }, 120_000);

  afterAll(async () => {
    if (OUTPUT) {
      await commands.writeFile(
        'modules/basemap-layers/test/reference-render/__output__/heatmap.json',
        `${JSON.stringify(measured, null, 2)}\n`
      );
    }
  });
});
