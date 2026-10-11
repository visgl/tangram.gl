// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Deck, MapView, WebMercatorViewport} from '@deck.gl/core';
import {TerrainLayer} from '@deck.gl/geo-layers';
import {RenderingHarness, coloredPixels, readCanvasPixels, DEVICE_TYPE} from './harness';
import {parseTerrainTile} from '../../examples/terrain/load-terrain';
import {pickTerrainSurface} from '../../examples/terrain/picking';
import {createTerrainFixture} from '../terrain-fixture';
import {projectGeographicPosition} from '@vis.gl/tangram-renderer/core';
import {buildTerrainRenderMesh} from '../../examples/terrain/terrain-mesh';
import {createTerrainStreamFixture} from '../terrain-stream-fixture';
import {sampleTerrainAnchor} from '../../examples/terrain/ground-following';
import {worldToLngLat} from '@math.gl/web-mercator';

let harness: RenderingHarness | undefined;
let deck: Deck<MapView> | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
    try {
        expect(harness?.errors || []).toEqual([]);
        expect(await commands.renderingDiagnostics()).toEqual([]);
    } finally {
        deck?.finalize(); deck = undefined;
        harness?.destroy(); harness = undefined;
    }
});

test(`${DEVICE_TYPE}: mixed-LOD top edges render without skirts and retain physical anchor clearance`, async () => {
    harness = new RenderingHarness(); await harness.initializeDevice();
    const coarse = createTerrainStreamFixture([-2000, -2000, 2000, 2000], [100, 100, 100, 100]);
    const upper = createTerrainStreamFixture([2000, 0, 4000, 2000], [100, 100, 100, 100]);
    const lower = createTerrainStreamFixture([2000, -2000, 4000, 0], [100, 100, 100, 100]);
    const tiles = [coarse, upper, lower].map(data => buildTerrainRenderMesh(data, [coarse, upper, lower].filter(candidate => candidate !== data).map(candidate => candidate.grid), 0));
    const location = worldToLngLat([256 + 2000 * 512 / (2 * Math.PI * 6378137), 256 + 1000 * 512 / (2 * Math.PI * 6378137)]);
    const elevation = sampleTerrainAnchor(tiles.map(tile => tile.loaded), [location[0], location[1]], 250);
    expect(elevation).toBeCloseTo(350);
    const viewState = {longitude: location[0], latitude: location[1], position: [0, 0, elevation ?? 0] as [number, number, number], zoom: 13, pitch: 0, bearing: 0};
    deck = new Deck({canvas: harness.canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
        views: new MapView({id: 'terrain'}), initialViewState: viewState, _animate: true, onError: error => harness!.errors.push(error.message),
        layers: tiles.map((tile, index) => {
            const bounds = tile.loaded.mesh.header!.boundingBox!;
            return new TerrainLayer({id: `mixed-${index}`, elevationData: `fixture://mixed-${index}`, bounds: [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]], material: false, color: [120, 180, 130], fetch: async () => tile.renderMesh});
        })});
    await expect.poll(async () => coloredPixels(await readCanvasPixels(harness!.canvas)), {timeout: 15000}).toBeGreaterThan(100);
    const viewport = new WebMercatorViewport({...viewState, width: 512, height: 320});
    const pixel = viewport.project([location[0], location[1], 100]);
    const image = await readCanvasPixels(harness.canvas);
    for (const horizontalOffset of [-2, -1, 0, 1, 2]) {
        const offset = (Math.round(pixel[1]) * image.width + Math.round(pixel[0]) + horizontalOffset) * 4;
        expect(image.data[offset + 1]).toBeGreaterThan(image.data[offset]);
    }
    expect(tiles.some(tile => pickTerrainSurface(viewport, tile.loaded.mesh, [pixel[0], pixel[1]])?.coordinate[2] === 100)).toBe(true);
});

