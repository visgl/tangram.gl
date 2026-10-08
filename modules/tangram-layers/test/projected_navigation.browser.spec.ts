// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {OrthographicViewport, WebMercatorViewport} from '@deck.gl/core';
import {ProjectedBasemapNavigation, getProjectedGeographicBounds} from '../src/experimental/projected-navigation';
import {selectProjectedTileDetail} from '../src/experimental/projected-detail';
import type {ProjectedBasemapType} from '../src/experimental/projected-navigation';
import type {ProjectedTileDetailOptions} from '../src/experimental/projected-detail';
import {createProjectedExampleProjectionEngine} from '../../../examples/projected/projection-engine.js';

const types: ProjectedBasemapType[] = ['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'];
const createNavigation = () => new ProjectedBasemapNavigation(createProjectedExampleProjectionEngine());
const createViewport = (zoom = -1) => new OrthographicViewport({width: 800, height: 600, target: [0, 0, 0], zoom, flipY: false});

test.each(types)('%s forward/inverse, screen probing and fitting share the renderer coordinate contract', async type => {
    const navigation = createNavigation();
    const bounds = getProjectedGeographicBounds(type);
    const input = new Float64Array([-120, 30, -80, 60]);
    const projected = await navigation.projectPositions(input, type);
    expect(input).toEqual(new Float64Array([-120, 30, -80, 60]));
    for (let index = 0; index < input.length; index += 2) {
        const inverse = await navigation.unprojectPosition([projected[index], projected[index + 1]], type);
        expect(inverse?.[0]).toBeCloseTo(input[index], 6);
        expect(inverse?.[1]).toBeCloseTo(input[index + 1], 6);
    }
    const state = await navigation.fitBounds(bounds, {width: 800, height: 600}, type, {padding: 30});
    const viewport = new OrthographicViewport({...state, width: 800, height: 600, flipY: false});
    const focus = await navigation.projectPosition([-120, 30], type);
    const screen = viewport.project(focus);
    const probed = await navigation.unprojectScreenPosition(viewport, [screen[0], screen[1]], type);
    expect(probed?.[0]).toBeCloseTo(-120, 6);
    expect(probed?.[1]).toBeCloseTo(30, 6);
    // Independent denser samples verify interior curvature as well as the perimeter.
    for (let column = 0; column <= 40; column++) for (let row = 0; row <= 40; row++) {
        const position = await navigation.projectPosition([
            bounds[0] + (bounds[2] - bounds[0]) * column / 40,
            bounds[1] + (bounds[3] - bounds[1]) * row / 40], type);
        const pixel = viewport.project(position);
        expect(pixel[0]).toBeGreaterThanOrEqual(29.8);
        expect(pixel[0]).toBeLessThanOrEqual(770.2);
        expect(pixel[1]).toBeGreaterThanOrEqual(29.8);
        expect(pixel[1]).toBeLessThanOrEqual(570.2);
    }
    // Engine domain/convergence exceptions propagate; finite out-of-domain results return null.
    if (type === 'mercator' || type === 'web-mercator') expect(await navigation.unprojectPosition([1e7, 1e7], type)).toBeNull();
    else await expect(navigation.unprojectPosition([1e7, 1e7], type)).rejects.toThrow(/domain|converge/);
    navigation.dispose();
});

test.each(types)('%s inverse preserves source-domain corners and resized viewport coordinates', async type => {
    const navigation = createNavigation();
    const bounds = getProjectedGeographicBounds(type);
    for (const longitude of [bounds[0], bounds[2]]) for (const latitude of [bounds[1], bounds[3]]) {
        const projected = await navigation.projectPosition([longitude, latitude], type);
        const geographic = await navigation.unprojectPosition([projected[0], projected[1]], type);
        expect(geographic?.[0]).toBeCloseTo(longitude, 6);
        expect(geographic?.[1]).toBeCloseTo(latitude, 6);
    }
    if (type === 'equirectangular') {
        // A wrapped third-world seam must not be mistaken for the valid opposite edge.
        const edge = await navigation.projectPosition([180, 0], type);
        expect(await navigation.unprojectPosition([edge[0] * 3, edge[1]], type)).toBeNull();
    }
    const target = await navigation.projectPosition([-100, 40], type);
    for (const dimensions of [{width: 400, height: 300}, {width: 1000, height: 700}]) {
        const viewport = new OrthographicViewport({...dimensions, target, zoom: 1, flipY: false});
        const geographic = await navigation.unprojectScreenPosition(viewport, [dimensions.width / 2, dimensions.height / 2], type);
        expect(geographic?.[0]).toBeCloseTo(-100, 6);
        expect(geographic?.[1]).toBeCloseTo(40, 6);
    }
});

