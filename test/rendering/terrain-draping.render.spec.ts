// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import {commands} from 'vitest/browser';
import type {TerrainDrapingOptions} from '@vis.gl/tangram-renderer/core';
import {RenderingHarness, coloredPixels, readCanvasPixels, type ViewKind} from './harness';
import {createRasterScene, createScene} from './scene';
import {Matrix4} from '@math.gl/core';
import {Deck, MapView} from '@deck.gl/core';
import {TangramLayer} from '@vis.gl/tangram-layers';
import {sampleTerrainElevation} from '@vis.gl/tangram-renderer/core';

const harnesses: RenderingHarness[] = [];
const decks: Deck<MapView>[] = [];
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
    try {expect(await commands.renderingDiagnostics()).toEqual([]);}
    finally {for (const deck of decks.splice(0)) deck.finalize(); for (const harness of harnesses.splice(0)) harness.destroy(); vi.restoreAllMocks();}
});

/** Offline planar DEM, intentionally separate from styled vector/raster source data. */
function terrain(height: number, globe = false): TerrainDrapingOptions {
    return {grids: [{width: 2, height: 2, bounds: globe ? [-2e7, -2e7, 2e7, 2e7] : [-10000, -10000, 10000, 10000],
        heights: new Float32Array(4).fill(height), valid: new Uint8Array(4).fill(1), verticalDatum: 'orthometric', registration: 'grid-node'}],
        transitionDuration: 0, maxSegmentLength: globe ? 1e6 : 250};
}

/** Count real displayed pixel differences, not worker or projection mocks. */
function changedPixels(first: ImageData, second: ImageData): number {
    let changed = 0;
    for (let index = 0; index < first.data.length; index += 4) if ([0, 1, 2].some(channel => Math.abs(first.data[index + channel] - second.data[index + channel]) > 30)) changed++;
    return changed;
}

test.each(['perspective', 'first-person', 'globe'] as ViewKind[])('%s displaces packaged polygon/road meshes and retains warm source data', async kind => {
    const harness = new RenderingHarness(kind); harnesses.push(harness);
    harness.terrain = terrain(0, kind === 'globe');
    await harness.initialize(); await harness.settle();
    const first = await harness.pixels(); expect(coloredPixels(first)).toBeGreaterThan(50);
    const source = await harness.renderer.getTileSourceStatistics();
    await harness.renderer.setTerrain(terrain(kind === 'globe' ? 400000 : 100, kind === 'globe'));
    await harness.settle();
    const second = await harness.pixels(); expect(coloredPixels(second)).toBeGreaterThan(50);
    expect(changedPixels(first, second)).toBeGreaterThan(30);
    const next = await harness.renderer.getTileSourceStatistics();
    expect(next).toEqual(source);
    expect(harness.errors).toEqual([]);
}, 45000);

test('stereo draping keeps either eye selectable, exaggeration GPU-only, and no-data geometry absent', async () => {
    const harness = new RenderingHarness('perspective', 'stereo-preview'); harnesses.push(harness);
    harness.terrain = terrain(100);
    await harness.initialize(); await harness.settle();
    const source = await harness.renderer.getTileSourceStatistics();
    const first = await harness.pixels();
    harness.renderer.setTerrainExaggeration(0); await harness.settle();
    expect(changedPixels(first, await harness.pixels())).toBeGreaterThan(30);
    expect(await harness.renderer.getTileSourceStatistics()).toEqual(source);
    harness.renderer.setTerrainExaggeration(1);
    const frame = harness.presentation.createFrame({width: 512, height: 320});
    for (const view of frame.renderViews) {
        const viewport = view.deckViewport;
        if (!viewport) throw new Error('Expected a desktop stereo viewport');
        const pixel = viewport.project([-0.001, 0.001, 180]);
        const result = await harness.pick(pixel[0] + viewport.x, pixel[1] + viewport.y);
        expect(result).toMatchObject({feature: {properties: {name: 'fixture-building'}}});
    }
    await harness.renderer.setTerrain({grids: [], transitionDuration: 0}); await harness.settle();
    expect(coloredPixels(await harness.pixels())).toBe(0);
    expect(harness.errors).toEqual([]);
}, 45000);

