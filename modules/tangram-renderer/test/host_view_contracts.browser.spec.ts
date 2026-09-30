// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import HostFrame from '../src/scene/host_frame';
import Renderer from '../src/scene/renderer';
import ClassicScene from '../src/scene/classic_scene';
import ExternalCamera from '../src/scene/external_camera';
import {PerspectiveCamera} from '../src/scene/camera';
import {WebMercatorVisibilityAdapter, WebMercatorGlobeVisibilityAdapter} from '../src/scene/visibility_adapter';
import {TileID} from '../src/tile/tile_id';
import Geo from '../src/utils/geo';
import type {HostCamera, HostFrameOptions} from '../src/types';

function camera(offset = 0): HostCamera {
    return {view: new Float64Array(new Matrix4().translate([offset, 0, 0])), projection: new Float32Array(new Matrix4()), position: [offset, 0, 0]};
}

function frame(overrides: Partial<HostFrameOptions> = {}): HostFrame {
    return new HostFrame({
        viewport: {width: 800, height: 600},
        geographicAnchor: {longitude: -74, latitude: 40.7, zoom: 4},
        renderViews: [{id: 'left', camera: camera(-1)}, {id: 'right', camera: camera(1)}],
        ...overrides
    });
}

afterEach(() => vi.restoreAllMocks());

