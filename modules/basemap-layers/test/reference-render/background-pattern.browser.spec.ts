// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `background-pattern` draws as MapLibre GL JS draws it: the sprite image repeated across the
 * whole map, anchored to the map, at its CSS-pixel size at the integer zoom, scaled with the map
 * between integer zooms, times `background-opacity`. Each case draws a style of only a patterned
 * background with both renderers and compares every pixel. As a control, the same background in
 * `background-color` must differ. With `VITE_BACKGROUND_PATTERN_OUTPUT=1`, the renders and the
 * measured values of each case are written to `__output__/`.
 */

import {describe, expect, test} from 'vitest';
import {writeComparison} from './comparison-output';
import {loadReferenceStyle} from './fixtures';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import {VIEWPORT, type ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_BACKGROUND_PATTERN_OUTPUT === '1';

const SCENE: ReferenceScene = {
  id: 'background-pattern-z3.3',
  style: 'ofm-liberty',
  center: [10, 45],
  zoom: 3.3
};

type PatternCase = {
  id: string;
  paint: Record<string, unknown>;
  zoom?: number;
};

/**
 * `us-highway_3` (21 x 17 pixels, its top unlike its bottom) and `road_4` (31 x 14), from the
 * style's sprite. Neither size divides the world's size in pixels, so a pattern anchored anywhere
 * but MapLibre's origin, or flipped, draws its repeats elsewhere.
 */
const CASES: PatternCase[] = [
  {id: 'highway shield', paint: {'background-pattern': 'us-highway_3'}},
  {id: 'road shield', paint: {'background-pattern': 'road_4'}},
  {id: 'half opacity', paint: {'background-pattern': 'road_4', 'background-opacity': 0.5}},
  // Between integer zooms, the pattern scales with the map: 2^0.8 times its size here.
  {id: 'scaled between integer zooms, z3.8', paint: {'background-pattern': 'road_4'}, zoom: 3.8},
  // Far from the map's origin in pixels, where single precision would misplace the repeats.
  {id: 'high zoom, z16.3', paint: {'background-pattern': 'us-highway_3'}, zoom: 16.3},
  // The image of the integer zoom, at rest: MapLibre cross-fades from the previous one only for
  // its `fadeDuration` after the zoom crosses an integer.
  {
    id: 'image by zoom, z4.2',
    paint: {'background-pattern': ['step', ['zoom'], 'road_4', 4, 'us-highway_3']},
    zoom: 4.2
  }
];

/**
 * The most the median pixel may differ, as the sum of its RGB differences. Measured: 0.
 */
const MEDIAN_PIXEL_TOLERANCE = 24;

/**
 * The most the 95th percentile of those differences may be, at the edges of the images. Measured:
 * 2 to 15. In `background-color`, 189 to 383; with the rows placed from the bottom of the world
 * instead of the top, 300 to 384.
 */
const P95_PIXEL_TOLERANCE = 60;

async function getStyle(paint: Record<string, unknown>): Promise<any> {
  const {sprite} = await loadReferenceStyle(SCENE.style);
  return {
    version: 8,
    sprite,
    // A source of no features: a render is complete once the tiles of its sources have loaded.
    sources: {empty: {type: 'geojson', data: {type: 'FeatureCollection', features: []}}},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {'background-color': '#ff00ff', ...paint}
      },
      {id: 'empty', type: 'line', source: 'empty'}
    ]
  };
}

/**
 * The median and 95th percentile of the summed RGB differences of the pixels of `reference` and
 * `candidate` in the columns from `left`, with `candidate` read `shift` columns to the right.
 */
function comparePixels(
  reference: Uint8ClampedArray,
  candidate: Uint8ClampedArray,
  {shift = 0, left = 0}: {shift?: number; left?: number} = {}
) {
  const {width, height} = VIEWPORT;
  const differences: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = left; x < width - shift; x++) {
      const r = (y * width + x) * 4;
      const c = (y * width + x + shift) * 4;
      let difference = 0;
      for (let channel = 0; channel < 3; channel++) {
        difference += Math.abs(reference[r + channel] - candidate[c + channel]);
      }
      differences.push(difference);
    }
  }
  differences.sort((a, b) => a - b);
  const percentile = (share: number) => differences[Math.floor(differences.length * share)] ?? 0;
  return {medianDifference: percentile(0.5), p95Difference: percentile(0.95)};
}

function expectWithinTolerance(
  label: string,
  comparison: {medianDifference: number; p95Difference: number}
) {
  expect(comparison.medianDifference, `${label}: median`).toBeLessThanOrEqual(
    MEDIAN_PIXEL_TOLERANCE
  );
  expect(comparison.p95Difference, `${label}: 95th percentile`).toBeLessThanOrEqual(
    P95_PIXEL_TOLERANCE
  );
}

describe('background-pattern', () => {
  test.each(CASES)('$id', async ({id, paint, zoom}) => {
    const scene = zoom ? {...SCENE, zoom} : SCENE;
    const style = await getStyle(paint);
    const reference = await renderMapLibre(structuredClone(style), scene);
    const candidate = await renderBasemapLayer(structuredClone(style), scene);
    const plainStyle = structuredClone(style);
    delete plainStyle.layers[0].paint['background-pattern'];
    const plain = await renderBasemapLayer(plainStyle, scene);
    expect(reference.problems).toEqual([]);
    expect(candidate.problems).toEqual([]);

    const pattern = comparePixels(reference.pixels, candidate.pixels);
    const control = comparePixels(reference.pixels, plain.pixels);
    if (OUTPUT) {
      await writeComparison(
        `background-pattern-${id}`,
        [reference.pixels, candidate.pixels, plain.pixels],
        {pattern, control}
      );
    }
    expectWithinTolerance(id, pattern);
    expect(control.p95Difference, 'background-color differs').toBeGreaterThan(
      2 * P95_PIXEL_TOLERANCE
    );
  }, 120_000);

  test('stays anchored to the map when the map pans', async () => {
    // East by 50 pixels, which is no whole number of either image's repeats.
    const PAN = 50;
    const style = await getStyle({'background-pattern': 'us-highway_3'});
    const panned: ReferenceScene = {
      ...SCENE,
      center: [SCENE.center[0] + (PAN * 360) / (512 * 2 ** SCENE.zoom), SCENE.center[1]]
    };
    const before = await renderBasemapLayer(structuredClone(style), SCENE);
    const after = await renderBasemapLayer(structuredClone(style), panned);
    const reference = await renderMapLibre(structuredClone(style), panned);
    expect(after.problems).toEqual([]);
    expect(reference.problems).toEqual([]);

    // The pattern moves with the map: what was `PAN` pixels to the right is now at each pixel.
    const moved = comparePixels(after.pixels, before.pixels, {shift: PAN});
    // A control: in place, the pattern does not match, so the pan moved it.
    const inPlace = comparePixels(after.pixels, before.pixels, {left: PAN});
    const matchesMapLibre = comparePixels(reference.pixels, after.pixels);
    if (OUTPUT) {
      await writeComparison(
        'background-pattern-pan',
        [reference.pixels, after.pixels, before.pixels],
        {moved, inPlace, matchesMapLibre}
      );
    }
    expectWithinTolerance('moved with the map', moved);
    expectWithinTolerance('panned, against MapLibre', matchesMapLibre);
    expect(inPlace.p95Difference, 'the pan moves the pattern').toBeGreaterThan(
      2 * P95_PIXEL_TOLERANCE
    );
  }, 120_000);
});
