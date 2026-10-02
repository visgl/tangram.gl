// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import {WebMercatorViewport, FirstPersonView, _GlobeViewport as GlobeViewport} from '@deck.gl/core';
import HostFrame from '../src/scene/host_frame';
import Renderer from '../src/scene/renderer';
import ProjectedTileLOD from '../src/scene/projected_tile_lod';
import {WebMercatorVisibilityAdapter, WebMercatorGlobeVisibilityAdapter} from '../src/scene/visibility_adapter';
import {getExternalCameraFrame, getFirstPersonViewFrame, getGlobeViewFrame} from '../../tangram-layers/src/tangram-layer';
import Geo from '../src/utils/geo';
import type {HostFrameOptions, HostTileLODOptions} from '../src/types';

/** Orthographic half-world footprint with an exactly controlled projected scale. */
function createFrame(projectedZoom: number, options: HostTileLODOptions = {}, overrides: Partial<HostFrameOptions> = {}): HostFrame {
    const size = 512 * 2 ** (projectedZoom - 1);
    const scale = 4 / Geo.circumference_meters;
    return new HostFrame({
        viewport: {width: size, height: size}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 8.5},
        projection: {type: 'web-mercator', visibleBounds: [-90, -66.51326044311186, 90, 66.51326044311186]},
        renderViews: [{camera: {view: new Float64Array(new Matrix4()),
            projection: new Float32Array(new Matrix4().scale([scale, scale, 1])), position: [0, 0, 1]}}],
        tileLOD: {maxTiles: 10000, ...options}, ...overrides
    });
}

test('projected scale uses both eyes, device pixels and style cap, independent of eye order', () => {
    const renderer = new Renderer({});
    const coarse = createFrame(2.5);
    const fine = createFrame(4.5);
    const left = {...coarse.renderViews[0], id: 'left'};
    const right = {...fine.renderViews[0], id: 'right'};
    for (const eyes of [[left, right], [right, left]]) {
        renderer.setFrame(createFrame(2.5, {hysteresis: 0}, {renderViews: eyes}));
        expect(renderer.scene.view.center?.tile?.z).toBe(5);
        expect(renderer.scene.view.tile_zoom).toBe(8);
        expect(new Set(renderer.scene.view.findVisibleTileCoordinates().map(tile => tile.z))).toEqual(new Set([5]));
    }
    renderer.setFrame(createFrame(2.5, {pixelRatio: 2}));
    expect(renderer.scene.view.center?.tile?.z).toBe(4);
    renderer.setFrame(createFrame(2.5, {targetTilePixels: 1024}));
    expect(renderer.scene.view.center?.tile?.z).toBe(2);
    renderer.setFrame(createFrame(20));
    expect(renderer.scene.view.center?.tile?.z).toBeLessThanOrEqual(8);
});

test('zoom hysteresis suppresses threshold chatter, but resets when policy/manual mode changes', () => {
    const renderer = new Renderer({});
    for (const [projectedZoom, expected] of [[2.9, 3], [3.1, 3], [3.3, 4], [3.0, 4], [2.7, 3]]) {
        renderer.setFrame(createFrame(projectedZoom));
        expect(renderer.scene.view.center?.tile?.z).toBe(expected);
    }
    renderer.setFrame(createFrame(3.1, {hysteresis: 0}));
    expect(renderer.scene.view.center?.tile?.z).toBe(4);
    renderer.setFrame(createFrame(3.1, {}, {tileLOD: undefined, tileZoom: 2}));
    expect(renderer.scene.view.center?.tile?.z).toBe(2);
    renderer.setFrame(createFrame(2.9));
    expect(renderer.scene.view.center?.tile?.z).toBe(3);
});

