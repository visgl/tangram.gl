// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Compares a style updated in place of another with MapLibre GL JS's render of the new style. The
 * `BasemapLayer` first draws the scene's background and water, and then a copy of them with a new
 * water color. The update loads nothing, and must draw what MapLibre draws from the new style.
 */

import type {Deck} from '@deck.gl/core';
import {expect, test} from 'vitest';
import {loadReferenceStyle} from './fixtures';
import {toGray} from '../../../../dev/basemap-conformance/src/metrics';
import {renderBasemapLayer, renderMapLibre} from './renderers';
import {DEFAULT_SCENES, VIEWPORT} from './scenes';

const SCENE = DEFAULT_SCENES.find(scene => scene.id === 'europe-liberty-z5.2')!;
const WATER = '#ff00ff';

/** The pixels of the deck's canvas composited on white, read in its `onAfterRender`. */
function readCanvas(source: HTMLCanvasElement): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = VIEWPORT.width;
  canvas.height = VIEWPORT.height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

/**
 * Gives the deck's basemap `style`, and reads the frame drawn once its layers have loaded, with the
 * number of resources requested in between.
 */
function updateStyle(
  deck: Deck<any>,
  style: unknown
): Promise<{pixels: Uint8ClampedArray; requests: number}> {
  const requests = performance.getEntriesByType('resource').length;
  const [basemap] = deck.props.layers as any[];
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('Style update timed out')), 30_000);
    let settled = 0;
    deck.setProps({
      layers: [basemap.clone({style})],
      onAfterRender: () => {
        const layers = (deck as any).layerManager.getLayers();
        if (!layers.every((layer: any) => layer.isLoaded) || settled++ < 3) {
          deck.redraw('style update settle');
          return;
        }
        window.clearTimeout(timer);
        resolve({
          pixels: readCanvas(deck.getCanvas()!),
          requests: performance.getEntriesByType('resource').length - requests
        });
      }
    });
  });
}

function getMeanDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  const {width, height} = VIEWPORT;
  const grayA = toGray(a, width, height).data;
  const grayB = toGray(b, width, height).data;
  let sum = 0;
  for (let i = 0; i < grayA.length; i++) {
    sum += Math.abs(grayA[i] - grayB[i]);
  }
  return sum / grayA.length;
}

/** The number of pixels in the new water color. */
function countWater(pixels: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > 200 && pixels[i + 1] < 60 && pixels[i + 2] > 200) count++;
  }
  return count;
}

/**
 * The mean difference from MapLibre's pixels after the update, in gray levels of 255. The update
 * and a new `BasemapLayer` of the new style both measure 0.06; the old water color measures 2.6.
 */
const MAX_MEAN_DIFFERENCE = 0.5;

test('a new water color draws as MapLibre draws the new style, and loads nothing', async () => {
  // The background and the fills of the water only: the update, not the labels, is measured.
  const style = await loadReferenceStyle(SCENE.style);
  style.layers = style.layers.filter(
    (layer: {id: string}) => layer.id === 'background' || layer.id === 'water'
  );
  const updated = structuredClone(style);
  const water = updated.layers.find((layer: any) => layer.id === 'water');
  expect(water.type).toBe('fill');
  water.paint = {...water.paint, 'fill-color': WATER};

  const reference = await renderMapLibre(structuredClone(updated), SCENE);
  let update: {pixels: Uint8ClampedArray; requests: number} | null = null;
  const before = await renderBasemapLayer(
    structuredClone(style),
    SCENE,
    {},
    {
      onRendered: async deck => {
        update = await updateStyle(deck, structuredClone(updated));
      }
    }
  );
  expect(before.problems).toEqual([]);
  expect(countWater(before.pixels)).toBe(0);
  const {pixels, requests} = update!;
  expect(requests).toBe(0);
  // The water of the update is MapLibre's, within 5%.
  const referenceWater = countWater(reference.pixels);
  expect(referenceWater).toBeGreaterThan(5000);
  expect(Math.abs(countWater(pixels) - referenceWater)).toBeLessThan(referenceWater * 0.05);
  expect(getMeanDifference(pixels, reference.pixels)).toBeLessThan(MAX_MEAN_DIFFERENCE);
}, 120_000);
