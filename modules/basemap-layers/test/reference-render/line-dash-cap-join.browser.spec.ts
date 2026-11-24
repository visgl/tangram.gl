// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import type {ReferenceScene} from './scenes';

const ZOOM = 5;
const WORLD_PIXELS = 512 * 2 ** ZOOM;
const TILE_CENTER = [16.5 * 512, 11.5 * 512];

function longitudeLatitude(x: number, y: number): [number, number] {
  return [
    ((TILE_CENTER[0] + x) / WORLD_PIXELS) * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (TILE_CENTER[1] + y)) / WORLD_PIXELS))) * 180) /
      Math.PI
  ];
}

// All geometry stays in one tile. At integer zoom, MapLibre's atlas and the path use the same
// dash period in screen pixels.
const SCENE: ReferenceScene = {
  id: 'line-dash-cap-join',
  style: 'ofm-positron',
  center: longitudeLatitude(0, 0),
  zoom: ZOOM
};

type Point = [number, number];
type LineStyle = {layout?: Record<string, unknown>; paint?: Record<string, unknown>};
type LineCase = {
  name: string;
  lines: Point[][];
  width: number;
  style: LineStyle;
  control: LineStyle;
  maxDisagreement: number;
  minControlDisagreement: number;
  empty?: boolean;
};

const HORIZONTAL: Point[][] = [
  [
    [-160, 0],
    [160, 0]
  ]
];
const SHORT_LINE: Point[][] = [
  [
    [-64, 0],
    [64, 0]
  ]
];
const IN_LIMIT: Point[][] = [
  [
    [-44, 64],
    [0, 0],
    [44, 64]
  ]
];
// Miter length is sqrt(27² + 66²) / 27 = 2.64 half widths. Rotate the miter so
// that both components fit inside MapLibre's packed extrusion coordinates.
const OVER_LIMIT: Point[][] = [
  ([[-27, 66], [0, 0], [27, 66]] as Point[]).map(([x, y]) => [
    (x - y) * Math.SQRT1_2,
    (x + y) * Math.SQRT1_2
  ])
];

const HIGH_MITER = {layout: {'line-join': 'miter', 'line-miter-limit': 3}};

// Measured in Chromium with SwiftShader WebGL, candidate / control XOR over union: two dash
// lengths 0 / 32.4%, odd pattern 0 / 37.5%, solid square caps 0.65 / 16.3%, dashed square caps
// 1.55 / 25.8%, zero-length square dashes 0 / 100%, zero-length round dots 2.2 / 100%, bevel
// chord 1.07 / 7.9%, default miter limit 0.66 / 24.3%, high miter limit 0.61 / 24.3%.
const CASES: LineCase[] = [
  {
    name: 'two dash lengths',
    lines: HORIZONTAL,
    width: 12,
    style: {paint: {'line-dasharray': [4, 1, 1, 1]}},
    control: {paint: {'line-dasharray': [5, 2]}},
    maxDisagreement: 0.01,
    minControlDisagreement: 0.25
  },
  {
    name: 'odd pattern wraps',
    lines: HORIZONTAL,
    width: 12,
    style: {paint: {'line-dasharray': [3, 1, 1]}},
    control: {paint: {'line-dasharray': [4, 1]}},
    maxDisagreement: 0.01,
    minControlDisagreement: 0.25
  },
  {
    name: 'solid square caps',
    lines: SHORT_LINE,
    width: 24,
    style: {layout: {'line-cap': 'square'}},
    control: {layout: {'line-cap': 'butt'}},
    maxDisagreement: 0.015,
    minControlDisagreement: 0.13
  },
  {
    name: 'square caps stretch the end segments\' dashes',
    // MapLibre keeps the endpoint's line distance on the extended cap vertices, so the dashes
    // of a capped segment stretch over its caps. The first line ends in a dash, the second in
    // a gap.
    lines: [
      [[-64, -24], [64, -24]],
      [[-64, 24], [-4, 24]]
    ],
    width: 24,
    style: {layout: {'line-cap': 'square'}, paint: {'line-dasharray': [2, 1, 1]}},
    control: {layout: {'line-cap': 'butt'}},
    maxDisagreement: 0.03,
    minControlDisagreement: 0.2
  },
  {
    name: 'zero-length square dashes draw no ink',
    lines: HORIZONTAL,
    width: 16,
    style: {layout: {'line-cap': 'square'}, paint: {'line-dasharray': [0, 2]}},
    control: {paint: {'line-dasharray': [1, 1]}},
    maxDisagreement: 0,
    minControlDisagreement: 0.99,
    empty: true
  },
  {
    name: 'zero-length round dashes draw dots',
    lines: HORIZONTAL,
    width: 16,
    style: {layout: {'line-cap': 'round'}, paint: {'line-dasharray': [0, 2]}},
    control: {layout: {'line-cap': 'square'}},
    maxDisagreement: 0.04,
    minControlDisagreement: 0.99
  },
  {
    name: 'bevel uses the chord between the outer corners',
    lines: IN_LIMIT,
    width: 48,
    style: {layout: {'line-join': 'bevel'}},
    control: HIGH_MITER,
    maxDisagreement: 0.02,
    minControlDisagreement: 0.06
  },
  {
    name: 'default miter limit bevels a sharp turn through the vertex',
    lines: OVER_LIMIT,
    width: 48,
    style: {layout: {'line-join': 'miter'}},
    control: HIGH_MITER,
    maxDisagreement: 0.015,
    minControlDisagreement: 0.2
  },
  {
    name: 'high miter limit keeps the full join',
    lines: OVER_LIMIT,
    width: 48,
    style: HIGH_MITER,
    control: {layout: {'line-join': 'miter', 'line-miter-limit': 2}},
    maxDisagreement: 0.015,
    minControlDisagreement: 0.2
  }
];

