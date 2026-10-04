// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test} from 'vitest';
import {RenderingHarness, coloredPixels, DEVICE_TYPE} from './harness';
import {createRasterScene} from './scene';

let harness: RenderingHarness | undefined;
afterEach(() => harness?.destroy());

test(`${DEVICE_TYPE}: resident global raster tiles fill rotation gaps before new detail is built`, async () => {
    harness = new RenderingHarness('globe', 'stereo-preview');
    harness.presentation.setViewState({zoom: 5});
    harness.globePreloadZoom = 2;
    harness.tileZoom = 2;
    await harness.initialize(createRasterScene());
    await harness.settle();
    await expect.poll(() => harness?.getGlobePreloadState().filter(tile => tile.pinned && tile.built).length).toBe(16);
    const residentKeys = harness.getGlobePreloadState().filter(tile => tile.pinned).map(tile => tile.key).sort();

    harness.tileZoom = 4;
    harness.presentation.setViewState({longitude: 180});
    harness.draw();
    // The worker has not built new detail yet; both eyes draw clipped resident ancestors.
    expect(harness.getGlobePreloadState().some(tile => tile.clips > 0)).toBe(true);
    const fallbackPixels = await harness.pixels();
    expect(coloredPixels(fallbackPixels, 0, fallbackPixels.width / 2)).toBeGreaterThan(100);
    expect(coloredPixels(fallbackPixels, fallbackPixels.width / 2)).toBeGreaterThan(100);
    expect(harness.getGlobePreloadState().filter(tile => tile.pinned).map(tile => tile.key).sort()).toEqual(residentKeys);

    await harness.settle();
    expect(harness.getGlobePreloadState().every(tile => tile.clips === 0)).toBe(true);
    expect(coloredPixels(await harness.pixels())).toBeGreaterThan(200);
    expect(harness.errors).toEqual([]);
});