test('packaged raster UVs survive worker refinement and displacement', async () => {
    const harness = new RenderingHarness('perspective'); harnesses.push(harness); harness.terrain = terrain(0);
    await harness.initialize(createRasterScene()); await harness.settle();
    const first = await harness.pixels(); expect(coloredPixels(first)).toBeGreaterThan(1000);
    await harness.renderer.setTerrain(terrain(200)); await harness.settle();
    expect(changedPixels(first, await harness.pixels())).toBeGreaterThan(100);
    expect(harness.errors).toEqual([]);
}, 45000);

/** Offline balanced globe coverage, with one coarse leaf replaced by its four children. */
function canonicalField(height: number, balanced = true): TerrainDrapingOptions {
    const circumference = 2 * Math.PI * 6378137;
    const leaf = (column: number, row: number, zoom: number) => {
        const span = circumference / 2 ** zoom;
        return {width: 2, height: 2, bounds: [column * span - circumference / 2, circumference / 2 - (row + 1) * span,
            (column + 1) * span - circumference / 2, circumference / 2 - row * span] as const,
            heights: new Float32Array(4).fill(height), valid: new Uint8Array(4).fill(1), verticalDatum: 'orthometric' as const, registration: 'grid-node' as const};
    };
    const grids = Array.from({length: 16}, (_, index) => leaf(index % 4, Math.floor(index / 4), 2));
    if (balanced) {grids.splice(6, 1); grids.push(leaf(4, 2, 3), leaf(5, 2, 3), leaf(4, 3, 3), leaf(5, 3, 3));}
    return {grids, querySurfaceStyles: ['raster'], groundMeshResolution: 8, transitionDuration: 200};
}

test.each(['perspective', 'first-person', 'globe'] as ViewKind[])('%s canonical polygon walls and wide roads retain color, feature selection and shared stereo transitions', async kind => {
    const harness = new RenderingHarness(kind, 'stereo-preview'); harnesses.push(harness);
    if (kind === 'first-person') harness.presentation.setViewState({position: [0, 0, 400]});
    if (kind === 'globe') harness.presentation.setViewState({zoom: 6});
    const field = canonicalField(20);
    // City-scale fields exercise actual cell crossings, not an almost planar world-sized face.
    if (kind !== 'globe') {
        const span = 2 * Math.PI * 6378137 / 4096;
        field.grids = [-1, 0].flatMap(column => [-1, 0].map(row => ({width: 2, height: 2,
            bounds: [column * span, row * span, (column + 1) * span, (row + 1) * span] as const,
            heights: new Float32Array(4).fill(20), valid: new Uint8Array(4).fill(1), registration: 'grid-node' as const, verticalDatum: 'orthometric' as const})));
    } else {harness.tileZoom = 3; harness.globePreloadZoom = 2;}
    harness.terrain = {...field, querySurfaceStyles: []};
    const scene = createScene(harness.sourceUrl, undefined, false, harness.scale);
    Object.assign(scene.layers.roads.draw.traffic, {width: '24px', interactive: true});
    // Scale geographic fixture extent, not physical extrusion: 80 km would wrap signed-short height packing.
    scene.layers.buildings.draw.polygons.extrude = 80;
    await harness.initialize(scene); await harness.settle();
    const pixels = await harness.pixels();
    expect(coloredPixels(pixels, 0, 256)).toBeGreaterThan(50);
    expect(coloredPixels(pixels, 256, 512)).toBeGreaterThan(50);
    const source = await harness.renderer.getTileSourceStatistics();
    await harness.renderer.setTerrain({...harness.terrain, grids: field.grids.map(grid => ({...grid, heights: new Float32Array(4).fill(120)})), previousGrids: field.grids});
    await harness.settle();
    expect(await harness.renderer.getTileSourceStatistics()).toEqual(source);
    const frame = harness.presentation.createFrame({width: 512, height: 320});
    for (const eye of frame.renderViews) {
        if (!eye.deckViewport) throw new Error('Expected stereo viewport');
        const pixel = eye.deckViewport.project([-0.001 * harness.scale, 0.001 * harness.scale, 200]);
        await expect.poll(() => harness.pick(pixel[0] + eye.deckViewport!.x, pixel[1] + eye.deckViewport!.y), {timeout: 5000, interval: 50})
            .toMatchObject({feature: {properties: {name: 'fixture-building'}}});
        const road = eye.deckViewport.project([0, 0, 120]);
        expect(await harness.pick(road[0] + eye.deckViewport.x, road[1] + eye.deckViewport.y)).toMatchObject({feature: {properties: {kind: 'road'}}});
    }
    expect(harness.errors).toEqual([]);
}, 45000);

