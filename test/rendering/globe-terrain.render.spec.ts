// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test} from 'vitest';
import {Deck, _GlobeView as GlobeView} from '@deck.gl/core';
import {GlobeTerrainLayer, GlobeTerrainDisplayPreparation} from '@tangram.gl/tangram-layers/experimental/terrain';
import {GlobeTerrainPreparation, TerrainResourceBudget, type TerrainHeightGrid} from '@tangram.gl/tangram-renderer/map-logic';
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
    await expect.poll(() => layer.state.exaggeration).toBe(0);
    expect(layer.pickTerrain(deck.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(6000);
    const flatSurface = layer.state.surfaces[0], template = layer.state.prepared?.[0].template;
    deck.setProps({viewState: {longitude: 45, latitude: 22, zoom: 9}});
    await expect.poll(() => deck!.getViewports()[0].zoom).toBe(9);
    await expect.poll(() => layer.pickTerrain(deck!.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(6000);
    expect(layer.state.surfaces[0]).toBe(flatSurface);
    expect(layer.state.prepared?.[0].template).toBe(template);
    // Admission failure must keep the old draw/query generation, not publish an empty frame.
    const displayedBytes = layer.getStatistics().displayBytes;
    const limited = new GlobeTerrainLayer({id: 'terrain', data: [grid], meshResolution: 64, globeTerrainExaggeration: 1, maxDisplayBytes: displayedBytes, maxQueryIndexBytes: 0});
    deck.setProps({layers: [limited]});
    await expect.poll(() => limited.getStatistics().error).toContain('previous terrain retained');
    expect(limited.state.surfaces[0]).toBe(flatSurface);
    expect(limited.pickTerrain(deck.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(6000);
    const linear = new GlobeTerrainLayer({id: 'terrain', data: [grid], meshResolution: 64, globeTerrainExaggeration: 1, maxQueryIndexBytes: 0});
    deck.setProps({layers: [linear]});
    await expect.poll(() => linear.state.exaggeration).toBe(1);
    expect(linear.pickTerrain(deck.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(6000);
    expect(linear.getStatistics().queryIndexBytes).toBe(0);
    // Prepared display handles must draw/query the same generation without camera-driven rescaling.
    const budget = new TerrainResourceBudget(16 * 1024 * 1024);
    const preparation = new GlobeTerrainPreparation(undefined, {resourceBudget: budget}); preparation.request([grid], 64); while (preparation.isPending()) preparation.advance(1000);
    const display = new GlobeTerrainDisplayPreparation({resourceBudget: budget}); display.request(preparation.getSnapshot()!, 100);
    expect(display.getSnapshot()).toBeUndefined();
    while (display.isPending()) {display.advance(1); await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));}
    const prepared = new GlobeTerrainLayer({id: 'terrain', data: [grid], meshResolution: 64, preparedDisplay: display.getSnapshot()});
    expect(budget.getStatistics().bytes).toBe((preparation.getSnapshot()?.byteLength ?? 0) + (display.getSnapshot()?.byteLength ?? 0));
    deck.setProps({layers: [prepared], viewState: {longitude: 0, latitude: 0, zoom: 1}});
    await expect.poll(() => prepared.state.exaggeration).toBe(100);
    await expect.poll(async () => countTerrainPixels(await readCanvasPixels(harness!.canvas))).toBeGreaterThan(physicalPixels * 1.1);
    const warmBytes = prepared.getStatistics().queryIndexBytes;
    expect(warmBytes).toBeGreaterThan(0); expect(display.getStatistics().warmedIndexes).toBe(1);
    expect(prepared.pickTerrain(deck.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(6000);
    expect(prepared.getStatistics().queryIndexBytes).toBe(warmBytes);
    const front = prepared.sampleElevation([0, 0])!, back = prepared.sampleElevation([180, 0])!;
    expect(front.coordinate[2]).toBeCloseTo(6000); expect(back.coordinate[2]).toBeCloseTo(6000);
    expect(prepared.intersectTerrainSegment([0, -400, 0], front.position, {endInset: 1e-4})).toBeNull();
    expect(prepared.intersectTerrainSegment([0, -400, 0], back.position)?.coordinate[2]).toBeCloseTo(6000);
    expect(prepared.getStatistics().queryIndexBytes).toBe(warmBytes);
    const preparedSurface = prepared.state.surfaces[0]; deck.setProps({viewState: {longitude: 20, latitude: 10, zoom: 2}});
    await expect.poll(() => deck!.getViewports()[0].zoom).toBe(2);
    expect(prepared.state.surfaces[0]).toBe(preparedSurface); expect(prepared.state.exaggeration).toBe(100);
    deck.finalize(); deck = undefined;
    display.destroy(); preparation.destroy(); expect(budget.getStatistics()).toMatchObject({bytes: 0, leases: 0});
});

test(`${DEVICE_TYPE}: stitched 2:1 spherical terrain has no background gap at the shared edge`, async () => {
    harness = new RenderingHarness('globe'); await harness.initializeDevice();
    /** Small constant DEMs expose a shared coarse/fine edge through the camera target. */
    const grid = (height: number, bounds: [number, number, number, number]): TerrainHeightGrid => ({width: 2, height: 2, heights: new Float32Array(4).fill(height), valid: new Uint8Array(4).fill(1), bounds, verticalDatum: 'unknown', registration: 'grid-node'});
    const preparation = new GlobeTerrainPreparation();
    preparation.request([grid(1000, [-2000000, -1000000, 0, 1000000]), grid(3000, [0, 0, 1000000, 1000000]), grid(2000, [0, -1000000, 1000000, 0])], 16);
    while (preparation.isPending()) {preparation.advance(1); await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));}
    const snapshot = preparation.getSnapshot()!;
    const layer = new GlobeTerrainLayer({id: 'stitched', data: snapshot.grids, preparedTerrain: snapshot, meshResolution: 16, globeTerrainExaggeration: 100});
    deck = new Deck({canvas: harness.canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false, views: new GlobeView({id: 'terrain', controller: true}),
        initialViewState: {longitude: 0, latitude: 0, zoom: 3}, layers: [layer], _animate: true, onError: error => harness!.errors.push(error.message)});
    await expect.poll(async () => countTerrainPixels(await readCanvasPixels(harness!.canvas)), {timeout: 15000}).toBeGreaterThan(100);
    await expect.poll(() => layer.pickTerrain(deck!.getViewports()[0], [256, 160])?.coordinate[2]).toBeCloseTo(2000);
    for (const zoom of [3, 6]) {
        deck.setProps({viewState: {longitude: 0, latitude: 0, zoom}});
        await expect.poll(async () => {
            const image = await readCanvasPixels(harness!.canvas);
            return Array.from({length: 7}, (_, index) => (160 * image.width + 253 + index) * 4).every(offset => image.data[offset + 3] > 128 && Math.max(image.data[offset], image.data[offset + 1], image.data[offset + 2]) > 20);
        }).toBe(true);
    }
});
