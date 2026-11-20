// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `icon-text-fit` stretches icons over their labels as MapLibre GL JS stretches them. Three
 * points, each with an image of the `sprites/icon-text-fit` fixture, are drawn with both
 * renderers: a stretchable shield (`stretchX`, `stretchY`, `content`), an image without metadata,
 * and an image with `content` only. Each image is drawn in flat colors, so each pixel tells which
 * part of which image covers it, and the two renders are compared part by part. The text itself is
 * transparent, so only the icons are compared. As a control, the first case's icons drawn without
 * `icon-text-fit` must not match MapLibre's. With `VITE_ICON_TEXT_FIT_OUTPUT=1`, the renders are
 * written to `__output__/`.
 */

import {describe, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {loadReferenceStyle, toFixtureUrl} from './fixtures';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import {VIEWPORT, type ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_ICON_TEXT_FIT_OUTPUT === '1';

const SCENE: ReferenceScene = {
  id: 'icon-text-fit-z2',
  style: 'ofm-positron',
  center: [0, 0],
  zoom: 2
};

const POINTS: {coordinates: [number, number]; icon: string}[] = [
  {coordinates: [-25, 20], icon: 'shield'},
  {coordinates: [25, 20], icon: 'plain'},
  {coordinates: [0, -25], icon: 'framed'}
];

/** `control`: also draw the icons without `icon-text-fit`, which must not match MapLibre's. */
type FitCase = {id: string; layout: Record<string, unknown>; control?: boolean};

const CASES: FitCase[] = [
  {
    id: 'both, padded',
    layout: {'icon-text-fit': 'both', 'icon-text-fit-padding': [4, 8, 4, 8]},
    control: true
  },
  {id: 'width', layout: {'icon-text-fit': 'width', 'icon-text-fit-padding': [0, 6, 0, 6]}},
  {id: 'height', layout: {'icon-text-fit': 'height', 'icon-text-fit-padding': [3, 0, 3, 0]}},
  {
    id: 'both, icon-size and icon-offset',
    layout: {'icon-text-fit': 'both', 'icon-size': 1.5, 'icon-offset': [0, 4]}
  }
];

/** The flat colors of the fixture's images, after the black background. */
const COLORS = [
  [0, 0, 0],
  [255, 255, 0],
  [255, 0, 0],
  [0, 0, 255],
  [0, 255, 0],
  [255, 255, 255],
  [0, 255, 255],
  [255, 0, 255]
];

/**
 * The least share of the pixels either renderer draws an image part on that both draw the same
 * part on: 0.97 to 0.98 measured. `BasemapLayer` samples sprites linearly, where MapLibre samples
 * icons at rest by nearest texel, so the edges between colors blend over a stretched texel.
 */
const MIN_OVERLAP = 0.9;

async function getStyle(layout: Record<string, unknown>): Promise<any> {
  const reference = await loadReferenceStyle(SCENE.style);
  return {
    version: 8,
    glyphs: reference.glyphs,
    sprite: toFixtureUrl('https://sprites/icon-text-fit'),
    sources: {
      points: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: POINTS.map(({coordinates, icon}) => ({
            type: 'Feature',
            geometry: {type: 'Point', coordinates},
            properties: {icon}
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
          'text-field': 'Wide label',
          'text-font': ['Noto Sans Regular'],
          'text-size': 20,
          'icon-image': ['get', 'icon'],
          'text-allow-overlap': true,
          'icon-allow-overlap': true,
          ...layout
        },
        paint: {'text-opacity': 0}
      }
    ]
  };
}

/**
 * The image color a pixel shows, as an index into `COLORS`: the nearest, so that a blend between
 * two colors splits at its middle. 0 is the background.
 */
function getColor(pixels: Uint8ClampedArray, index: number): number {
  let nearest = 0;
  let nearestDistance = Infinity;
  for (let color = 0; color < COLORS.length; color++) {
    const [r, g, b] = COLORS[color];
    const distance =
      (pixels[index] - r) ** 2 + (pixels[index + 1] - g) ** 2 + (pixels[index + 2] - b) ** 2;
    if (distance < nearestDistance) {
      nearest = color;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** The share of the pixels either render shows an image color on where both show the same. */
function getOverlap(reference: Uint8ClampedArray, candidate: Uint8ClampedArray) {
  let either = 0;
  let both = 0;
  for (let index = 0; index < reference.length; index += 4) {
    const inReference = getColor(reference, index);
    const inCandidate = getColor(candidate, index);
    if (inReference || inCandidate) either++;
    if (inReference && inReference === inCandidate) both++;
  }
  return {either, overlap: both / Math.max(either, 1)};
}

async function writePng(name: string, pixels: Uint8ClampedArray): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = VIEWPORT.width;
  canvas.height = VIEWPORT.height;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels), VIEWPORT.width), 0, 0);
  const base64 = canvas.toDataURL('image/png').split(',')[1];
  const directory = 'modules/basemap-layers/test/reference-render/__output__';
  await commands.writeFile(`${directory}/${name}.png`, base64, 'base64');
}

describe('icon-text-fit', () => {
  test.each(CASES)('$id', async ({id, layout, control}) => {
    const style = await getStyle(layout);
    const reference = await renderMapLibre(structuredClone(style), SCENE);
    const candidate = await renderBasemapLayer(structuredClone(style), SCENE);
    expect(reference.problems).toEqual([]);
    expect(candidate.problems).toEqual([]);
    const fitted = getOverlap(reference.pixels, candidate.pixels);
    const name = `icon-text-fit-${id.replace(/\W+/g, '-')}`;
    if (OUTPUT) {
      await writePng(`${name}-maplibre`, reference.pixels);
      await writePng(`${name}-basemap`, candidate.pixels);
      console.log(name, JSON.stringify(fitted));
    }
    expect(fitted.either, 'pixels either renderer draws an icon on').toBeGreaterThan(2_000);
    expect(fitted.overlap, 'share of icon pixels both draw alike').toBeGreaterThanOrEqual(
      MIN_OVERLAP
    );
    if (control) {
      const unfittedStyle = structuredClone(style);
      unfittedStyle.layers[1].layout['icon-text-fit'] = 'none';
      const unfitted = await renderBasemapLayer(unfittedStyle, SCENE);
      if (OUTPUT) {
        await writePng(`${name}-unfitted`, unfitted.pixels);
      }
      // 0.02 measured.
      expect(getOverlap(reference.pixels, unfitted.pixels).overlap, 'unfitted icons').toBeLessThan(
        0.5
      );
    }
  }, 240_000);
});
