// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';
import Scene from '../src/scene/scene';
import HostFrame from '../src/scene/host_frame';
import Tile from '../src/tile/tile';
import type {LabelTile, LabelMesh} from '../src/labels/main-pass-types';

afterEach(() => vi.restoreAllMocks());

/** A loaded projected point mesh with a retained worker candidate. */
function createTile(id: number) {
    const vertices = new Uint8Array(24 * 4);
    const data = new DataView(vertices.buffer);
    for (let index = 0; index < 4; index++) {
        data.setInt16(index * 24 + 12, (index % 2 ? 10 : -10) * 256, true);
        data.setInt16(index * 24 + 14, (index < 2 ? 10 : -10) * 256, true);
        data.setInt16(index * 24 + 18, 1, true);
    }
    const mesh: LabelMesh = {valid: true, vertex_data: vertices,
        vertex_layout: {stride: 24, offset: {a_projected_position: 0, a_shape: 12}},
        labels: {[id]: {container: {label: {id, type: 'point', position: [0, 0], layout: {
            collide: false, projected_collide: true, projected_identity: 'source/style/shared', priority: 1, buffer: [0, 0]
        }}}, ranges: [[0, 4]]}}, upload: vi.fn()};
    const tile: LabelTile & {valid: boolean; built: boolean; fallback_for: null} = {
        valid: true, built: true, fallback_for: null, coords: {z: 2}, style_z: 6, build_id: id,
        min: {x: 0, y: 0}, span: {x: 1}, meshes: {points: [mesh]}, pending_label_meshes: null,
        isProxy: () => false, swapPendingLabels() {Tile.prototype.swapPendingLabels.call(this);}
    };
    return {tile, mesh, data};
}

test('pending child labels retire an older proxy before drawing, including an unchanged subsequent frame', () => {
    const scene = Scene.create({});
    const proxy = createTile(1), child = createTile(2);
    child.tile.pending_label_meshes = child.tile.meshes;
    child.tile.meshes = {};
    proxy.tile.isProxy = () => true;
    proxy.tile.shouldProxyForStyle = style => child.tile.meshes[style] == null;
    const manager = Object.assign(scene.tile_manager, {renderable_tiles: [proxy.tile, child.tile]});
    const states = vi.spyOn(manager, 'updateTileStates').mockImplementation(() => Promise.resolve({}));
    vi.spyOn(scene.style_manager, 'updateActiveStyles').mockReturnValue([]);
    vi.spyOn(scene.style_manager, 'updateActiveBlendOrders').mockImplementation(() => {});
    const camera = {view: new Matrix4(), projection: new Matrix4(), position: [0, 0, 1] as const};
    const frame = new HostFrame({viewport: {width: 200, height: 200}, geographicAnchor: {longitude: 0, latitude: 0, zoom: 6},
        projection: {type: 'projected', visibleBounds: [-180, -80, 180, 80]}, tileZoom: 2, renderViews: [{id: 'main', camera}]});
    manager.updateProjectedLabels(frame, false);
    expect(states).toHaveBeenCalledOnce();
    expect(child.tile.pending_label_meshes).toBeNull();
    expect(proxy.tile.shouldProxyForStyle('points')).toBe(false);
    expect(child.data.getInt16(18, true)).toBe(1);
    manager.updateProjectedLabels(frame, false);
    expect(child.data.getInt16(18, true)).toBe(1);
    expect(states).toHaveBeenCalledOnce();
    scene.destroy();
});
