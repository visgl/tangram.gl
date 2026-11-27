// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * `background-pattern` on a globe and in a projected view (deck.gl's `_CustomProjectionView`),
 * which MapLibre GL JS has no reference render of: the pattern repeats across the view at the
 * size it has on the Web Mercator map of the same scale. (On a map, see
 * `reference-render/background-pattern.browser.spec.ts`.)
 */

import {
  Deck,
  MapView,
  _CustomProjectionView as CustomProjectionView,
  _GlobeView as GlobeView,
  type View
} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';
import {getStyleZoom} from '../src/projected-viewport';
import {loadReferenceStyle} from './reference-render/fixtures';
import {createStableFrameWait} from './stable-frame';

const SIZE = 384;
/** `us-highway_3` of the style's sprite: 21 x 17 pixels at pixel ratio 1. */
const IMAGE = {name: 'us-highway_3', width: 21, height: 17};

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
/** The basemap of the latest render. */
const getBasemap = (current: Deck<any>): any =>
  (current as any).layerManager.getLayers({layerIds: ['basemap']})[0];
// The sprite loads, then the pattern texture: a few more frames draw it.
const stableFrames = createStableFrameWait({
  getDeck: () => deck,
  width: SIZE,
  background: '#ffffff',
  isReady: current => Boolean(getBasemap(current)?.state.spriteAtlases?.length)
});

/** Releases the deck of the latest render. A test can render more than once. */
function release(): void {
  deck?.finalize();
  deck = null;
  stableFrames.cancel();
  parent?.remove();
  parent = null;
}

afterEach(release);

/** The gray levels of the view, and the zoom its style was evaluated at, once the sprite loaded. */
async function render(
  view: View,
  viewState: Record<string, unknown>,
  mode: 'map' | 'globe' = 'map',
  /** A view to move to once the first is drawn: the pixels are those of this view. */
  nextViewState?: Record<string, unknown>
): Promise<{gray: Float64Array; styleZoom: number}> {
  const {sprite} = await loadReferenceStyle('ofm-liberty');
  const style = {
    version: 8,
    sprite,
    sources: {},
    layers: [{id: 'background', type: 'background', paint: {'background-pattern': IMAGE.name}}]
  };
  parent = document.createElement('div');
  document.body.append(parent);
  deck = new Deck({
    parent: parent!,
    width: SIZE,
    height: SIZE,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: view,
    viewState: viewState as any,
    layers: [new BasemapLayer({id: 'basemap', mode, style: style as any})],
    ...stableFrames.deckProps,
    onError: stableFrames.fail
  });
  let image = await stableFrames.waitForStableFrame({frames: 6});
  if (nextViewState) {
    deck.setProps({viewState: nextViewState as any});
    image = await stableFrames.waitForStableFrame({frames: 6});
  }
  const gray = new Float64Array(SIZE * SIZE);
  const {data} = image;
  for (let index = 0; index < gray.length; index++) {
    gray[index] = (data[index * 4] + data[index * 4 + 1] + data[index * 4 + 2]) / 3;
  }
  const result = {gray, styleZoom: getStyleZoom(getBasemap(deck).context.viewport)};
  release();
  return result;
}

/**
 * The period, in pixels, at which the middle band of the view repeats along x or y: the lag of
 * the first autocorrelation peak after its first minimum. 0 for a view of one color.
 */
function getPeriod(gray: Float64Array, axis: 'x' | 'y'): number {
  const profile = new Float64Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    for (let j = SIZE / 3; j < (2 * SIZE) / 3; j++) {
      profile[i] += axis === 'x' ? gray[j * SIZE + i] : gray[i * SIZE + j];
    }
  }
  const mean = profile.reduce((sum, value) => sum + value, 0) / SIZE;
  const correlation = (lag: number) => {
    let sum = 0;
    for (let i = 0; i + lag < SIZE; i++) {
      sum += (profile[i] - mean) * (profile[i + lag] - mean);
    }
    return sum / (SIZE - lag);
  };
  if (correlation(0) < 1) {
    return 0;
  }
  let lag = 1;
  while (lag < SIZE / 2 && correlation(lag + 1) < correlation(lag)) {
    lag++;
  }
  // The first peak after it that comes near the highest: later peaks, at whole multiples of a
  // period of a fraction of a pixel, can be higher.
  const start = lag;
  let highest = -Infinity;
  for (let candidate = start; candidate < SIZE / 2; candidate++) {
    highest = Math.max(highest, correlation(candidate));
  }
  for (lag = start; lag < SIZE / 2; lag++) {
    if (correlation(lag) >= 0.8 * highest && correlation(lag + 1) <= correlation(lag)) {
      return lag;
    }
  }
  return 0;
}

/** The image's size in pixels on a Web Mercator map at `zoom`: scaled with the map from the integer zoom. */
function getMercatorSize(zoom: number): [number, number] {
  const scale = 2 ** (zoom - Math.floor(zoom));
  return [IMAGE.width * scale, IMAGE.height * scale];
}

describe('background-pattern in other views', () => {
  test('repeats at the size of the Web Mercator map of the same scale in a projected view', async () => {
    // UTM zone 32N around 10.5°E 48°N, where the view's own zoom differs from the Web Mercator
    // zoom of the same scale by more than 3.
    const {gray, styleZoom} = await render(
      new CustomProjectionView({id: 'projected', crs: 'EPSG:32632'}),
      {center: [537000, 5316000, 0], zoom: 7.7}
    );
    const [width, height] = getMercatorSize(styleZoom);
    expect(getPeriod(gray, 'x')).toBeCloseTo(width, -0.5);
    expect(getPeriod(gray, 'y')).toBeCloseTo(height, -0.5);
  }, 60_000);

  test('takes the size of the new integer zoom when the map zooms', async () => {
    // Across zoom 5, by less than one zoom level: the layer keeps the square it drew, which covers
    // the view at up to twice its scale, and only its pattern scale changes.
    const viewState = {longitude: 10.5, latitude: 48, zoom: 4.8, pitch: 0, bearing: 0};
    const next = {...viewState, zoom: 5.2};
    const {gray} = await render(new MapView({id: 'map'}), viewState, 'map', next);
    const [width, height] = getMercatorSize(next.zoom);
    expect(getPeriod(gray, 'x')).toBeCloseTo(width, -0.5);
    expect(getPeriod(gray, 'y')).toBeCloseTo(height, -0.5);
  }, 60_000);

  test('repeats on a globe, as on a map', async () => {
    const viewState = {longitude: 10.5, latitude: 48, zoom: 4.3, pitch: 0, bearing: 0};
    const globe = await render(new GlobeView({id: 'globe', resolution: 5}), viewState, 'globe');
    const map = await render(new MapView({id: 'map'}), viewState);
    const [width, height] = getMercatorSize(viewState.zoom);
    expect(getPeriod(map.gray, 'x')).toBeCloseTo(width, -0.5);
    expect(getPeriod(map.gray, 'y')).toBeCloseTo(height, -0.5);
    // The globe draws the ground at the Web Mercator scale of its center latitude or smaller.
    for (const axis of ['x', 'y'] as const) {
      const period = getPeriod(globe.gray, axis);
      expect(period).toBeGreaterThan(0.5 * getPeriod(map.gray, axis));
      expect(period).toBeLessThanOrEqual(getPeriod(map.gray, axis) + 1);
    }
  }, 60_000);
});