test('lazy transforms compile once per direction, retry failures and remain caller owned', async () => {
    const engine = createProjectedExampleProjectionEngine();
    const compile = vi.fn(engine.createProjectionAsync.bind(engine));
    const navigation = new ProjectedBasemapNavigation({createProjection: engine.createProjection.bind(engine), createProjectionAsync: compile});
    await Promise.all([navigation.projectPosition([0, 0], 'equal-earth'), navigation.projectPosition([1, 1], 'equal-earth')]);
    expect(compile).toHaveBeenCalledTimes(1);
    await Promise.all([navigation.unprojectPosition([0, 0], 'equal-earth'), navigation.unprojectPosition([0, 0], 'equal-earth')]);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile.mock.calls[1][0]?.from).toBe(compile.mock.calls[0][0]?.to);
    compile.mockRejectedValueOnce(new Error('missing descriptor'));
    await expect(navigation.projectPosition([0, 0], 'mercator')).rejects.toThrow('missing descriptor');
    await expect(navigation.projectPosition([0, 0], 'mercator')).resolves.toEqual([0, 0, 0]);
    navigation.dispose();
    await expect(navigation.projectPosition([0, 0], 'mercator')).rejects.toThrow('disposed');
    expect(engine.createProjection({from: 'EPSG:4326', to: '+proj=merc +a=6378137 +b=6378137'})).toBeTruthy();
});

test('disposal rejects late compilation and inverse failures are not hidden', async () => {
    const engine = createProjectedExampleProjectionEngine();
    let release = () => {};
    const wait = new Promise<void>(resolve => {release = resolve;});
    const navigation = new ProjectedBasemapNavigation({createProjection: engine.createProjection.bind(engine),
        createProjectionAsync: async options => {await wait; return engine.createProjection(options);}});
    const result = navigation.projectPosition([0, 0], 'equal-earth');
    navigation.dispose(); release();
    await expect(result).rejects.toThrow('disposed');
    const failing = new ProjectedBasemapNavigation({createProjection: engine.createProjection.bind(engine),
        createProjectionAsync: async () => {throw new Error('inverse unavailable');}});
    await expect(failing.unprojectPosition([0, 0], 'equal-earth')).rejects.toThrow('inverse unavailable');
});

test('pending forward and inverse compilation uses detached request-time coordinates', async () => {
    const engine = createProjectedExampleProjectionEngine();
    let release = () => {};
    const wait = new Promise<void>(resolve => {release = resolve;});
    const navigation = new ProjectedBasemapNavigation({createProjection: engine.createProjection.bind(engine),
        createProjectionAsync: async options => {await wait; return engine.createProjection(options);}});
    const oracle = createNavigation();
    const expected = await oracle.projectPosition([-75, 40], 'equal-earth');
    const forwardInput = new Float64Array([-75, 40]);
    const inverseInput: [number, number] = [expected[0], expected[1]];
    const forward = navigation.projectPositions(forwardInput, 'equal-earth');
    const inverse = navigation.unprojectPosition(inverseInput, 'equal-earth');
    forwardInput.fill(NaN);
    inverseInput[0] = 1e10;
    release();
    expect(await forward).toEqual(new Float64Array(expected.slice(0, 2)));
    const geographic = await inverse;
    expect(geographic?.[0]).toBeCloseTo(-75, 6);
    expect(geographic?.[1]).toBeCloseTo(40, 6);
});

test('small clipped regions coarsen using measured footprints, not assumed powers of two', async () => {
    const navigation = createNavigation();
    const coordinates = await navigation.projectPositions(new Float64Array([1, 1, 2, 2]), 'web-mercator');
    const span = Math.max(coordinates[2] - coordinates[0], coordinates[3] - coordinates[1]);
    const result = await selectProjectedTileDetail(navigation, createViewport(Math.log2(200 / span)), 'web-mercator', {
        visibleBounds: [1, 1, 2, 2], targetTilePixels: 256, currentTileZoom: 4, hysteresis: 0});
    expect(result.tileZoom).toBe(0);
    expect(result.estimatedTilePixels).toBeCloseTo(200, 6);
});

