// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `line-pattern` draws as MapLibre GL JS draws it: the sprite image stretched across the line and
 * repeated along it from each tiled line's start, at its own aspect ratio and the `line-width` of
 * the integer zoom. Each case draws lines over black with both renderers and compares the colors
 * of the pixels both draw on. As a control, the same lines drawn without the pattern, in
 * `line-color`, must differ. With `VITE_LINE_PATTERN_OUTPUT=1`, the renders and the measured values
 * of each case are written to `__output__/`.
 */

import {describe, expect, test} from 'vitest';
import {writeComparison} from './comparison-output';
import {loadReferenceStyle} from './fixtures';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import type {ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_LINE_PATTERN_OUTPUT === '1';

/** Over Europe, where the lines cross the zoom 3 tile edges at longitude 0 and latitude 41. */
const SCENE: ReferenceScene = {
  id: 'line-pattern-europe-z3.3',
  style: 'ofm-liberty',
  center: [10, 45],
  zoom: 3.3
};

/** Lines across both tile edges, with bends, running each way. */
const DATA = {
  type: 'FeatureCollection',
  features: [
    [
      [-8, 36],
      [4, 50],
      [16, 44],
      [28, 54]
    ],
    [
      [26, 58],
      [-6, 56]
    ],
    [
      [-4, 33],
      [26, 37]
    ]
  ].map(coordinates => ({
    type: 'Feature',
    geometry: {type: 'LineString', coordinates},
    properties: {}
  }))
};

type PatternCase = {
  id: string;
  paint: Record<string, unknown>;
  zoom?: number;
};

/**
 * `road_4` (31 x 14 pixels), `arrow` (10 x 7) and `us-highway_3` (21 x 17, its top unlike its
 * bottom), from the style's sprite.
 */
const CASES: PatternCase[] = [
  {id: 'road shield', paint: {'line-pattern': 'road_4', 'line-width': 14}},
  {id: 'arrow, narrow', paint: {'line-pattern': 'arrow', 'line-width': 7}},
  {id: 'highway shield', paint: {'line-pattern': 'us-highway_3', 'line-width': 17}},
  {id: 'half opacity', paint: {'line-pattern': 'road_4', 'line-width': 14, 'line-opacity': 0.5}},
  {
    // Between integer zooms, the repeats are measured in the line-width of the integer zoom: 8
    // pixels, on a line 14 wide. (At z3.5, where this layer evaluates its width as MapLibre does.)
    id: 'width by zoom, z3.5',
    paint: {
      'line-pattern': 'road_4',
      'line-width': ['interpolate', ['linear'], ['zoom'], 3, 8, 4, 20]
    },
    zoom: 3.5
  }
];

/**
 * The most the median pixel both renderers draw may differ, as the sum of its RGB differences.
 * Measured: 0 to 6.
 */
const MEDIAN_PIXEL_TOLERANCE = 24;

/**
 * The most the 95th percentile of those differences may be, at the edges of the images and of the
 * lines. Measured: 13 to 33. In `line-color`, 209 to 708.
 */
const P95_PIXEL_TOLERANCE = 60;

/**
 * The least share of the pixels either renderer draws on that both draw on. Measured: 0.95 to
 * 0.99.
 */
const MIN_OVERLAP = 0.9;

async function getStyle(paint: Record<string, unknown>): Promise<any> {
  const {sprite} = await loadReferenceStyle(SCENE.style);
  return {
    version: 8,
    sprite,
    sources: {routes: {type: 'geojson', data: DATA}},
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#000000'}},
      {
        id: 'routes',
        type: 'line',
        source: 'routes',
        layout: {'line-cap': 'butt', 'line-join': 'round'},
        paint: {'line-color': '#ffffff', ...paint}
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

describe('line-pattern', () => {
  test.each(CASES)('$id', async ({id, paint, zoom}) => {
    const scene = zoom ? {...SCENE, zoom} : SCENE;
    const style = await getStyle(paint);
    const reference = await renderMapLibre(structuredClone(style), scene);
    const candidate = await renderBasemapLayer(structuredClone(style), scene);
    const plainStyle = structuredClone(style);
    delete plainStyle.layers[1].paint['line-pattern'];
    const plain = await renderBasemapLayer(plainStyle, scene);
    expect(reference.problems).toEqual([]);
    expect(candidate.problems).toEqual([]);

    const pattern = compareDrawnPixels(reference.pixels, candidate.pixels);
    const control = compareDrawnPixels(reference.pixels, plain.pixels);
    if (OUTPUT) {
      await writeComparison(
        `line-pattern-${id}`,
        [reference.pixels, candidate.pixels, plain.pixels],
        {pattern, control}
      );
    }
    expect(pattern.either, 'pixels either renderer draws').toBeGreaterThan(2_000);
    expect(pattern.overlap, 'share of drawn pixels both draw').toBeGreaterThanOrEqual(MIN_OVERLAP);
    expect(pattern.medianDifference).toBeLessThanOrEqual(MEDIAN_PIXEL_TOLERANCE);
    expect(pattern.p95Difference).toBeLessThanOrEqual(P95_PIXEL_TOLERANCE);
    expect(control.p95Difference, 'line-color differs').toBeGreaterThan(2 * P95_PIXEL_TOLERANCE);
  }, 120_000);
});

describe('line-pattern with every other line attribute', () => {
  test('links and draws with an offset, a gap, dashes and a blur per feature', async () => {
    // A pattern and an offset leave no vertex attribute for a per-feature blur, which is dropped;
    // dashes are not drawn with a pattern. The line must still link and draw.
    const style = await getStyle({
      'line-pattern': 'road_4',
      'line-width': 14,
      'line-offset': 4,
      'line-gap-width': 2,
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
    expect(drawn).toBeGreaterThan(5_000);
  }, 120_000);
});
