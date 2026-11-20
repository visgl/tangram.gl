// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `["feature-state", ...]` in paint draws as MapLibre GL JS draws it after `setFeatureState`.
 *
 * A GeoJSON source of squares, lines and points, whose fill color, line color and width, and
 * circle color and radius read a `hover` state, is rendered with states set on some features,
 * by MapLibre (`setFeatureState`) and by `BasemapLayer` (`featureState`), and the pixels either
 * renderer draws on are compared. With `VITE_FEATURE_STATE_OUTPUT=1`, a comparison image and the
 * measured values are written to `__output__/`.
 */

import * as maplibregl from 'maplibre-gl';
import {afterAll, describe, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {renderBasemapLayer} from './renderers';
import {VIEWPORT, type ReferenceScene} from './scenes';

const env = (import.meta as any).env || {};
const OUTPUT = env.VITE_FEATURE_STATE_OUTPUT === '1';
const OUTPUT_DIR = 'modules/basemap-layers/test/reference-render/__output__';

const SCENE: ReferenceScene = {
  id: 'feature-state-z4',
  style: 'ofm-positron',
  center: [10, 45],
  zoom: 4
};

/** As in the GeoJSON source comparison: summed RGB difference of the median drawn pixel. */
const MEDIAN_PIXEL_TOLERANCE = 6;
/** The most the mean color of the drawn pixels may differ from MapLibre's, per channel (0-255). */
const MEAN_TOLERANCE = 8;
/** The least share of the pixels either renderer draws on that both draw on. */
const MIN_OVERLAP = 0.95;

const square = (lng: number, lat: number) => [
  [
    [lng, lat],
    [lng + 4, lat],
    [lng + 4, lat + 3],
    [lng, lat + 3],
    [lng, lat]
  ]
];

/** Squares, lines and points; features 2, 5 and 8 are hovered. */
const DATA = {
  type: 'FeatureCollection',
  features: [
    ...[0, 1, 2].map(index => ({
      type: 'Feature',
      id: index + 1,
      properties: {kind: 'area'},
      geometry: {type: 'Polygon', coordinates: square(-2 + index * 6, 48)}
    })),
    ...[0, 1, 2].map(index => ({
      type: 'Feature',
      id: index + 4,
      properties: {kind: 'route'},
      geometry: {
        type: 'LineString',
        coordinates: [
          [-4, 45 - index * 2],
          [24, 45 - index * 2]
        ]
      }
    })),
    ...[0, 1, 2].map(index => ({
      type: 'Feature',
      id: index + 7,
      properties: {kind: 'stop'},
      geometry: {type: 'Point', coordinates: [0 + index * 8, 38]}
    }))
  ]
};

const HOVERED = [2, 5, 8];

const hover = (on: unknown, off: unknown) => [
  'case',
  ['boolean', ['feature-state', 'hover'], false],
  on,
  off
];

const STYLE = {
  version: 8,
  sources: {shapes: {type: 'geojson', data: DATA}},
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#000000'}},
    {
      id: 'areas',
      type: 'fill',
      source: 'shapes',
      filter: ['==', ['get', 'kind'], 'area'],
      paint: {'fill-color': hover('#ff6600', '#2080d0'), 'fill-antialias': false}
    },
    {
      id: 'routes',
      type: 'line',
      source: 'shapes',
      filter: ['==', ['get', 'kind'], 'route'],
      paint: {'line-color': hover('#ffff00', '#808080'), 'line-width': hover(10, 4)}
    },
    {
      id: 'stops',
      type: 'circle',
      source: 'shapes',
      filter: ['==', ['get', 'kind'], 'stop'],
      paint: {'circle-color': hover('#ff00ff', '#40d070'), 'circle-radius': hover(16, 8)}
    }
  ]
};