test('nonfinite and folded transform results never become usable navigation coordinates', async () => {
    const transform = {projectFlatSync: vi.fn((positions: Float64Array) => {positions.fill(NaN); return positions;})};
    const navigation = new ProjectedBasemapNavigation({createProjection: () => transform, createProjectionAsync: async () => transform});
    await expect(navigation.projectPosition([0, 0], 'equal-earth')).rejects.toThrow('nonfinite');
    expect(await navigation.unprojectPosition([0, 0], 'equal-earth')).toBeNull();
    transform.projectFlatSync.mockImplementation(positions => {positions.fill(0); return positions;});
    expect(await navigation.unprojectPosition([100, 100], 'equal-earth')).toBeNull();
});

test.each([[NaN, 0], [181, 0], [0, 86]])('invalid geographic focus %j fails early', async (longitude, latitude) => {
    await expect(createNavigation().projectPosition([longitude, latitude], 'equal-earth')).rejects.toThrow('geographic pairs');
});
test('invalid pairs, viewport sizes, canvas positions, projection domain and fit bounds are explicit', async () => {
    const navigation = createNavigation();
    await expect(navigation.projectPositions(new Float64Array([1]), 'equal-earth')).rejects.toThrow('pairs');
    await expect(navigation.unprojectPosition([NaN, 0], 'equal-earth')).rejects.toThrow('finite');
    await expect(navigation.unprojectScreenPosition(createViewport(), [NaN, 0], 'equal-earth')).rejects.toThrow('finite');
    for (const point of [[-1, 0], [801, 0], [0, -1], [0, 601]]) {
        expect(await navigation.unprojectScreenPosition(createViewport(), [point[0], point[1]], 'equal-earth')).toBeNull();
    }
    await expect(navigation.unprojectScreenPosition(new WebMercatorViewport({width: 800, height: 600}), [0, 0], 'equal-earth')).rejects.toThrow('Orthographic');
    await expect(navigation.fitBounds([-180, -80, 180, 80], {width: 800, height: 600}, 'albers')).rejects.toThrow('domain');
    await expect(navigation.fitBounds([1, 0, -1, 1], {width: 800, height: 600}, 'equal-earth')).rejects.toThrow();
    const point = await navigation.fitBounds([0, 0, 0, 0], {width: 800, height: 600}, 'equal-earth');
    expect(point.zoom).toBe(10);
    const clamped = await navigation.fitBounds(getProjectedGeographicBounds('equal-earth'), {width: 800, height: 600}, 'equal-earth', {minZoom: 2, maxZoom: 3});
    expect(clamped.zoom).toBe(2);
});
test('runtime callers cannot bypass pair and factory validation', async () => {
    const navigation = createNavigation();
    for (const engine of [null, {}, {createProjection: () => ({})}]) {
        expect(() => Reflect.construct(ProjectedBasemapNavigation, [engine])).toThrow('factory');
    }
    await expect(Reflect.apply(navigation.projectPositions, navigation, [[0, 0], 'equal-earth'])).rejects.toThrow('pairs');
    await expect(Reflect.apply(navigation.projectPosition, navigation, [[0], 'equal-earth'])).rejects.toThrow('pair');
    await expect(Reflect.apply(navigation.unprojectPosition, navigation, [[0], 'equal-earth'])).rejects.toThrow('pair');
    await expect(Reflect.apply(navigation.unprojectScreenPosition, navigation, [createViewport(), [0], 'equal-earth'])).rejects.toThrow('pair');
    await expect(navigation.fitBounds([0, 0, 1, 1], {width: Infinity, height: 600}, 'equal-earth')).rejects.toThrow('usable');
    expect(() => Reflect.apply(getProjectedGeographicBounds, null, ['unknown'])).toThrow();
});
test.each([{padding: -1}, {padding: 400}, {minZoom: 2, maxZoom: 1}, {maxZoom: NaN}])('fit rejects invalid options %j', async options => {
    await expect(createNavigation().fitBounds(getProjectedGeographicBounds('equal-earth'), {width: 800, height: 600}, 'equal-earth', options)).rejects.toThrow('usable');
});