test('budget coarsens before enumeration, includes both eyes, and preserves installed state on rejection', () => {
    const renderer = new Renderer({});
    const view = renderer.scene.view;
    const enumeration = vi.spyOn(view.visibility_adapter, 'findVisibleTileCoordinates');
    const left = {...createFrame(7).renderViews[0], id: 'left'};
    const right = {...left, id: 'right'};
    const frame = createFrame(7, {maxTiles: 40}, {tileBuffer: 1, renderViews: [left, right]});
    const observedFrames: (HostFrame | null)[] = [];
    view.subscribe({move: () => observedFrames.push(renderer.host_frame)});
    renderer.setFrame(frame);
    expect(observedFrames).toEqual([frame]);
    const count = view.findVisibleTileCoordinates().length;
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(20);
    expect(enumeration.mock.calls.every(([state]) => state.tile_zoom <= 3)).toBe(true);
    expect(view.tile_zoom).toBe(8);
    const installed = renderer.host_frame;
    const center = view.center;
    expect(() => renderer.setFrame(createFrame(7, {maxTiles: 1}, {tileBuffer: 1000000}))).toThrow(/even at zoom 0/);
    expect(renderer.host_frame).toBe(installed);
    expect(view.center).toBe(center);
    enumeration.mockRestore();
});

test('custom policies need conservative counters only when opting into automatic LOD', () => {
    const adapter = new WebMercatorVisibilityAdapter();
    const renderer = new Renderer({}, {visibilityAdapter: {
        calculateBounds: state => adapter.calculateBounds(state),
        findVisibleTileCoordinates: state => adapter.findVisibleTileCoordinates(state)
    }});
    expect(() => renderer.setFrame(createFrame(3, {}, {tileLOD: undefined}))).not.toThrow();
    expect(() => renderer.setFrame(createFrame(3))).toThrow(/candidate counter/);
});

test('empty planar footprint does not allocate tiles', () => {
    const renderer = new Renderer({});
    renderer.setFrame(createFrame(3, {maxTiles: 1}, {projection: {type: 'web-mercator', visibleBounds: null}}));
    expect(renderer.scene.view.findVisibleTileCoordinates()).toEqual([]);
});

test('candidate budgets recalculate custom footprints at every candidate data zoom', () => {
    const base = new WebMercatorVisibilityAdapter();
    const calculatedZooms: number[] = [];
    const renderer = new Renderer({}, {visibilityAdapter: {
        calculateBounds: state => {
            calculatedZooms.push(state.tile_zoom);
            const result = base.calculateBounds(state);
            if (state.tile_zoom < 8) {
                const edge = Geo.circumference_meters / 2;
                result.bounds = {sw: {x: -edge, y: -edge}, ne: {x: edge, y: edge}};
            }
            return result;
        },
        countTileCoordinates: state => base.countTileCoordinates(state),
        findVisibleTileCoordinates: state => base.findVisibleTileCoordinates(state)
    }});
    renderer.setFrame(createFrame(2.5, {maxTiles: 64}, {projection: {type: 'web-mercator'}}));
    expect(renderer.scene.view.center?.tile?.z).toBe(2);
    expect(calculatedZooms).toContain(3);
    expect(calculatedZooms).toContain(2);
    const coordinates = renderer.scene.view.findVisibleTileCoordinates();
    expect(coordinates).toHaveLength(25);
    expect(coordinates.every(tile => tile.z === 2)).toBe(true);
});