test.each(['perspective', 'globe'] as ViewKind[])('%s fractional zoom refines canonical road widths once for both eyes without cold source loads', async kind => {
    const harness = new RenderingHarness(kind, 'stereo-preview'); harnesses.push(harness);
    harness.terrain = {...canonicalField(20, false), querySurfaceStyles: []};
    if (kind === 'globe') {harness.globePreloadZoom = 2; harness.tileZoom = 3;}
    else harness.tileZoom = 15;
    const scene = createScene(harness.sourceUrl, undefined, false, harness.scale);
    Object.assign(scene.layers.roads.draw.traffic, {width: '24px', interactive: true});
    await harness.initialize(scene); await harness.settle();
    const source = await harness.renderer.getTileSourceStatistics();
    const initial = kind === 'globe' ? 4 : 15;
    for (const zoom of [initial + 0.25, initial + 0.75]) {
        harness.presentation.setViewState({zoom}); await harness.settle();
        const hostZoom = harness.presentation.createFrame({width: 512, height: 320}).hostFrame.geographicAnchor.zoom;
        expect(harness.renderer.getTerrainDrapingStatistics().ribbonRefinement).toMatchObject({requestedZoom: hostZoom, admittedZoom: hostZoom, pending: false});
        expect(harness.renderer.getTerrainDrapingStatistics().ribbonRefinement?.error).toBeUndefined();
        const pixels = await harness.pixels();
        expect(coloredPixels(pixels, 0, 256)).toBeGreaterThan(50);
        expect(coloredPixels(pixels, 256, 512)).toBeGreaterThan(50);
        expect(await harness.renderer.getTileSourceStatistics()).toEqual(source);
    }
    expect(harness.errors).toEqual([]);
}, 45000);

test.each(['flat', 'globe'] as ViewKind[])('%s canonical ground preserves raster color, ownership and atomic query morphs through the packaged worker', async kind => {
    const harness = new RenderingHarness(kind, 'stereo-preview'); harnesses.push(harness);
    harness.terrain = canonicalField(20);
    if (kind === 'globe') {harness.globePreloadZoom = 2; harness.tileZoom = 3;}
    else harness.tileZoom = 15; // z2 DEM + 8 cells + maximum supported 10-level source disparity.
    await harness.initialize(createRasterScene()); await harness.settle();
    expect(coloredPixels(await harness.pixels())).toBeGreaterThan(1000);
    const source = await harness.renderer.getTileSourceStatistics();
    const before = harness.renderer.getDrapedTerrainSurface();
    if (!before) throw new Error('Expected admitted canonical ground');
    expect(before.inputBytes).toBeGreaterThan(0);
    await harness.renderer.setTerrain({...canonicalField(120), previousGrids: canonicalField(20).grids});
    await harness.settle();
    expect(coloredPixels(await harness.pixels())).toBeGreaterThan(1000);
    const after = harness.renderer.getDrapedTerrainSurface();
    expect(after?.generation).toBeGreaterThan(before.generation);
    expect(await harness.renderer.getTileSourceStatistics()).toEqual(source);
    const frame = harness.presentation.createFrame({width: 512, height: 320});
    for (const eye of frame.renderViews) {
        if (!eye.deckViewport) throw new Error('Expected stereo viewport');
        const pixel = eye.deckViewport.project([0.001, 0.001, 120]);
        const hit = harness.renderer.getTerrainAt({x: pixel[0] + (eye.viewport?.x ?? 0), y: pixel[1] + (eye.viewport?.y ?? 0)}, undefined, {coordinateSpace: 'canvas'});
        expect(hit?.coordinate[2]).toBeGreaterThanOrEqual(20 - 1e-6);
        expect(hit?.coordinate[2]).toBeLessThanOrEqual(120 + 1e-6);
    }
    expect(harness.errors).toEqual([]);
}, 45000);

