// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `text-rotate` turns point labels as MapLibre GL JS turns them: clockwise, about the point, with
 * their `text-anchor` and `text-offset`. Each case draws four labels from a GeoJSON source, white
 * on black, with both renderers, and compares the pixels each draws on. As a control, the same
 * labels drawn unturned must not match MapLibre's turned ones. With `VITE_TEXT_ROTATE_OUTPUT=1`,
 * the renders and the measured values of each case are written to `__output__/`.
 */

import {describe, expect, test} from 'vitest';
import {writeComparison} from './comparison-output';
import {loadReferenceStyle} from './fixtures';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import type {ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_TEXT_ROTATE_OUTPUT === '1';

const SCENE: ReferenceScene = {
  id: 'text-rotate-europe-z3.3',
  style: 'ofm-positron',
  center: [10, 45],
  zoom: 3.3
};

/** Four points, one per quadrant of the view, each with its own turn. */
const POINTS: {coordinates: [number, number]; turn: number}[] = [
  {coordinates: [-2, 52], turn: 90},
  {coordinates: [22, 52], turn: 45},
  {coordinates: [-2, 38], turn: -30},
  {coordinates: [22, 38], turn: 180}
];

type RotateCase = {id: string; layout: Record<string, unknown>};

const CASES: RotateCase[] = [
  {id: 'per feature, centred', layout: {'text-rotate': ['get', 'turn']}},
  {
    id: 'per feature, left anchor and offset',
    layout: {'text-rotate': ['get', 'turn'], 'text-anchor': 'left', 'text-offset': [1, 0.5]}
  }
];

/**
 * The least share of the pixels either renderer draws that both draw: 0.99 for both cases. Unturned
 * labels share less than 0.08 with MapLibre's turned ones.
 */
const MIN_OVERLAP = 0.9;

async function getStyle(layout: Record<string, unknown>): Promise<any> {
  const reference = await loadReferenceStyle(SCENE.style);
  return {
    version: 8,
    glyphs: reference.glyphs,
    sources: {
      points: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: POINTS.map(({coordinates, turn}) => ({
            type: 'Feature',
            geometry: {type: 'Point', coordinates},
            properties: {turn}
          }))
        }
      }
    },
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#000000'}},
      {
        id: 'labels',
        type: 'symbol',
        source: 'points',
        layout: {
          'text-field': 'Rotated label',
          'text-font': ['Noto Sans Regular'],
          'text-size': 24,
          'text-allow-overlap': true,
          ...layout
        },
        paint: {'text-color': '#ffffff'}
      }
    ]
  };
}

/** The share of the pixels either render draws on (not black) that both draw on. */
function getOverlap(reference: Uint8ClampedArray, candidate: Uint8ClampedArray) {
  let either = 0;
  let both = 0;
  for (let index = 0; index < reference.length; index += 4) {
    const drawn = (pixels: Uint8ClampedArray) =>
      pixels[index] + pixels[index + 1] + pixels[index + 2] > 192;
    const inReference = drawn(reference);
    const inCandidate = drawn(candidate);
    if (inReference || inCandidate) either++;
    if (inReference && inCandidate) both++;
  }
  return {either, overlap: both / Math.max(either, 1)};
}

describe('text-rotate', () => {
  test.each(CASES)('$id', async ({id, layout}) => {
    const style = await getStyle(layout);
    const reference = await renderMapLibre(structuredClone(style), SCENE);
    const candidate = await renderBasemapLayer(structuredClone(style), SCENE);
    const unturnedStyle = structuredClone(style);
    delete unturnedStyle.layers[1].layout['text-rotate'];
    const unturned = await renderBasemapLayer(unturnedStyle, SCENE);
    expect(reference.problems).toEqual([]);
    expect(candidate.problems).toEqual([]);

    const turned = getOverlap(reference.pixels, candidate.pixels);
    const control = getOverlap(reference.pixels, unturned.pixels);
    if (OUTPUT) {
      await writeComparison(
        `text-rotate-${id}`,
        [reference.pixels, candidate.pixels, unturned.pixels],
        {turned, control}
      );
    }
    expect(turned.either, 'pixels either renderer draws').toBeGreaterThan(2_000);
    expect(turned.overlap, 'share of drawn pixels both draw').toBeGreaterThanOrEqual(MIN_OVERLAP);
    expect(control.overlap, 'unturned labels match MapLibre less').toBeLessThan(0.3);
  }, 120_000);
});
