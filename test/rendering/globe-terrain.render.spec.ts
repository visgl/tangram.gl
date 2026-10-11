// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test} from 'vitest';
import {Deck, _GlobeView as GlobeView} from '@deck.gl/core';
import {GlobeTerrainLayer} from '@vis.gl/tangram-layers/experimental/terrain';
import type {TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';
import {RenderingHarness, readCanvasPixels, DEVICE_TYPE} from './harness';

/** Snow-covered terrain is nearly grayscale, so use coverage rather than color saturation. */
function countTerrainPixels(image: ImageData): number {
    let count = 0;
    for (let offset = 0; offset < image.data.length; offset += 4) if (image.data[offset + 3] > 128 && Math.max(image.data[offset], image.data[offset + 1], image.data[offset + 2]) > 20) count++;
    return count;
}

let harness: RenderingHarness | undefined, deck: Deck<GlobeView> | undefined;
afterEach(() => {try {expect(harness?.errors ?? []).toEqual([]);} finally {deck?.finalize(); harness?.destroy(); deck = undefined; harness = undefined;}});

test(`${DEVICE_TYPE}: spherical terrain grows at 100×, remains interactive and queries physical source meters`, async () => {
    harness = new RenderingHarness('globe'); await harness.initializeDevice();
    const edge = Math.PI * 6378137;
    const grid: TerrainHeightGrid = {width: 3, height: 3, heights: new Float32Array(9).fill(6000), valid: new Uint8Array(9).fill(1), bounds: [-edge, -edge, edge, edge], verticalDatum: 'unknown', registration: 'grid-node'};
    let layer = new GlobeTerrainLayer({id: 'terrain', data: [grid], meshResolution: 64, globeTerrainExaggeration: 1});
    deck = new Deck({canvas: harness.canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false, views: new GlobeView({id: 'terrain', controller: true}),
        initialViewState: {longitude: 0, latitude: 0, zoom: 1}, layers: [layer], _animate: true, onError: error => harness!.errors.push(error.message)});
    await expect.poll(async () => countTerrainPixels(await readCanvasPixels(harness!.canvas)), {timeout: 15000}).toBeGreaterThan(100);
    const physicalPixels = countTerrainPixels(await readCanvasPixels(harness.canvas));
    await expect.poll(() => layer.pickTerrain(deck!.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(6000);
    layer = new GlobeTerrainLayer({id: 'terrain', data: [grid], meshResolution: 64}); deck.setProps({layers: [layer]});
    await expect.poll(async () => countTerrainPixels(await readCanvasPixels(harness!.canvas)), {timeout: 15000}).toBeGreaterThan(physicalPixels * 1.1);
    expect(layer.pickTerrain(deck.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(6000);
    expect(layer.state.exaggeration).toBe(100);
    layer = new GlobeTerrainLayer({id: 'terrain', data: [grid], meshResolution: 64, globeTerrainExaggeration: 0}); deck.setProps({layers: [layer]});
    await expect.poll(() => layer.state?.exaggeration).toBe(0);
    await expect.poll(async () => countTerrainPixels(await readCanvasPixels(harness!.canvas)), {timeout: 15000}).toBeLessThan(physicalPixels * 1.05);
    expect(layer.pickTerrain(deck.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(6000);
    layer = new GlobeTerrainLayer({id: 'terrain', data: [grid], meshResolution: 64, globeTerrainExaggeration: 200}); deck.setProps({layers: [layer]});
    await expect.poll(() => layer.state?.exaggeration).toBe(200);
    await expect.poll(async () => countTerrainPixels(await readCanvasPixels(harness!.canvas)), {timeout: 15000}).toBeGreaterThan(physicalPixels * 1.1);
    deck.setProps({viewState: {longitude: 40, latitude: 20, zoom: 8}});
    await expect.poll(() => layer.state.exaggeration).toBe(1);
    expect(layer.pickTerrain(deck.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(6000);
});