test('uniform canonical transition refinement reaches both stereo eyes through the packaged worker', async () => {
    const harness = new RenderingHarness('globe', 'stereo-preview'); harnesses.push(harness);
    harness.terrain = canonicalField(20, false); harness.globePreloadZoom = 2; harness.tileZoom = 3;
    await harness.initialize(createRasterScene()); await harness.settle();
    const source = await harness.renderer.getTileSourceStatistics();
    await harness.renderer.setTerrain({...canonicalField(120, false), groundMeshResolution: 16, previousGroundMeshResolution: 8,
        conformTransitions: true, previousGrids: canonicalField(20, false).grids});
    await harness.settle();
    const pixels = await harness.pixels();
    expect(coloredPixels(pixels, 0, 256)).toBeGreaterThan(1000); expect(coloredPixels(pixels, 256, 512)).toBeGreaterThan(1000);
    const frame = harness.presentation.createFrame({width: 512, height: 320});
    for (const eye of frame.renderViews) {
        if (!eye.deckViewport) throw new Error('Expected stereo viewport');
        const pixel = eye.deckViewport.project([0.001, 0.001, 120]);
        const hit = harness.renderer.getTerrainAt({x: pixel[0] + (eye.viewport?.x ?? 0), y: pixel[1] + (eye.viewport?.y ?? 0)}, undefined, {coordinateSpace: 'canvas'});
        expect(hit?.coordinate[2]).toBeGreaterThanOrEqual(20 - 1e-6); expect(hit?.coordinate[2]).toBeLessThanOrEqual(120 + 1e-6);
    }
    expect(await harness.renderer.getTileSourceStatistics()).toEqual(source);
    expect(harness.errors).toEqual([]);
}, 45000);

