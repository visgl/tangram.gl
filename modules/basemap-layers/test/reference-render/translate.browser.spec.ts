// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `fill-translate`, `line-translate`, `circle-translate` and `fill-extrusion-translate`, with their
 * `map` and `viewport` anchors, draw where MapLibre GL JS draws them on a map turned by a bearing.
 * The anchors differ only on a turned map: a `map` offset turns with the map, a `viewport` offset
 * keeps its direction on the screen.
 *
 * Each case draws one style layer of a GeoJSON source over black, translated 48 px, with both
 * renderers, and measures the share of the pixels either draws on that both draw on. As a control,
 * MapLibre with the other anchor must overlap MapLibre with this one much less. With
 * `VITE_TRANSLATE_OUTPUT=1`, each case's renders are written to `__output__/`.
 */

import {describe, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import {VIEWPORT, type ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_TRANSLATE_OUTPUT === '1';

/** The shapes lie in one zoom 5 tile (longitude 0 to 11.25, latitude 41 to 49). */
const SCENE: ReferenceScene = {
  id: 'translate-z5.3',
  style: 'ofm-positron',
  center: [5.6, 45],
  zoom: 5.3
};

/** The bearing: 60 degrees, so that the anchors' offsets lie 48 px apart. */
const BEARING = 60;
const TRANSLATE = [48, 0];

/** The least share of the pixels either renderer draws on that both draw on. */
const MIN_OVERLAP = 0.9;
/** The most that MapLibre's renders with the two anchors may overlap: the control. */
const MAX_CONTROL_OVERLAP = 0.5;

const square = (lng: number, lat: number, size: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng - size, lat - size],
      [lng + size, lat - size],
      [lng + size, lat + size],
      [lng - size, lat + size],
      [lng - size, lat - size]
    ]
  ]
});

type TranslateCase = {
  id: string;
  type: 'fill' | 'line' | 'circle' | 'fill-extrusion';
  geometry: object;
  paint: Record<string, unknown>;
};

const CASES: TranslateCase[] = [
  {
    id: 'fill',
    type: 'fill',
    geometry: square(5.6, 45, 0.8),
    paint: {'fill-color': '#d04030', 'fill-antialias': false}
  },
  {
    id: 'line',
    type: 'line',
    geometry: {
      type: 'LineString',
      coordinates: [
        [4, 44],
        [5.6, 45.6],
        [7.2, 44]
      ]
    },
    paint: {'line-color': '#e0c020', 'line-width': 8}
  },
  {
    id: 'circle',
    type: 'circle',
    geometry: {type: 'Point', coordinates: [5.6, 45]},
    paint: {'circle-color': '#40d070', 'circle-radius': 18}
  },
  {
    id: 'fill-extrusion',
    type: 'fill-extrusion',
    geometry: square(5.6, 45, 0.8),
    paint: {
      'fill-extrusion-color': '#4080e0',
      'fill-extrusion-height': 1000,
      'fill-extrusion-vertical-gradient': false
    }
  }
];

function getStyle({type, geometry, paint}: TranslateCase, anchor: 'map' | 'viewport'): any {
  return {
    version: 8,
    sources: {
      shapes: {
        type: 'geojson',
        data: {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry}]}
      }
    },
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#000000'}},
      {
        id: 'shape',
        type,
        source: 'shapes',
        paint: {
          ...paint,
          [`${type}-translate`]: TRANSLATE,
          [`${type}-translate-anchor`]: anchor
        }
      }
    ]
  };
}

/** The share of the pixels that are not black in either render that are not black in both. */
function getOverlap(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let either = 0;
  let both = 0;
  let inA = 0;
  for (let index = 0; index < a.length; index += 4) {
    const drawn = (pixels: Uint8ClampedArray) =>
      pixels[index] + pixels[index + 1] + pixels[index + 2] > 24;
    const drawnA = drawn(a);
    const drawnB = drawn(b);
    if (drawnA) inA++;
    if (drawnA || drawnB) either++;
    if (drawnA && drawnB) both++;
  }
  return {overlap: both / Math.max(either, 1), drawn: inA};
}

async function writeComparison(name: string, images: Uint8ClampedArray[]) {
  const {width, height} = VIEWPORT;
  const canvas = document.createElement('canvas');
  canvas.width = width * images.length;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  images.forEach((pixels, i) => {
    context.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), width * i, 0);
  });
  await commands.writeFile(
    `modules/basemap-layers/test/reference-render/__output__/translate-${name}.png`,
    canvas.toDataURL('image/png').split(',')[1],
    'base64'
  );
}

describe('translate paint properties on a turned map', () => {
  test.each(CASES)('$id-translate', async translateCase => {
    const options = {bearing: BEARING};
    const reference = {
      map: await renderMapLibre(getStyle(translateCase, 'map'), SCENE, options),
      viewport: await renderMapLibre(getStyle(translateCase, 'viewport'), SCENE, options)
    };
    const control = getOverlap(reference.map.pixels, reference.viewport.pixels);
    expect(control.drawn, 'pixels MapLibre draws').toBeGreaterThan(500);
    expect(control.overlap, 'overlap of the two anchors in MapLibre').toBeLessThan(
      MAX_CONTROL_OVERLAP
    );
    for (const anchor of ['map', 'viewport'] as const) {
      const candidate = await renderBasemapLayer(
        getStyle(translateCase, anchor),
        SCENE,
        {},
        options
      );
      if (OUTPUT) {
        await writeComparison(`${translateCase.id}-${anchor}`, [
          reference[anchor].pixels,
          candidate.pixels
        ]);
      }
      expect(reference[anchor].problems).toEqual([]);
      expect(candidate.problems).toEqual([]);
      expect(
        getOverlap(reference[anchor].pixels, candidate.pixels).overlap,
        `${anchor} anchor: share of drawn pixels both draw`
      ).toBeGreaterThanOrEqual(MIN_OVERLAP);
    }
  }, 600_000);
});
