// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `line-gradient` draws as MapLibre GL JS draws it: each line of a GeoJSON source with
 * `lineMetrics` colored by its `line-progress`, from its start to its end across the tiles it
 * crosses. Each case draws lines over black with both renderers and compares the colors of the
 * pixels both draw on. As a control, the same lines drawn without the gradient, in `line-color`,
 * must differ. With `VITE_LINE_GRADIENT_OUTPUT=1`, the renders and the measured values of each case
 * are written to `__output__/`.
 */

import {describe, expect, test} from 'vitest';
import {writeComparison} from './comparison-output';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import type {ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_LINE_GRADIENT_OUTPUT === '1';

/** Over Europe, where the lines cross the zoom 3 tile edges at longitude 0 and latitude 41. */
const SCENE: ReferenceScene = {
  id: 'line-gradient-europe-z3.3',
  style: 'ofm-positron',
  center: [10, 45],
  zoom: 3.3
};

/** A line across both tile edges, with a bend, and a line in two parts. */
const DATA = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-8, 36],
          [4, 50],
          [16, 44],
          [28, 54]
        ]
      },
      properties: {}
    },
    {
      type: 'Feature',
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [-6, 56],
            [26, 58]
          ],
          [
            [-4, 33],
            [26, 37]
          ]
        ]
      },
      properties: {}
    }
  ]
};

type GradientCase = {
  id: string;
  paint: Record<string, unknown>;
  /**
   * Dashed: the dashes fall where `BasemapLayer` draws them without a gradient, which is not
   * exactly where MapLibre draws them (0.63 of the drawn pixels overlap either way). The colors of
   * the pixels both draw must match, and the gradient must not move the dashes.
   */
  dashed?: boolean;
};

const RAINBOW = [
  'interpolate',
  ['linear'],
  ['line-progress'],
  0,
  '#2040ff',
  0.4,
  '#20e040',
  1,
  '#ff3020'
];

const CASES: GradientCase[] = [
  {id: 'interpolated', paint: {'line-gradient': RAINBOW}},
  {id: 'interpolated, half opacity', paint: {'line-gradient': RAINBOW, 'line-opacity': 0.5}},
  {id: 'dashed', paint: {'line-gradient': RAINBOW, 'line-dasharray': [3, 1]}, dashed: true},
  {
    id: 'step',
    paint: {
      'line-gradient': ['step', ['line-progress'], '#2040ff', 0.3, '#20e040', 0.7, '#ff3020']
    }
  }
];

/**
 * The most the median pixel both renderers draw may differ, as the sum of its RGB differences.
 * Measured: 0 or 1. In `line-color`, over 200.
 */
const MEDIAN_PIXEL_TOLERANCE = 24;

/**
 * The most the 95th percentile of those differences may be, at the lines' antialiased edges.
 * Measured: 6 to 13. In `line-color`, over 200.
 */
const P95_PIXEL_TOLERANCE = 40;

/** The least share of the pixels either renderer draws on that both draw on. Measured: 0.99. */
const MIN_OVERLAP = 0.9;

function getStyle(paint: Record<string, unknown>): any {
  return {
    version: 8,
    sources: {routes: {type: 'geojson', data: DATA, lineMetrics: true}},
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#000000'}},
      {
        id: 'routes',
        type: 'line',
        source: 'routes',
        layout: {'line-cap': 'butt', 'line-join': 'round'},
        paint: {'line-color': '#ffffff', 'line-width': 10, ...paint}
      }
    ]
  };
}

/**
 * Over the pixels either render draws on (not black): the share both draw, and the median and 95th
 * percentile of the summed RGB differences of the pixels both draw.
 */
function compareDrawnPixels(reference: Uint8ClampedArray, candidate: Uint8ClampedArray) {
  const differences: number[] = [];
  let either = 0;
  for (let index = 0; index < reference.length; index += 4) {
    const drawn = (pixels: Uint8ClampedArray) =>
      pixels[index] + pixels[index + 1] + pixels[index + 2] > 48;
    const inReference = drawn(reference);
    const inCandidate = drawn(candidate);
    if (inReference || inCandidate) either++;
    if (inReference && inCandidate) {
      let difference = 0;
      for (let channel = 0; channel < 3; channel++) {
        difference += Math.abs(reference[index + channel] - candidate[index + channel]);
      }
      differences.push(difference);
    }
  }
  differences.sort((a, b) => a - b);
  const percentile = (share: number) => differences[Math.floor(differences.length * share)] ?? 0;
  return {
    either,
    overlap: differences.length / Math.max(either, 1),
    medianDifference: percentile(0.5),
    p95Difference: percentile(0.95)
  };
}

describe('line-gradient', () => {
  test.each(CASES)('$id', async ({id, paint, dashed}) => {
    const style = getStyle(paint);
    const reference = await renderMapLibre(structuredClone(style), SCENE);
    const candidate = await renderBasemapLayer(structuredClone(style), SCENE);
    const plainStyle = structuredClone(style);
    delete plainStyle.layers[1].paint['line-gradient'];
    const plain = await renderBasemapLayer(plainStyle, SCENE);
    expect(reference.problems).toEqual([]);
    expect(candidate.problems).toEqual([]);

    const gradient = compareDrawnPixels(reference.pixels, candidate.pixels);
    const control = compareDrawnPixels(reference.pixels, plain.pixels);
    if (OUTPUT) {
      await writeComparison(
        `line-gradient-${id}`,
        [reference.pixels, candidate.pixels, plain.pixels],
        {gradient, control}
      );
    }
    expect(gradient.either, 'pixels either renderer draws').toBeGreaterThan(10_000);
    expect(gradient.medianDifference).toBeLessThanOrEqual(MEDIAN_PIXEL_TOLERANCE);
    if (dashed) {
      expect(Math.abs(gradient.overlap - control.overlap), 'dashes moved').toBeLessThan(0.02);
    } else {
      expect(gradient.overlap, 'share of drawn pixels both draw').toBeGreaterThanOrEqual(
        MIN_OVERLAP
      );
      expect(gradient.p95Difference).toBeLessThanOrEqual(P95_PIXEL_TOLERANCE);
    }
    expect(control.medianDifference, 'line-color differs').toBeGreaterThan(
      4 * MEDIAN_PIXEL_TOLERANCE
    );
  }, 120_000);
});

describe('line-gradient with every other line attribute', () => {
  test('links and draws with an offset, dashes and a blur per feature', async () => {
    // Dashes, an offset, a gradient and a per-feature blur need more vertex attributes than
    // WebGL2 guarantees: the line draws without its dashes and its blur, but draws.
    const style = getStyle({
      'line-gradient': RAINBOW,
      'line-offset': 4,
      'line-dasharray': [3, 1],
      'line-blur': ['coalesce', ['get', 'blur'], 1]
    });
    const candidate = await renderBasemapLayer(style, SCENE);
    expect(candidate.problems).toEqual([]);
    let drawn = 0;
    for (let index = 0; index < candidate.pixels.length; index += 4) {
      const [r, g, b] = candidate.pixels.subarray(index, index + 3);
      drawn += r + g + b > 48 ? 1 : 0;
    }
    expect(drawn).toBeGreaterThan(10_000);
  }, 120_000);
});