test.each([false, true])('non-interactive ground (later order=%s) occludes annotation color and feature picking in both stereo eyes', async laterOrder => {
    const harness = new RenderingHarness('perspective', 'stereo-preview'); harnesses.push(harness);
    // No CPU ground query styles: this exercises depth parity, not a hidden CPU collision mask.
    harness.terrain = {...terrain(100), occludeAnnotations: true};
    const base = createRasterScene();
    const sourceUrl = `data:application/json,${encodeURIComponent(JSON.stringify({type: 'FeatureCollection', features: [
        {type: 'Feature', id: 1, properties: {name: 'buried-marker'}, geometry: {type: 'Point', coordinates: [0, 0]}}
    ]}))}`;
    // Alpha-one raster output with a translucent blend mode can be ordered after
    // overlay annotations; ordinary opaque styles always sort first in Tangram.
    await harness.initialize({...base, sources: {...base.sources, markers: {type: 'GeoJSON', url: sourceUrl}},
        styles: laterOrder ? {lateGround: {base: 'raster', blend: 'translucent', blend_order: 10}} : {},
        layers: {...base.layers, basemap: {...base.layers.basemap,
            draw: {[laterOrder ? 'lateGround' : 'raster']: base.layers.basemap.draw.raster}},
            markers: {data: {source: 'markers'}, draw: {points: {
            // Bury the entire screen-facing quad, not just its geographic anchor.
            // A slightly buried anchor can still have fragments above an inclined ground plane.
            order: 5, color: '#ff0000', size: '40px', z: -500, collide: false, interactive: true
        }}}}});
    const pipelines = vi.spyOn(harness.device, 'createRenderPipeline');
    await harness.settle();
    expect(pipelines.mock.calls.some(([options]) => options.id?.includes('points') &&
        options.parameters?.depthCompare === 'less-equal' && options.parameters.depthWriteEnabled === false)).toBe(true);
    const countRed = (image: ImageData) => {
        let count = 0;
        for (let index = 0; index < image.data.length; index += 4) if (image.data[index] > 180 && image.data[index + 1] < 60 && image.data[index + 2] < 60) count++;
        return count;
    };
    expect(countRed(await harness.pixels())).toBe(0);
    const frame = harness.presentation.createFrame({width: 512, height: 320});
    for (const eye of frame.renderViews) {
        if (!eye.deckViewport) throw new Error('Expected stereo preview viewport');
        const pixel = eye.deckViewport.project([0, 0, -400]);
        expect((await harness.pick(pixel[0] + eye.deckViewport.x, pixel[1] + eye.deckViewport.y))?.feature).toBeUndefined();
    }
    await harness.renderer.setTerrain({...terrain(100), occludeAnnotations: false}); await harness.settle();
    if (laterOrder) {
        // Legacy opt-out preserves the reported mismatch: later alpha-one color
        // covers the marker, but absent selection depth leaves its ID behind.
        expect(countRed(await harness.pixels())).toBe(0);
    } else expect(countRed(await harness.pixels())).toBeGreaterThan(100);
    for (const eye of frame.renderViews) {
        if (!eye.deckViewport) throw new Error('Expected stereo preview viewport');
        const pixel = eye.deckViewport.project([0, 0, -400]);
        expect(await harness.pick(pixel[0] + eye.deckViewport.x, pixel[1] + eye.deckViewport.y)).toMatchObject({feature: {properties: {name: 'buried-marker'}}});
    }
}, 45000);

test.each(['perspective', 'first-person', 'globe'] as ViewKind[])('%s draped ground picking uses the exact admitted draw topology across replacement and exaggeration', async kind => {
    const harness = new RenderingHarness(kind); harnesses.push(harness);
    harness.terrain = {...terrain(100, kind === 'globe'), querySurfaceStyles: ['raster']};
    const base = createRasterScene();
    await harness.initialize({...base, layers: {basemap: {...base.layers.basemap, draw: {raster: {...base.layers.basemap.draw.raster, z: 40}}}}}); await harness.settle();
    expect(coloredPixels(await harness.pixels())).toBeGreaterThan(50);
    const snapshot = harness.renderer.getDrapedTerrainSurface();
    if (!snapshot) throw new Error('Expected an admitted draped ground snapshot');
    const before = sampleTerrainElevation(snapshot, [0, 0], {minimumAltitude: -1000, maximumAltitude: 1000});
    expect(before?.coordinate[2]).toBeCloseTo(140, 4);
    const source = await harness.renderer.getTileSourceStatistics();
    await harness.renderer.setTerrain({...terrain(200, kind === 'globe'), querySurfaceStyles: ['raster']}); await harness.settle();
    harness.renderer.setTerrainExaggeration(2); await harness.settle();
    const next = harness.renderer.getDrapedTerrainSurface();
    if (!next) throw new Error('Expected a replacement ground snapshot');
    expect(sampleTerrainElevation(next, [0, 0], {minimumAltitude: -1000, maximumAltitude: 1000})?.coordinate[2]).toBeCloseTo(240, 4);
    expect(sampleTerrainElevation(snapshot, [0, 0], {minimumAltitude: -1000, maximumAltitude: 1000})?.coordinate[2]).toBeCloseTo(140, 4);
    expect(await harness.renderer.getTileSourceStatistics()).toEqual(source);
    expect(harness.renderer.getTerrainDrapingStatistics().queryBytes).toBeGreaterThan(0);
    expect(harness.renderer.getTerrainDrapingStatistics().stagedMeshBytes).toBe(0);
}, 45000);