test.each(['map', 'first-person', 'globe'] as const)('%s real deck camera selects bounded uniform data detail without altering style zoom', kind => {
    const common = {width: 800, height: 600, longitude: 179.9, latitude: 40, zoom: 6, pitch: 40, bearing: 20};
    let options;
    if (kind === 'map') {
        const viewport = new WebMercatorViewport(common);
        options = {viewport: common, geographicAnchor: {...common, zoom: common.zoom + 1},
            renderViews: [{camera: getExternalCameraFrame(viewport)}]};
    } else if (kind === 'globe') {
        options = HostFrame.from(getGlobeViewFrame(new GlobeViewport(common)));
    } else {
        const viewport = new FirstPersonView().makeViewport({width: 800, height: 600,
            viewState: {...common, position: [0, 0, 100], pitch: 45}});
        if (!viewport) throw new Error('Missing first-person fixture viewport');
        options = HostFrame.from(getFirstPersonViewFrame(viewport));
    }
    const frame = new HostFrame({...options, tileLOD: {maxTiles: 64}});
    const renderer = new Renderer({});
    renderer.setFrame(frame);
    const coordinates = renderer.scene.view.findVisibleTileCoordinates();
    expect(coordinates.length).toBeGreaterThan(0);
    expect(coordinates.length).toBeLessThanOrEqual(64);
    expect(new Set(coordinates.map(tile => tile.z)).size).toBe(1);
    expect(renderer.scene.view.tile_zoom).toBe(Math.floor(frame.geographicAnchor.zoom));
});

test('candidate counters match planar enumeration and conservatively bound globe wrapping/horizon work', () => {
    const planar = new WebMercatorVisibilityAdapter();
    const globe = new WebMercatorGlobeVisibilityAdapter();
    for (const zoom of [0, 2, 6]) {
        for (const buffer of [0, 1, 3]) {
            const state = {center: {lng: 179, lat: 80}, zoom: 6, tile_zoom: zoom,
                size: {css: {width: 800, height: 600}}, bounds: null, wrap: true, buffer};
            const bounds = planar.calculateBounds(state).bounds;
            for (const wrap of [true, false]) {
                const input = {...state, bounds, wrap};
                expect(planar.countTileCoordinates(input)).toBe(planar.findVisibleTileCoordinates(input).length);
            }
            const input = {tile_zoom: zoom, buffer, visibleBounds: [170, -85, -170, 85] as const,
                maxElevation: 0, cameraPosition: [0, 512, 0] as const};
            expect(globe.countTileCoordinates(input)).toBeGreaterThanOrEqual(globe.findVisibleTileCoordinates(input).length);
        }
    }
});

test('typed-array planar camera bounds are identical to array bounds rather than identity projection', () => {
    const adapter = new WebMercatorVisibilityAdapter();
    const frame = createFrame(3);
    const camera = frame.renderViews[0].camera;
    const state = {camera, center: {lng: 0, lat: 0}, zoom: 8, tile_zoom: 3,
        size: {css: frame.viewport}, bounds: null, wrap: true, buffer: 0};
    const bounds = adapter.calculateBounds(state).bounds;
    expect(bounds.ne.x).toBeCloseTo(Geo.circumference_meters / 4, 0);
    expect(adapter.calculateBounds({...state, camera: {...camera, projection: Array.from(camera.projection)}}).bounds).toEqual(bounds);
});

test.each([0, -1, NaN, Infinity])('invalid pixel/budget value %s is rejected before installation', value => {
    for (const option of ['targetTilePixels', 'pixelRatio', 'maxTiles'] as const) {
        expect(() => createFrame(3, {[option]: value})).toThrow(/tileLOD/);
    }
});

test('policy validates dead band, integer budget and mutually exclusive overrides', () => {
    expect(() => createFrame(3, {hysteresis: 1})).toThrow(/tileLOD/);
    expect(() => createFrame(3, {hysteresis: -1})).toThrow(/tileLOD/);
    expect(() => createFrame(3, {maxTiles: 1.5})).toThrow(/tileLOD/);
    expect(() => createFrame(3, {}, {tileZoom: 1})).toThrow(/mutually exclusive/);
    expect(createFrame(3, {}, {tileLOD: {}}).tileLOD).toEqual({targetTilePixels: 512, pixelRatio: 1, maxTiles: 256, hysteresis: 0.2});
});

test('invalid counters cannot silently bypass budgets or poison hysteresis', () => {
    const selector = new ProjectedTileLOD();
    expect(() => selector.select(createFrame(3), [], () => NaN)).toThrow(/candidate count/);
    expect(selector.select(createFrame(3), [], () => 0)).toBe(8);
});