function getStyle({lines, width, style, control}: LineCase, useControl = false) {
  return {
    version: 8,
    sources: {
      lines: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: lines.map(line => ({
            type: 'Feature',
            properties: {},
            geometry: {
              type: 'LineString',
              coordinates: line.map(([x, y]) => longitudeLatitude(x, y))
            }
          }))
        }
      }
    },
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
      {
        id: 'lines',
        type: 'line',
        source: 'lines',
        layout: {...style.layout, ...(useControl && control.layout)},
        paint: {
          'line-color': '#000000',
          'line-width': width,
          ...style.paint,
          ...(useControl && control.paint)
        }
      }
    ]
  };
}

function compareInk(reference: Uint8ClampedArray, candidate: Uint8ClampedArray) {
  let inkedReference = 0;
  let union = 0;
  let xor = 0;
  for (let index = 0; index < reference.length; index += 4) {
    // Black lines on white. Threshold at half coverage to compare the silhouettes.
    const a = reference[index] < 128;
    const b = candidate[index] < 128;
    inkedReference += Number(a);
    union += Number(a || b);
    xor += Number(a !== b);
  }
  return {inkedReference, disagreement: xor / Math.max(union, 1)};
}

test.each(CASES)('$name', async lineCase => {
  const reference = await renderMapLibre(getStyle(lineCase), SCENE);
  const control = await renderMapLibre(getStyle(lineCase, true), SCENE);
  const candidate = await renderBasemapLayer(getStyle(lineCase), SCENE);
  expect(reference.problems).toEqual([]);
  expect(control.problems).toEqual([]);
  expect(candidate.problems).toEqual([]);

  const actual = compareInk(reference.pixels, candidate.pixels);
  const changed = compareInk(reference.pixels, control.pixels);
  if (lineCase.empty) {
    expect(actual.inkedReference).toBe(0);
  } else {
    expect(actual.inkedReference).toBeGreaterThan(0);
  }
  expect(changed.disagreement, 'MapLibre control XOR over union').toBeGreaterThanOrEqual(
    lineCase.minControlDisagreement
  );
  expect(actual.disagreement, 'basemap XOR over union').toBeLessThanOrEqual(lineCase.maxDisagreement);
}, 120_000);