test('either stereo eye routes ground picking through the same physical snapshot', async () => {
    const harness = new RenderingHarness('perspective', 'stereo-preview'); harnesses.push(harness);
    harness.terrain = {...terrain(100), querySurfaceStyles: ['raster']};
    await harness.initialize(createRasterScene()); await harness.settle();
    const frame = harness.presentation.createFrame({width: 512, height: 320});
    for (const view of frame.renderViews) {
        const viewport = view.deckViewport;
        if (!viewport) throw new Error('Expected stereo viewport');
        if (!view.viewport) throw new Error('Expected stereo render rectangle');
        const pixel = viewport.project([0, 0, 100]);
        const hit = harness.renderer.getTerrainAt({x: pixel[0] + (view.viewport.x ?? 0), y: pixel[1] + (view.viewport.y ?? 0)}, undefined, {coordinateSpace: 'canvas'});
        expect(hit?.coordinate[2]).toBeCloseTo(100, 3); expect(hit?.renderViewId).toBe(view.id);
        expect(harness.renderer.getTerrainAt({x: pixel[0], y: pixel[1]}, undefined, {renderViewId: view.id})?.renderViewId).toBe(view.id);
    }
}, 45000);

test.each(['perspective', 'globe'] as const)('%s draping follows both mocked immersive room-space cameras', async kind => {
    const harness = new RenderingHarness(kind); harnesses.push(harness); harness.terrain = terrain(0, kind === 'globe');
    const scene = createScene(harness.sourceUrl, undefined, false, harness.scale);
    // Physical fixture geometry must remain visible on the half-meter globe
    // regardless of the unrelated logical desktop zoom used for scene styling.
    if (kind === 'globe') scene.layers.roads.draw.traffic.width = '300000m';
    await harness.initialize(scene);
    harness.presentation.setPlacement(kind === 'globe' ? {type: 'globe', anchor: [0, 0], radius: 0.5, pose: {position: [0, 0.7, -2]}} : {type: 'map', anchor: [0, 0], metersPerXRUnit: 1000, pose: {position: [0, 0.7, -2]}});
    harness.frameState = {views: [-0.032, 0.032].map((horizontal, index) => ({index, eye: index === 0 ? 'left' : 'right', viewport: [index * 256, 0, 256, 320],
        viewMatrix: new Matrix4().lookAt({eye: [horizontal, 1.7, 0], center: [0, 0.7, -2], up: [0, 1, 0]}), projectionMatrix: new Matrix4().perspective({fovy: Math.PI / 3, aspect: 256 / 320, near: 0.05, far: 20})}))};
    await harness.settle(); const first = await harness.pixels();
    expect(coloredPixels(first, 0, 256)).toBeGreaterThan(50); expect(coloredPixels(first, 256, 512)).toBeGreaterThan(50);
    await harness.renderer.setTerrain(terrain(kind === 'globe' ? 400000 : 100, kind === 'globe')); await harness.settle();
    const second = await harness.pixels(); expect(changedPixels(first, second)).toBeGreaterThan(30);
    expect(coloredPixels(second, 0, 256)).toBeGreaterThan(50); expect(coloredPixels(second, 256, 512)).toBeGreaterThan(50);
    expect(harness.errors).toEqual([]);
}, 45000);