test.each(types)('%s source detail follows CSS camera scale without exceeding candidate limits', async type => {
    const navigation = createNavigation();
    const options = {visibleBounds: getProjectedGeographicBounds(type)};
    const overview = await selectProjectedTileDetail(navigation, createViewport(-2), type, options);
    const close = await selectProjectedTileDetail(navigation, createViewport(2), type, options);
    expect(close.tileZoom).toBeGreaterThan(overview.tileZoom);
    expect(close.candidateCount).toBeLessThanOrEqual(256);
    const translated = new OrthographicViewport({width: 800, height: 600, target: [500, -300, 0], zoom: 2, flipY: false});
    const moved = await selectProjectedTileDetail(navigation, translated, type, options);
    expect(moved.tileZoom).toBe(close.tileZoom);
    expect(moved.candidateCount).toBe(close.candidateCount);
    expect(moved.estimatedTilePixels).toBeCloseTo(close.estimatedTilePixels, 9);
    const limited = await selectProjectedTileDetail(navigation, createViewport(8), type, options);
    expect(limited.budgetLimited).toBe(true);
    const capped = await selectProjectedTileDetail(navigation, createViewport(8), type, {...options, maxZoom: 2});
    expect(capped.detailLimited).toBe(true);
    expect(capped.budgetLimited).toBe(false);
});

test('hysteresis retains zero and adjacent levels; vector minimum remains independent of style zoom', async () => {
    const navigation = createNavigation();
    const options = {visibleBounds: getProjectedGeographicBounds('web-mercator')};
    const initial = await selectProjectedTileDetail(navigation, createViewport(-3), 'web-mercator', options);
    const zoom = -3 + Math.log2(256 / initial.estimatedTilePixels);
    const retained = await selectProjectedTileDetail(navigation, createViewport(zoom + 0.1), 'web-mercator', {...options, currentTileZoom: 0});
    expect(retained.tileZoom).toBe(0);
    const refined = await selectProjectedTileDetail(navigation, createViewport(zoom + 0.5), 'web-mercator', {...options, currentTileZoom: 0});
    expect(refined.tileZoom).toBeGreaterThan(0);
    const coarsened = await selectProjectedTileDetail(navigation, createViewport(-5), 'web-mercator', {...options, currentTileZoom: 3});
    expect(coarsened.tileZoom).toBe(0);
    const vector = await selectProjectedTileDetail(navigation, createViewport(-5), 'web-mercator', {...options, minZoom: 4});
    expect(vector.tileZoom).toBe(4);
    await expect(selectProjectedTileDetail(navigation, createViewport(), 'web-mercator', {...options, minZoom: 4, maxTiles: 1})).rejects.toThrow('minimum');
    await expect(selectProjectedTileDetail(navigation, createViewport(), 'web-mercator', {...options, currentTileZoom: 6, maxTiles: 1})).resolves.toHaveProperty('tileZoom', 0);
});

test.each<Partial<ProjectedTileDetailOptions>>([
    {minZoom: -1}, {maxZoom: 7}, {minZoom: 3, maxZoom: 2}, {targetTilePixels: 0}, {targetTilePixels: NaN},
    {maxTiles: 0}, {maxTiles: 1.5}, {hysteresis: -1}, {hysteresis: 0.5}, {currentTileZoom: -1}, {currentTileZoom: 1.2}
])('invalid detail policy %j fails explicitly', async options => {
    await expect(selectProjectedTileDetail(createNavigation(), createViewport(), 'equal-earth', {
        visibleBounds: getProjectedGeographicBounds('equal-earth'), ...options})).rejects.toThrow('ordered levels');
});

test('detail rejects nonfinite screen projection and non-orthographic structural cameras', async () => {
    const viewport = createViewport();
    vi.spyOn(viewport, 'project').mockReturnValue([NaN, NaN]);
    await expect(selectProjectedTileDetail(createNavigation(), viewport, 'equal-earth', {
        visibleBounds: getProjectedGeographicBounds('equal-earth')})).rejects.toThrow('nonfinite screen');
    vi.spyOn(viewport, 'project').mockReturnValue([]);
    await expect(selectProjectedTileDetail(createNavigation(), viewport, 'equal-earth', {
        visibleBounds: getProjectedGeographicBounds('equal-earth')})).rejects.toThrow('nonfinite screen');
    vi.spyOn(viewport, 'project').mockRestore();
    Object.defineProperty(viewport, 'width', {value: Infinity});
    await expect(selectProjectedTileDetail(createNavigation(), viewport, 'equal-earth', {
        visibleBounds: getProjectedGeographicBounds('equal-earth')})).rejects.toThrow('Orthographic');
});
