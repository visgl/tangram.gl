// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * A `raster` layer over an `image` source is drawn as MapLibre GL JS draws it.
 *
 * Each case draws an 8 by 8 image of four colored quadrants, with a light stripe in its top left
 * quadrant, at four corners that do not form a rectangle, over an opaque background, with both
 * renderers, and compares every pixel. MapLibre maps the image linearly in Web Mercator space over
 * each of the two triangles of the quad, split from its bottom left to its top right corner, so a
 * corner placed or ordered wrongly moves the quadrants. With `VITE_IMAGE_SOURCE_OUTPUT=1`, a
 * comparison image of each case and the measured differences are written to `__output__/`.
 */

import {afterAll, describe, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {FIXTURE_ROOT} from './fixtures';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import {VIEWPORT, type ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_IMAGE_SOURCE_OUTPUT === '1';

const SCENE: ReferenceScene = {id: 'image-source', style: 'ofm-liberty', center: [0, 0], zoom: 7};

const BACKGROUND = [242, 239, 233];

/** Top left, top right, bottom right and bottom left: a quad that is not a rectangle. */
const SKEWED = [
  [-1.1, 1.3],
  [1.4, 0.9],
  [0.8, -1.2],
  [-1.3, -0.7]
];

type ImageSourceCase = {
  id: string;
  /** The raster layer's paint. */
  paint?: Record<string, unknown>;
  /** The source's corners. Default `SKEWED`. */
  coordinates?: number[][];
};

const CASES: ImageSourceCase[] = [
  {id: 'skewed quad'},
  {id: 'skewed quad, nearest resampling', paint: {'raster-resampling': 'nearest'}},
  {
    id: 'skewed quad, opacity and color adjustments',
    paint: {
      'raster-opacity': 0.6,
      'raster-brightness-min': 0.1,
      'raster-brightness-max': 0.85,
      'raster-saturation': -0.4,
      'raster-contrast': 0.25,
      'raster-hue-rotate': 70
    }
  },
  // Corners listed counterclockwise mirror the image.
  {
    id: 'mirrored quad',
    coordinates: [SKEWED[1], SKEWED[0], SKEWED[3], SKEWED[2]],
    paint: {'raster-resampling': 'nearest'}
  }
];

/**
 * The most the median pixel may differ from MapLibre's at the same place, as the sum of its RGB
 * differences.
 */
const MEDIAN_PIXEL_TOLERANCE = 1;

/**
 * The most the 99th percentile pixel may differ, in the same units. It is 0 or 1: only pixels on
 * the outline of the quad and on the borders between texels differ. Drawn with one mapping per
 * triangle of the quad, it was 100 to 424 off.
 */
const P99_PIXEL_TOLERANCE = 4;

/** The share of the view the image covers, at least: a render that skips it fails. */
const MIN_COVERAGE = 0.15;

function getImageSourceStyle({paint = {}, coordinates = SKEWED}: ImageSourceCase): any {
  return {
    version: 8,
    sources: {
      overlay: {
        type: 'image',
        url: `${location.origin}/${FIXTURE_ROOT}/image-source/quadrants.png`,
        coordinates
      }
    },
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': `rgb(${BACKGROUND})`}},
      {id: 'overlay', type: 'raster', source: 'overlay', paint}
    ]
  };
}

/** The median and 99th percentile summed RGB differences, and the share of pixels drawn over. */
function compare(reference: Uint8ClampedArray, candidate: Uint8ClampedArray) {
  const differences: number[] = [];
  let covered = 0;
  for (let index = 0; index < reference.length; index += 4) {
    let difference = 0;
    let fromBackground = 0;
    for (let channel = 0; channel < 3; channel++) {
      difference += Math.abs(reference[index + channel] - candidate[index + channel]);
      fromBackground += Math.abs(reference[index + channel] - BACKGROUND[channel]);
    }
    differences.push(difference);
    if (fromBackground > 6) covered++;
  }
  const count = differences.length;
  differences.sort((a, b) => a - b);
  return {
    coverage: covered / count,
    medianDifference: differences[Math.floor(count / 2)],
    p99Difference: differences[Math.floor(count * 0.99)],
    maxDifference: differences[count - 1]
  };
}

async function writeComparison(
  id: string,
  reference: Uint8ClampedArray,
  candidate: Uint8ClampedArray
) {
  const {width, height} = VIEWPORT;
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
    `modules/basemap-layers/test/reference-render/__output__/image-source-${name}.png`,
    canvas.toDataURL('image/png').split(',')[1],
    'base64'
  );
}

const measured: Record<string, unknown> = {};

describe('image source', () => {
  test.each(CASES)('$id', async imageCase => {
    const style = getImageSourceStyle(imageCase);
    const reference = await renderMapLibre(structuredClone(style), SCENE);
    const candidate = await renderBasemapLayer(structuredClone(style), SCENE);
    if (OUTPUT) {
      await writeComparison(imageCase.id, reference.pixels, candidate.pixels);
    }
    expect(reference.problems).toEqual([]);
    expect(candidate.problems).toEqual([]);

    const result = compare(reference.pixels, candidate.pixels);
    measured[imageCase.id] = result;
    expect(result.coverage, 'share of the view MapLibre draws the image over').toBeGreaterThan(
      MIN_COVERAGE
    );
    expect(result.medianDifference, 'median pixel difference from MapLibre').toBeLessThanOrEqual(
      MEDIAN_PIXEL_TOLERANCE
    );
    expect(result.p99Difference, '99th percentile pixel difference').toBeLessThanOrEqual(
      P99_PIXEL_TOLERANCE
    );
  }, 120_000);

  afterAll(async () => {
    if (OUTPUT) {
      await commands.writeFile(
        'modules/basemap-layers/test/reference-render/__output__/image-source.json',
        `${JSON.stringify(measured, null, 2)}\n`
      );
    }
  });
});
