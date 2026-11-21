// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `color-relief` layers over a `raster-dem` source are colored as MapLibre GL JS colors them.
 *
 * Each case draws one color-relief layer over an opaque background, around Mount Rainier, from the
 * four terrarium DEM tiles of `hillshade.browser.spec.ts` (see `fixtures.ts`), with both renderers,
 * and compares every pixel. With `VITE_COLOR_RELIEF_OUTPUT=1`, a comparison image of each case and
 * the measured colors are written to `__output__/`.
 */

import {afterAll, describe, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {toFixtureUrl} from './fixtures';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import {VIEWPORT, type ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_COLOR_RELIEF_OUTPUT === '1';

const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/**
 * The north-west corner of tile 11/331/722, where the four recorded tiles meet, at a zoom that
 * draws them 300 pixels wide, where MapLibre GL JS's snap of raster tiles to the pixel grid is zero
 * (see `hillshade.browser.spec.ts`).
 */
const SCENE: ReferenceScene = {
  id: 'mount-rainier-color-relief',
  style: 'ofm-liberty',
  center: [-121.81640625, 46.8000594467873],
  zoom: 10 + Math.log2(300 / 256)
};

/** The zoom that draws the zoom 11 tiles 512 pixels wide, scaled up past the source's maxzoom. */
const SCALED_UP_ZOOM = 11;

/** A height ramp over the elevations of the view, 450 to 4392 meters. */
const HYPSOMETRIC = [
  'interpolate',
  ['linear'],
  ['elevation'],
  400,
  '#0b6623',
  1000,
  '#7fb04c',
  1800,
  '#e8d68f',
  2600,
  '#a5714e',
  3400,
  '#d9d9d9',
  4300,
  '#ffffff'
];

/** 64 stops, 60 meters apart, with alternating colors: the binary search finds each band. */
const BANDS = ['interpolate', ['linear'], ['elevation']];
for (let stop = 0; stop < 64; stop++) {
  BANDS.push(500 + stop * 60 as any, stop % 2 ? '#1f78b4' : `hsl(${stop * 5}, 80%, 60%)` as any);
}

type ColorReliefCase = {
  id: string;
  /** The color-relief layer's paint. */
  paint: Record<string, unknown>;
  /** Replaces properties of the DEM source. */
  source?: Record<string, unknown>;
  /** Camera zoom. Default the scene's. */
  zoom?: number;
  /** Also draws a hillshade over the color relief. */
  hillshade?: boolean;
  /** The most the 99th percentile pixel may differ. Default `P99_PIXEL_TOLERANCE`. */
  p99Tolerance?: number;
};

const CASES: ColorReliefCase[] = [
  {id: 'hypsometric ramp', paint: {'color-relief-color': HYPSOMETRIC}},
  {
    id: 'opacity and translucent stops',
    paint: {
      'color-relief-opacity': 0.6,
      'color-relief-color': [
        'interpolate',
        ['linear'],
        ['elevation'],
        800,
        'rgba(0, 90, 200, 0.2)',
        2000,
        'rgba(240, 200, 40, 0.9)',
        4000,
        'rgba(200, 30, 30, 0.5)'
      ]
    }
  },
  // MapLibre blends the colors of the stops linearly, whatever the interpolation.
  {
    id: 'interpolate-hcl, exponential',
    paint: {
      'color-relief-color': [
        'interpolate-hcl',
        ['exponential', 1.5],
        ['elevation'],
        500,
        '#2b83ba',
        2500,
        '#ffffbf',
        4400,
        '#d7191c'
      ]
    }
  },
  // The colors change by up to 3.4 levels per meter, so the slightest difference in the filtered
  // elevation shows (see `P99_PIXEL_TOLERANCE`). The median pixel is still exact.
  {id: '64 bands', paint: {'color-relief-color': BANDS}, p99Tolerance: 12},
  // Elevations past the ends of the ramp take its end colors.
  {
    id: 'ramp narrower than the elevations',
    paint: {
      'color-relief-color': ['interpolate', ['linear'], ['elevation'], 1500, '#000080', 2500, '#ffa500']
    }
  },
  // The same tiles, decoded with the `custom` factors of the terrarium encoding.
  {
    id: 'custom encoding',
    paint: {'color-relief-color': HYPSOMETRIC},
    source: {
      encoding: 'custom',
      redFactor: 256,
      greenFactor: 1,
      blueFactor: 1 / 256,
      baseShift: 32768
    }
  },
  {
    id: 'nearest resampling, scaled up past maxzoom',
    zoom: SCALED_UP_ZOOM,
    paint: {'color-relief-color': BANDS, resampling: 'nearest'}
  },
  {id: 'scaled up past maxzoom', zoom: SCALED_UP_ZOOM, paint: {'color-relief-color': BANDS}},
  // The hillshade differs on its own (see `hillshade.browser.spec.ts`).
  {
    id: 'under a hillshade',
    hillshade: true,
    paint: {'color-relief-color': HYPSOMETRIC},
    p99Tolerance: 6
  },
  // Not an `interpolate` expression: transparent in MapLibre.
  {
    id: 'step expression draws nothing',
    paint: {'color-relief-color': ['step', ['elevation'], '#000000', 2000, '#ffffff']}
  }
];

/** The most the mean color may differ from MapLibre's, per channel, in 0-255. */
const MEAN_TOLERANCE = 0.25;

/** The most the median pixel may differ from MapLibre's, as the sum of its RGB differences. */
const MEDIAN_PIXEL_TOLERANCE = 0;

/**
 * The most the 99th percentile pixel may differ, in the same units. The DEM is filtered between
 * texels, and the two renderers' texture coordinates differ in their last bits, in the northern
 * two tiles only, which moves the filter's weights: steep terrain under a steep ramp shows it.
 * With nearest resampling, which has no weights, no pixel differs by more than 1.
 */
const P99_PIXEL_TOLERANCE = 3;

function getColorReliefStyle({paint, source = {}, hillshade}: ColorReliefCase): any {
  return {
    version: 8,
    sources: {
      terrain: {
        type: 'raster-dem',
        tiles: [toFixtureUrl(DEM_TILES)],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 11,
        ...source
      }
    },
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#f2efe9'}},
      {id: 'relief', type: 'color-relief', source: 'terrain', paint},
      ...(hillshade ? [{id: 'hillshade', type: 'hillshade', source: 'terrain'}] : [])
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
  const mean = sums.map(sum => sum / count);
  differences.sort((a, b) => a - b);
  return {
    reference: mean.slice(0, 3),
    candidate: mean.slice(3),
    medianDifference: differences[Math.floor(count / 2)],
    p99Difference: differences[Math.floor(count * 0.99)],
    maxDifference: differences[count - 1],
    /** The share of pixels that differ at all. */
    differentShare: differences.filter(difference => difference > 0).length / count
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
    `modules/basemap-layers/test/reference-render/__output__/color-relief-${name}.png`,
    canvas.toDataURL('image/png').split(',')[1],
    'base64'
  );
}

const measured: Record<string, unknown> = {};

describe('color-relief', () => {
  test.each(CASES)('$id', async colorReliefCase => {
    const style = getColorReliefStyle(colorReliefCase);
    const scene = {...SCENE, zoom: colorReliefCase.zoom ?? SCENE.zoom};
    const reference = await renderMapLibre(structuredClone(style), scene);
    const candidate = await renderBasemapLayer(structuredClone(style), scene);
    if (OUTPUT) {
      await writeComparison(colorReliefCase.id, reference.pixels, candidate.pixels);
    }
    expect(reference.problems).toEqual([]);
    expect(candidate.problems).toEqual([]);

    const colors = compare(reference.pixels, candidate.pixels);
    measured[colorReliefCase.id] = colors;
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
      colorReliefCase.p99Tolerance ?? P99_PIXEL_TOLERANCE
    );
  }, 120_000);

  afterAll(async () => {
    if (OUTPUT) {
      await commands.writeFile(
        'modules/basemap-layers/test/reference-render/__output__/color-relief.json',
        `${JSON.stringify(measured, null, 2)}\n`
      );
    }
  });
});
