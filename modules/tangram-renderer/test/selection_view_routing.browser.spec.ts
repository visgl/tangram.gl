// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import HostFrame from '../src/scene/host_frame';
import Renderer from '../src/scene/renderer';
import Scene from '../src/scene/scene';

afterEach(() => vi.restoreAllMocks());

/** Unequal, offset eye rectangles catch incorrect use of full-canvas or last-eye dimensions. */
function frame(): HostFrame {
    const camera = {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 1] as const};
    return new HostFrame({viewport: {width: 600, height: 300}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 2},
        renderViews: [{id: 'left', viewport: {x: 10, y: 20, width: 200, height: 200}, camera},
            {id: 'right', viewport: {x: 250, y: 30, width: 300, height: 250}, camera}]});
}

test('canvas coordinates choose the correct eye and treat seams/outside rectangles as half-open', () => {
    const host = frame();
    expect(host.resolveSelectionPoint({x: 260, y: 50}, {coordinateSpace: 'canvas'})).toMatchObject({
        view: {id: 'right'}, pixel: {x: 10, y: 20}});
    expect(host.resolveSelectionPoint({x: 209, y: 219}, {coordinateSpace: 'canvas'})?.view.id).toBe('left');
    for (const pixel of [{x: 210, y: 219}, {x: 550, y: 50}, {x: -1, y: 20}, {x: 260, y: 280}]) {
        expect(host.resolveSelectionPoint(pixel, {coordinateSpace: 'canvas'})).toBeNull();
    }
    expect(host.resolveSelectionPoint({x: 10, y: 20}, {renderViewId: 'right'})).toMatchObject({view: {id: 'right'}, pixel: {x: 10, y: 20}});
    expect(host.resolveSelectionPoint({x: 260, y: 50}, {coordinateSpace: 'canvas', renderViewId: 'left'})).toBeNull();
    expect(() => host.resolveSelectionPoint({x: 0, y: 0}, {renderViewId: 'missing'})).toThrow();
});

test('overlapping views use reverse render order; explicit view identity overrides it', () => {
    const host = frame();
    const overlay = new HostFrame({...host, renderViews: [...host.renderViews,
        {...host.renderViews[0], id: 'overlay'}]});
    expect(overlay.resolveSelectionPoint({x: 20, y: 30}, {coordinateSpace: 'canvas'})?.view.id).toBe('overlay');
    expect(overlay.resolveSelectionPoint({x: 20, y: 30}, {coordinateSpace: 'canvas', renderViewId: 'left'})?.view.id).toBe('left');
});

test('projected host cameras compose view and projection without changing the retained frame', () => {
    const renderer = new Renderer({});
    const view = new Matrix4().translate([3, 4, 0]);
    const projection = new Matrix4().scale([2, 2, 1]);
    const host = new HostFrame({...frame(), activeRenderViewId: 'projected', tileZoom: 2, projection: {type: 'projected', visibleBounds: [-10, -10, 10, 10]},
        renderViews: [{id: 'projected', camera: {view, projection, position: [0, 0, 1]}}]});
    const camera = vi.spyOn(renderer.scene, 'setCameraMatrices');
    renderer.setFrame(host);
    expect(camera).toHaveBeenCalledWith({view: new Float64Array(new Matrix4()),
        projection: new Float64Array(new Matrix4(projection).multiplyRight(view)), position: [0, 0, 1]});
    expect(host.renderViews[0].camera.view).toEqual(new Float64Array(view));
    renderer.destroy();
});

test('renderer queues the requested eye without changing its current camera and returns caller coordinates', async () => {
    const renderer = new Renderer({});
    renderer.setFrame(frame(), {renderViewId: 'left'});
    const query = vi.spyOn(renderer.scene, 'getFeatureAt').mockResolvedValue({feature: {name: 'right'}});
    expect(await renderer.getFeatureAt({x: 260, y: 50}, {coordinateSpace: 'canvas', radius: 4})).toEqual({
        feature: {name: 'right'}, pixel: {x: 260, y: 50}, renderViewId: 'right'});
    expect(query).toHaveBeenCalledWith({x: 10, y: 20}, {renderViewId: 'right', radius: 4, width: 300, height: 250});
    expect(renderer.active_render_view_id).toBe('left');
    expect((await renderer.getFeatureAt({x: 599, y: 299}, {coordinateSpace: 'canvas'}))?.feature).toBeNull();
    expect(query).toHaveBeenCalledOnce();
    await expect(renderer.getFeatureAt({x: 0, y: 0}, {renderViewId: 'unknown'})).rejects.toThrow();
    await expect(renderer.getFeatureAt({x: NaN, y: 0})).rejects.toThrow('finite');
    renderer.destroy();
    await expect(renderer.getFeatureAt({x: 0, y: 0})).rejects.toThrow('destroyed');
});

test('selection targets, pending compilation locks and request lifetimes are isolated per eye', async () => {
    const createTexture = vi.fn(() => ({destroy: vi.fn()}));
    const scene = Object.assign(Scene.create({}), {initialized: true, selection_feature_count: 1,
        device: {createTexture, createFramebuffer: vi.fn(() => ({destroy: vi.fn()}))}});
    scene.setFeatureSelectionView('left', ['left', 'right']);
    const left = scene.getFeatureAt({x: 100, y: 100}, {renderViewId: 'left', width: 200, height: 200});
    const leftState = scene.getFeatureSelectionView('left');
    expect(scene.selection).toBe(leftState.selection); // A subsequent render need not repeat setFrame.
    scene.setFeatureSelectionView('left', ['left', 'right']);
    expect(scene.selection).toBe(leftState.selection);
    scene.selection_render_pending = true;
    scene.last_selection_render = 20;
    const right = scene.getFeatureAt({x: 150, y: 125}, {renderViewId: 'right', width: 300, height: 250});
    const rightState = scene.getFeatureSelectionView('right');
    expect(leftState.selection.requests[0].point).toEqual({x: 0.5, y: 0.5});
    expect(rightState.selection.requests[0].point).toEqual({x: 0.5, y: 0.5});
    scene.setFeatureSelectionView('right', ['left', 'right']);
    expect(scene.selection).toBe(rightState.selection);
    expect(scene.selection?.locked).toBe(false);
    expect(leftState.selection.locked).toBe(true);
    expect(scene.last_selection_render).toBe(-1);
    scene.setFeatureSelectionView('left', ['left', 'right']);
    expect(scene.last_selection_render).toBe(20);
    expect(scene.selection_render_pending).toBe(true);
    scene.setFeatureSelectionView('left', ['left']);
    expect((await right)?.error).toBeInstanceOf(Error);
    expect(scene.selection_views.has('right')).toBe(false);
    scene.destroyFeatureSelection();
    expect((await left)?.error).toBeInstanceOf(Error);
    expect(createTexture).toHaveBeenCalledTimes(2);
});