describe('atomic multi-view host contract', () => {
    test('invalidates elevation-only changes without reselecting on an eye switch', () => {
        const renderer = new Renderer({});
        const selection = vi.spyOn(renderer.scene.view.scene.tile_manager, 'updateTilesForView');
        const projection = {type: 'globe', visibleBounds: [-100, 20, -50, 60]} as const;
        renderer.setFrame(frame({projection}));
        selection.mockClear();
        renderer.setFrame(frame({projection: {...projection, maxElevation: 3000}}));
        expect(selection).toHaveBeenCalledTimes(1);
        selection.mockClear();
        renderer.setFrame(frame({projection: {...projection, maxElevation: 3000}}));
        renderer.setFrame(renderer.host_frame, {renderViewId: 'right'});
        expect(selection).not.toHaveBeenCalled();
        expect(renderer.scene.view.projection).toMatchObject({maxElevation: 3000});
    });

    test('selects tiles only after camera, projection, anchor, dimensions, and buffer are installed', () => {
        const renderer = new Renderer({});
        const view = renderer.scene.view;
        const selection = vi.spyOn(view.scene.tile_manager, 'updateTilesForView').mockImplementation(() => {
            expect(view.camera?.position_meters).toEqual([-1, 0, 0]);
            expect(view.projection.type).toBe('globe');
            expect(view.center).toMatchObject({lng: 10, lat: 20});
            expect(view.size.css).toEqual({width: 400, height: 300});
            expect(view.buffer).toBe(2);
        });
        renderer.setFrame(frame({
            geographicAnchor: {longitude: 10, latitude: 20, zoom: 3},
            projection: {type: 'globe', visibleBounds: [-20, -20, 30, 30]},
            tileBuffer: 2,
            renderViews: [{id: 'left', viewport: {width: 400, height: 300}, camera: camera(-1)}]
        }));
        expect(selection).toHaveBeenCalledTimes(1);
    });

    test('invalidates camera-only and buffer-only changes, but not identical frames or eye switches', () => {
        const renderer = new Renderer({});
        const selection = vi.spyOn(renderer.scene.view.scene.tile_manager, 'updateTilesForView');
        renderer.setFrame(frame());
        selection.mockClear();
        renderer.setFrame(frame());
        renderer.setFrame(renderer.host_frame, {renderViewId: 'right'});
        expect(selection).not.toHaveBeenCalled();
        renderer.setFrame(frame({renderViews: [{camera: camera(2)}]}));
        expect(selection).toHaveBeenCalledTimes(1);
        selection.mockClear();
        renderer.setFrame(frame({renderViews: [{camera: camera(2)}], tileBuffer: 2}));
        expect(selection).toHaveBeenCalledTimes(1);
    });

    test('unions per-eye planar policies without letting active-eye order change tile membership', () => {
        const policy = new WebMercatorVisibilityAdapter();
        const left = TileID.coord({x: 2, y: 3, z: 4});
        const right = TileID.coord({x: 4, y: 3, z: 4});
        const find = vi.spyOn(policy, 'findVisibleTileCoordinates').mockImplementation(state =>
            state.camera?.position[0] === -1 ? [left] : [right, left]
        );
        const renderer = new Renderer({}, {visibilityAdapter: policy});
        const stereo = frame({renderViews: [
            {id: 'left', viewport: {width: 400, height: 600}, camera: camera(-1), geographicAnchor: {longitude: -75, latitude: 40, zoom: 4}},
            {id: 'right', viewport: {x: 400, width: 400, height: 600}, camera: camera(1), geographicAnchor: {longitude: -73, latitude: 40, zoom: 4}}
        ]});
        renderer.setFrame(stereo);
        expect(renderer.scene.view.findVisibleTileCoordinates()).toEqual([left, right]);
        expect(find.mock.calls.some(([state]) => state.center.lng === -75 && state.size.css.width === 400)).toBe(true);
        renderer.setFrame(stereo, {renderViewId: 'right'});
        expect(renderer.scene.view.findVisibleTileCoordinates()).toEqual([left, right]);
    });

    test('uses both globe eye positions and bounds for a conservative visible union', () => {
        const policy = new WebMercatorGlobeVisibilityAdapter();
        const leftProjection = {type: 'globe', visibleBounds: [-100, 20, -50, 60]} as const;
        const rightProjection = {type: 'globe', visibleBounds: [50, -60, 100, -20]} as const;
        const expected = new Map([
            ...policy.findVisibleTileCoordinates({tile_zoom: 4, buffer: 0, visibleBounds: leftProjection.visibleBounds}),
            ...policy.findVisibleTileCoordinates({tile_zoom: 4, buffer: 0, visibleBounds: rightProjection.visibleBounds})
        ].map(coordinate => [coordinate.key, coordinate]));
        const renderer = new Renderer({});
        const stereo = frame({
            projection: leftProjection,
            renderViews: [{id: 'left', camera: camera(), projection: leftProjection}, {id: 'right', camera: camera(), projection: rightProjection}]
        });
        renderer.setFrame(stereo);
        expect(new Set(renderer.scene.view.findVisibleTileCoordinates().map(coordinate => coordinate.key))).toEqual(new Set(expected.keys()));
        renderer.setFrame(stereo, {renderViewId: 'right'});
        expect(new Set(renderer.scene.view.findVisibleTileCoordinates().map(coordinate => coordinate.key))).toEqual(new Set(expected.keys()));
    });

    test('passes inherited and raised height bounds to each eye visibility policy', () => {
        const renderer = new Renderer({});
        const find = vi.spyOn(renderer.scene.view.globe_visibility_adapter, 'findVisibleTileCoordinates');
        const projection = {type: 'globe', visibleBounds: [-100, 20, -50, 60], maxElevation: 3000} as const;
        renderer.setFrame(frame({projection, renderViews: [
            {id: 'left', camera: camera(-1), projection: {type: 'globe', visibleBounds: projection.visibleBounds}},
            {id: 'right', camera: camera(1), projection: {...projection, maxElevation: 9000}}
        ]}));
        renderer.scene.view.findVisibleTileCoordinates();
        expect(find.mock.calls.some(([state]) => state.maxElevation === 3000 && state.cameraPosition?.[0] === -1)).toBe(true);
        expect(find.mock.calls.some(([state]) => state.maxElevation === 9000 && state.cameraPosition?.[0] === 1)).toBe(true);
    });

    test('retains visible tiles from either eye during pruning', () => {
        const renderer = new Renderer({});
        renderer.setFrame(frame());
        const remove = vi.spyOn(renderer.scene.view.scene.tile_manager, 'removeTiles');
        renderer.scene.view.pruneTilesForView();
        const predicate = remove.mock.calls[0][0];
        expect(predicate({
            visible: true, loading: false, style_z: 20, coords: TileID.coord({x: 0, y: 0, z: 20}),
            key: 'other-eye', isProxy: () => false, setupProgram: () => {}
        })).toBe(false);
    });

    test('unions shifted planar frusta using the default policy and falls back for singular cameras', () => {
        const renderer = new Renderer({});
        const stereo = frame({
            geographicAnchor: {longitude: 0, latitude: 0, zoom: 22},
            renderViews: [{id: 'left', camera: camera(-500)}, {id: 'right', camera: camera(500)}]
        });
        renderer.setFrame(stereo);
        const coordinates = renderer.scene.view.findVisibleTileCoordinates();
        const expected = new Set(
            [-500, 500].map(offset => TileID.coord(Geo.tileForMeters([-offset, 0], 22)).key)
        );
        expect(coordinates.some(coordinate => expected.has(coordinate.key))).toBe(true);
        for (const key of expected) {
            expect(coordinates.map(coordinate => coordinate.key)).toContain(key);
        }
        renderer.setFrame(frame({renderViews: [{camera: {view: new Float64Array(16), projection: new Float32Array(16), position: [0, 0, 0]}}]}));
        expect(renderer.scene.view.findVisibleTileCoordinates().length).toBeGreaterThan(0);
    });

    test('advances implicit time when a mono frame is reused without advancing between eyes', () => {
        const renderer = new Renderer({});
        vi.spyOn(renderer.scene, 'updateScene').mockReturnValue(true);
        const tasks = vi.spyOn(renderer.scene, 'processTasks');
        vi.spyOn(Date, 'now').mockReturnValue(renderer.scene.start_time + 1000);
        const stereo = frame();
        renderer.render({frame: stereo, renderViewId: 'left'});
        vi.mocked(Date.now).mockReturnValue(renderer.scene.start_time + 2000);
        renderer.render({renderViewId: 'right'});
        expect(renderer.scene.host_animation_time).toBe(1);
        expect(tasks).toHaveBeenCalledTimes(1);
        renderer.render({renderViewId: 'left'});
        expect(renderer.scene.host_animation_time).toBe(2);
        expect(tasks).toHaveBeenCalledTimes(2);
    });

    test.each([
        {name: 'skipped mono', eyes: ['left'], results: [false]},
        {name: 'skipped stereo', eyes: ['left', 'right'], results: [false, false]},
        {name: 'skipped first eye', eyes: ['left', 'right'], results: [false, true]},
        {name: 'skipped second eye', eyes: ['left', 'right'], results: [true, false]}
    ])('tracks submissions and advances reused frames for $name', ({eyes, results}) => {
        const renderer = new Renderer({});
        const submittedTimes: (number | null)[] = [];
        let submission = 0;
        vi.spyOn(renderer.scene, 'updateScene').mockImplementation(() => {
            submittedTimes.push(renderer.scene.host_animation_time);
            return results[submission++ % results.length];
        });
        const tasks = vi.spyOn(renderer.scene, 'processTasks');
        const now = vi.spyOn(Date, 'now');
        const sharedFrame = frame();
        for (let cycle = 0; cycle < 2; cycle++) {
            for (const [eyeIndex, eye] of eyes.entries()) {
                now.mockReturnValue(renderer.scene.start_time + (cycle * 2 + eyeIndex + 1) * 1000);
                expect(renderer.render({frame: sharedFrame, renderViewId: eye})).toBe(results[eyeIndex]);
                expect(tasks).toHaveBeenCalledTimes(cycle + 1);
            }
        }
        expect(submittedTimes).toEqual([...eyes.map(() => 1), ...eyes.map(() => 3)]);
    });

    test('starts a fresh explicit-time frame even when every eye skips drawing', () => {
        const renderer = new Renderer({});
        vi.spyOn(renderer.scene, 'updateScene').mockReturnValue(false);
        const tasks = vi.spyOn(renderer.scene, 'processTasks');
        for (const animationTime of [4, 7]) {
            const sharedFrame = frame({animationTime});
            renderer.render({frame: sharedFrame, renderViewId: 'left'});
            renderer.render({renderViewId: 'right'});
            expect(renderer.scene.host_animation_time).toBe(animationTime);
        }
        expect(tasks).toHaveBeenCalledTimes(2);
    });

    test.each([NaN, Infinity, 1e100])('rejects non-finite GPU projection values (%s)', value => {
        const projection = new Float64Array(new Matrix4());
        projection[0] = value;
        expect(() => frame({renderViews: [{camera: {...camera(), projection}}]})).toThrow(/finite camera/);
    });

    test('rejects mixed projection types in a shared scene frame', () => {
        expect(() => frame({renderViews: [{camera: camera(), projection: {type: 'globe', visibleBounds: [-10, -10, 10, 10]}}]})).toThrow(/share a projection/);
    });

    test('rejects unknown eyes and malformed frames without mutating the scene', () => {
        const renderer = new Renderer({});
        const stereo = frame();
        renderer.setFrame(stereo);
        const before = renderer.scene.view.camera?.view_matrix.slice();
        expect(() => renderer.setFrame(stereo, {renderViewId: 'missing'})).toThrow(/not found/);
        expect(() => renderer.setFrame({})).toThrow(/viewport/);
        expect(renderer.host_frame).toBe(stereo);
        expect(renderer.scene.view.camera?.view_matrix).toEqual(before);
    });

    test('shares explicit and implicit animation time across eyes', () => {
        const renderer = new Renderer({});
        vi.spyOn(Date, 'now').mockReturnValue(renderer.scene.start_time + 1000);
        const stereo = frame();
        renderer.setFrame(stereo);
        expect(renderer.scene.host_animation_time).toBe(1);
        vi.mocked(Date.now).mockReturnValue(renderer.scene.start_time + 2000);
        renderer.setFrame(stereo, {renderViewId: 'right'});
        expect(renderer.scene.host_animation_time).toBe(1);
        renderer.setFrame(frame({animationTime: 7}));
        expect(renderer.scene.host_animation_time).toBe(7);
    });

    test('keeps classic camera creation optional and preserves its configured view', () => {
        const renderer = new Renderer({});
        expect(renderer.scene.view.camera).toBeInstanceOf(ExternalCamera);
        const classic = new ClassicScene({}, {disableRenderLoop: true});
        classic.config = {cameras: {main: {type: 'perspective', position: [-74, 40, 4]}}};
        classic.resizeMap(800, 600);
        classic.view.reset();
        expect(classic.view.camera).toBeInstanceOf(PerspectiveCamera);
        expect(classic.view.center).toMatchObject({lng: -74, lat: 40});
        expect(classic.view.zoom).toBe(4);
        classic.view.update();
        expect(classic.view.camera?.projection_matrix.every(Number.isFinite)).toBe(true);
    });
});