test('ordinary deck layer transfers terrain updates and disposes the actual packaged renderer', async () => {
    const harness = new RenderingHarness('perspective'); harnesses.push(harness); await harness.initializeDevice();
    const scene = createScene(harness.sourceUrl);
    let layer = new TangramLayer({id: 'terrain-basemap', scene, terrain: {grids: []}});
    const deck = new Deck({canvas: harness.canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false, views: new MapView({controller: true}), initialViewState: {longitude: 0, latitude: 0, zoom: 15, pitch: 45},
        layers: [layer], _animate: true, onError: error => harness.errors.push(error.message)});
    decks.push(deck);
    await expect.poll(() => layer.isLoaded, {timeout: 15000}).toBe(true);
    layer = new TangramLayer({id: 'terrain-basemap', scene, terrain: terrain(0)}); deck.setProps({layers: [layer]});
    await expect.poll(async () => coloredPixels(await readCanvasPixels(harness.canvas)), {timeout: 15000}).toBeGreaterThan(50);
    const first = await readCanvasPixels(harness.canvas);
    layer = new TangramLayer({id: 'terrain-basemap', scene, terrain: terrain(100)}); deck.setProps({layers: [layer]});
    await expect.poll(async () => changedPixels(first, await readCanvasPixels(harness.canvas)), {timeout: 15000}).toBeGreaterThan(30);
    expect(layer.getTerrainDrapingStatistics()?.meshes).toBeGreaterThan(0);
    expect(harness.errors).toEqual([]);
}, 45000);

test('point/text anchors retain atlas ranges and feature selection after worker stride expansion', async () => {
    const harness = new RenderingHarness('perspective'); harnesses.push(harness); harness.terrain = terrain(100);
    const data = {type: 'FeatureCollection', features: [{type: 'Feature', id: 1, properties: {name: 'terrain-point'}, geometry: {type: 'Point', coordinates: [-0.001, 0.001]}}]};
    await harness.initialize({sources: {fixture: {type: 'GeoJSON', url: `data:application/json,${encodeURIComponent(JSON.stringify(data))}`}},
        layers: {annotations: {data: {source: 'fixture'}, draw: {
            points: {order: 1, z: 20, color: '#e0e040', size: '20px', interactive: true},
            text: {order: 2, z: 20, offset: [0, -30], font: {family: 'sans-serif', size: '14px', fill: '#ffffff'}}
        }}}});
    await harness.settle(); const frame = harness.presentation.createFrame({width: 512, height: 320});
    const pixel = frame.logicalViewport.project([-0.001, 0.001, 120]);
    expect(coloredPixels(await harness.pixels())).toBeGreaterThan(40);
    expect(await harness.pick(pixel[0], pixel[1])).toMatchObject({feature: {properties: {name: 'terrain-point'}}});
    expect(harness.errors).toEqual([]);
}, 45000);

test('planar lighting uses physical slope normals rather than zoom-dependent packed-unit slopes', async () => {
    const harness = new RenderingHarness('flat'); harnesses.push(harness); harness.terrain = terrain(0);
    const extent = 0.03;
    const surface = {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[[-extent, -extent], [extent, -extent], [extent, extent], [-extent, extent], [-extent, -extent]]]}};
    await harness.initialize({scene: {lighting: 'configured'}, sources: {surface: {type: 'GeoJSON', url: `data:application/json,${encodeURIComponent(JSON.stringify(surface))}`}},
        lights: {sun: {type: 'directional', direction: [-1, 0, -1], ambient: 0, diffuse: 1}},
        styles: {surface: {base: 'polygons', lighting: 'fragment', material: {ambient: 0, diffuse: 1, specular: 0}}},
        layers: {surface: {data: {source: 'surface'}, draw: {surface: {order: 0, color: '#ffffff'}}}}});
    await harness.settle();
    const center = (image: ImageData) => image.data[(160 * image.width + 256) * 4];
    const flat = center(await harness.pixels()); expect(flat).toBeGreaterThan(100);
    const values: number[] = [];
    for (const sign of [-1, 1]) {
        const input = terrain(0);
        const source = input.grids[0];
        source.heights.set([-5000 * sign, 5000 * sign, -5000 * sign, 5000 * sign]);
        await harness.renderer.setTerrain(input); await harness.settle(); values.push(center(await harness.pixels()));
    }
    expect(Math.min(...values) / flat).toBeCloseTo(1 / Math.sqrt(5), 1);
    expect(Math.max(...values) / flat).toBeCloseTo(3 / Math.sqrt(5), 1);
    expect(harness.errors).toEqual([]);
}, 45000);