test.each([{latitude: 0, zoom: 11.99}, {latitude: 46, zoom: 11.99},
    {latitude: 46, zoom: 12.01}, {latitude: -46, zoom: 12.01}])(`${DEVICE_TYPE}: terrain rendering and picking at $latitude degrees, zoom $zoom`, async ({latitude, zoom}) => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const bounds: [number, number, number, number] = [-0.01, latitude - 0.01, 0.01, latitude + 0.01];
    // Low relief keeps the known target visible rather than hidden by another
    // triangle; the separate loader corpus covers full mountain elevations.
    const data = await parseTerrainTile((await createTerrainFixture(0.025)).bytes, bounds, 0);
    const {loaded, renderMesh} = buildTerrainRenderMesh(data, [], 250);
    const viewState = {longitude: 0, latitude, zoom, pitch: 45, bearing: -20};
    deck = new Deck({canvas: harness.canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
        views: new MapView({id: 'terrain'}), initialViewState: viewState, _animate: true,
        onError: error => harness!.errors.push(error.message),
        layers: [new TerrainLayer({id: 'terrain', elevationData: 'fixture://terrain',
            bounds, color: [120, 180, 130], material: false,
            fetch: async () => renderMesh})]});
    await expect.poll(async () => coloredPixels(await readCanvasPixels(harness!.canvas)), {timeout: 15000}).toBeGreaterThan(100);
    const viewport = new WebMercatorViewport({...viewState, width: 512, height: 320});
    const origin = projectGeographicPosition([0.001, latitude + 0.002, 10000], 'web-mercator');
    const direct = loaded.surface.intersectRay({origin, direction: [0, 0, -1]});
    expect(direct).not.toBeNull();
    expect(direct!.coordinate[2]).toBeGreaterThan(20);
    const pixel = viewport.project(direct!.coordinate);
    expect(pixel[1]).toBeGreaterThan(0);
    expect(pixel[1]).toBeLessThan(320);
    const picked = pickTerrainSurface(viewport, loaded.mesh, [pixel[0], pixel[1]]);
    expect(picked).not.toBeNull();
    expect(picked!.coordinate[2]).toBeCloseTo(direct!.coordinate[2], 2);
    expect(picked!.coordinate[0]).toBeCloseTo(0.001, 5);
    expect(picked!.coordinate[1]).toBeCloseTo(latitude + 0.002, 5);
    const image = await readCanvasPixels(harness!.canvas);
    const offset = (Math.round(pixel[1]) * image.width + Math.round(pixel[0])) * 4;
    expect(image.data[offset + 1]).toBeGreaterThan(image.data[offset]);
    expect(pickTerrainSurface(viewport, loaded.mesh, [-1, 0])).toBeNull();
});

test('screen picking selects the front surface regardless of triangle order', async () => {
    const loaded = await parseTerrainTile((await createTerrainFixture()).bytes, [-0.01, -0.01, 0.01, 0.01], 0);
    const positions = new Float32Array([
        -0.01, -0.01, 0, 0.01, -0.01, 0, 0, 0.01, 0,
        -0.01, -0.01, 400, 0.01, -0.01, 400, 0, 0.01, 400
    ]);
    const viewport = new WebMercatorViewport({longitude: 0, latitude: 0, zoom: 12, pitch: 0, width: 512, height: 320});
    for (const [indices, triangleIndex] of [[new Uint32Array([0, 1, 2, 3, 4, 5]), 1], [new Uint32Array([3, 4, 5, 0, 1, 2]), 0]] as const) {
        const mesh = {...loaded.mesh, attributes: {POSITION: {size: 3, value: positions}}, indices: {size: 1, value: indices}};
        const hit = pickTerrainSurface(viewport, mesh, [256, 160]);
        expect(hit?.coordinate[2]).toBeCloseTo(400, 5);
        expect(hit?.triangleIndex).toBe(triangleIndex);
        expect(pickTerrainSurface(null, mesh, [256, 160])).toBeNull();
        expect(pickTerrainSurface(viewport, mesh, [NaN, 160])).toBeNull();
        expect(pickTerrainSurface(viewport, mesh, [256, 321])).toBeNull();
    }
});