/** Renders the style with MapLibre GL JS, with `hover` set on the features of `HOVERED`. */
async function renderMapLibreWithState(style: any): Promise<Uint8ClampedArray> {
  const container = document.createElement('div');
  container.style.cssText = `position: absolute; left: 0; top: 0; width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px;`;
  document.body.append(container);
  const map = new maplibregl.Map({
    container,
    style,
    center: SCENE.center,
    zoom: SCENE.zoom,
    pixelRatio: 1,
    fadeDuration: 0,
    interactive: false,
    attributionControl: false,
    canvasContextAttributes: {preserveDrawingBuffer: true}
  });
  try {
    await new Promise(resolve => map.once('load', resolve));
    for (const id of HOVERED) {
      map.setFeatureState({source: 'shapes', id}, {hover: true});
    }
    map.triggerRepaint();
    await new Promise(resolve => map.once('idle', resolve));
    const canvas = document.createElement('canvas');
    canvas.width = VIEWPORT.width;
    canvas.height = VIEWPORT.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(map.getCanvas(), 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  } finally {
    map.remove();
    container.remove();
  }
}

/**
 * Over the pixels that are not black in either render: the share both draw on, the mean RGB each
 * draws, and the median of the pixels' summed RGB differences.
 */
function compareDrawnPixels(reference: Uint8ClampedArray, candidate: Uint8ClampedArray) {
  const sums = [0, 0, 0, 0, 0, 0];
  const counts = [0, 0];
  const differences: number[] = [];
  let both = 0;
  for (let index = 0; index < reference.length; index += 4) {
    const drawn = (pixels: Uint8ClampedArray) =>
      pixels[index] + pixels[index + 1] + pixels[index + 2] > 24;
    const inReference = drawn(reference);
    const inCandidate = drawn(candidate);
    if (!inReference && !inCandidate) {
      continue;
    }
    let difference = 0;
    for (let channel = 0; channel < 3; channel++) {
      if (inReference) sums[channel] += reference[index + channel];
      if (inCandidate) sums[channel + 3] += candidate[index + channel];
      difference += Math.abs(reference[index + channel] - candidate[index + channel]);
    }
    if (inReference) counts[0]++;
    if (inCandidate) counts[1]++;
    if (inReference && inCandidate) both++;
    differences.push(difference);
  }
  differences.sort((a, b) => a - b);
  return {
    referenceDrawn: counts[0],
    candidateDrawn: counts[1],
    overlap: both / Math.max(differences.length, 1),
    reference: sums.slice(0, 3).map(sum => sum / Math.max(counts[0], 1)),
    candidate: sums.slice(3).map(sum => sum / Math.max(counts[1], 1)),
    medianDifference: differences[Math.floor(differences.length / 2)] ?? 0
  };
}

/** The pixels of a hover color. */
function countColor(pixels: Uint8ClampedArray, [r, g, b]: number[]): number {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (
      Math.abs(pixels[index] - r) < 16 &&
      Math.abs(pixels[index + 1] - g) < 16 &&
      Math.abs(pixels[index + 2] - b) < 16
    ) {
      count++;
    }
  }
  return count;
}

const HOVER_COLORS = {area: [255, 102, 0], route: [255, 255, 0], stop: [255, 0, 255]};

const measured: Record<string, unknown> = {};

describe('feature-state', () => {
  test('draws hovered features as MapLibre GL JS does after setFeatureState', async () => {
    const reference = await renderMapLibreWithState(structuredClone(STYLE));
    const candidate = await renderBasemapLayer(structuredClone(STYLE), SCENE, {
      featureState: {shapes: Object.fromEntries(HOVERED.map(id => [id, {hover: true}]))}
    });
    if (OUTPUT) {
      const {width, height} = VIEWPORT;
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height;
      const context = canvas.getContext('2d')!;
      context.putImageData(new ImageData(new Uint8ClampedArray(reference), width, height), 0, 0);
      context.putImageData(
        new ImageData(new Uint8ClampedArray(candidate.pixels), width, height),
        width,
        0
      );
      await commands.writeFile(
        `${OUTPUT_DIR}/feature-state.png`,
        canvas.toDataURL('image/png').split(',')[1],
        'base64'
      );
    }
    expect(candidate.problems).toEqual([]);

    const comparison = compareDrawnPixels(reference, candidate.pixels);
    const hoverPixels = Object.fromEntries(
      Object.entries(HOVER_COLORS).map(([kind, color]) => [
        kind,
        {maplibre: countColor(reference, color), basemap: countColor(candidate.pixels, color)}
      ])
    );
    measured.comparison = comparison;
    measured.hoverPixels = hoverPixels;
    for (const [kind, {maplibre, basemap}] of Object.entries(hoverPixels)) {
      expect(maplibre, `${kind} pixels MapLibre draws hovered`).toBeGreaterThan(200);
      expect(Math.abs(basemap - maplibre) / maplibre, `${kind} hovered pixels`).toBeLessThan(
        0.1
      );
    }
    expect(comparison.overlap, 'share of drawn pixels both draw').toBeGreaterThanOrEqual(
      MIN_OVERLAP
    );
    for (let channel = 0; channel < 3; channel++) {
      const offset = Math.abs(comparison.candidate[channel] - comparison.reference[channel]);
      expect(offset, `mean ${'RGB'[channel]} offset from MapLibre`).toBeLessThanOrEqual(
        MEAN_TOLERANCE
      );
    }
    expect(
      comparison.medianDifference,
      'median pixel difference from MapLibre'
    ).toBeLessThanOrEqual(MEDIAN_PIXEL_TOLERANCE);
  }, 120_000);

  afterAll(async () => {
    if (OUTPUT) {
      await commands.writeFile(
        `${OUTPUT_DIR}/feature-state.json`,
        `${JSON.stringify(measured, null, 2)}\n`
      );
    }
  });
});
