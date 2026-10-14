// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {requireTileManager} from './helpers/scene-owners';
import {expect, test, vi} from 'vitest';
import Tile from '../src/tile/tile';
import Scene from '../src/scene/scene';
import VBOMesh from '../src/gl/vbo_mesh';
import VertexLayout from '../src/gl/vertex_layout';
import type {MeshContext} from '../src/gl/mesh-types';
import TileManager from '../src/tile/tile_manager';
import Task, {type TaskRecord} from '../src/utils/task';

const context = document.createElement('canvas').getContext('webgl2');

/** Tile/resource identity remains real; only GPU allocation is replaced for lifecycle assertions. */
function tile() {
    return new Tile({coords: {x: 0, y: 0, z: 0}, style_z: 0, source: {name: 'ground', id: 0, tiled: true, max_zoom: 14, zooms: [0]}, workers: [{postMessage: vi.fn(), addEventListener: vi.fn()}], view: {}});
}
/** Real tiny GPU owners exercise buffer cleanup as well as the tile lifecycle. */
function mesh() {
    if (!context) throw new Error('Missing WebGL 2 fixture context');
    const bufferContext: MeshContext = {STATIC_DRAW: context.STATIC_DRAW, ARRAY_BUFFER: context.ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER: context.ELEMENT_ARRAY_BUFFER,
        createBuffer: context.createBuffer.bind(context), bindBuffer: context.bindBuffer.bind(context), bufferData: context.bufferData.bind(context),
        drawElements: context.drawElements.bind(context), drawArrays: context.drawArrays.bind(context), deleteBuffer: context.deleteBuffer.bind(context),
        getExtension: context.getExtension.bind(context), enableVertexAttribArray: context.enableVertexAttribArray.bind(context),
        disableVertexAttribArray: context.disableVertexAttribArray.bind(context), vertexAttribPointer: context.vertexAttribPointer.bind(context)};
    const mesh = new VBOMesh(bufferContext, new Uint8Array(12), new Uint16Array(), new VertexLayout([{name: 'a_position', size: 3, type: 5126}]));
    vi.spyOn(mesh, 'destroy'); return mesh;
}

test('incremental replacement uploads retain old draw owners until a shared generation commit', () => {
    const first = tile(), second = tile(), previous = mesh(), replacement = mesh(), label = mesh();
    first.meshes = {ground: [previous]}; first.beginTerrainStage(); second.beginTerrainStage();
    vi.spyOn(first, 'buildMeshBatch').mockImplementation(() => {first.meshes = {ground: [replacement]}; first.pending_label_meshes = {labels: [label]};});
    first.buildMeshes({}, {done: true});
    expect(first.meshes.ground[0]).toBe(previous); expect(previous.destroy).not.toHaveBeenCalled();
    expect(first.terrainStage?.meshes.ground[0]).toBe(replacement);
    first.commitTerrainStage(100); second.commitTerrainStage(100);
    expect(first.meshes.ground[0]).toBe(replacement); expect(first.pending_label_meshes?.labels[0]).toBe(label);
    expect(replacement.terrainVisibleAt).toBe(100); expect(label.terrainVisibleAt).toBe(100);
    expect(previous.destroy).toHaveBeenCalledOnce(); expect(first.terrainStage).toBeUndefined();
    first.freeResources(); second.freeResources();
    expect(replacement.destroy).toHaveBeenCalledOnce(); expect(label.destroy).toHaveBeenCalledOnce();
});

test('cancelled and partially failed stages release only replacement buffers and restore display ownership', () => {
    const owner = tile(), previous = mesh(), replacement = mesh(); owner.meshes = {ground: [previous]}; owner.beginTerrainStage();
    vi.spyOn(owner, 'buildMeshBatch').mockImplementation(() => {owner.meshes = {ground: [replacement]}; throw new Error('upload');});
    expect(() => owner.buildMeshes({}, {})).toThrow('upload'); expect(owner.meshes.ground[0]).toBe(previous);
    owner.beginTerrainStage(); expect(replacement.destroy).toHaveBeenCalledOnce(); expect(previous.destroy).not.toHaveBeenCalled();
    owner.discardTerrainStage(); owner.discardTerrainStage(); owner.commitTerrainStage(2);
    owner.freeResources(); expect(previous.destroy).toHaveBeenCalledOnce();
});

test.each([false, true])('scene completion admits or rejects the entire terrain mesh generation (failure=%s)', failed => {
    const scene = Scene.create({}, {terrain: {grids: []}}), first = tile(), second = tile();
    const firstMesh = mesh(), secondMesh = mesh(); first.beginTerrainStage(); second.beginTerrainStage();
    if (!first.terrainStage || !second.terrainStage) throw new Error('Missing stage');
    first.terrainStage.meshes = {ground: [firstMesh]}; second.terrainStage.meshes = {ground: [secondMesh]};
    requireTileManager(scene).tiles = {first, second}; scene.terrainTransaction = true;
    const resolve = vi.fn(), reject = vi.fn(); Object.assign(scene, {generation: 7, building: {resolve, reject, error: failed ? new Error('budget') : undefined}});
    vi.spyOn(scene, 'logFirstBuild').mockImplementation(() => {});
    vi.spyOn(requireTileManager(scene), 'publishTerrainDisplay').mockImplementation(() => {});
    vi.spyOn(requireTileManager(scene), 'updateLabels').mockResolvedValue({});
    scene.tileManagerBuildDone();
    if (failed) {expect(reject).toHaveBeenCalledOnce(); expect(firstMesh.destroy).toHaveBeenCalledOnce(); expect(first.meshes).toEqual({});}
    else {expect(resolve).toHaveBeenCalledWith(true); expect(firstMesh.terrainVisibleAt).toBe(secondMesh.terrainVisibleAt); expect(scene.terrainDisplayGeneration).toBe(7);}
    requireTileManager(scene).tiles = {}; first.freeResources(); second.freeResources(); scene.destroy();
});

test('staged-byte admission fails before allocating GPU owners and keeps the previous ground', () => {
    const scene = Scene.create({}, {terrain: {grids: [], maxStagedMeshBytes: 1}}), owner = tile();
    Object.assign(scene, {generation: 1}); scene.terrainTransaction = true; owner.generation = 1; const previous = mesh(); owner.meshes = {ground: [previous]}; owner.beginTerrainStage();
    requireTileManager(scene).tiles = {[owner.key]: owner};
    const error = vi.spyOn(scene, 'tileManagerBuildError').mockImplementation(() => {});
    vi.spyOn(requireTileManager(scene), 'tileBuildStop').mockImplementation(() => {});
    vi.spyOn(Tile, 'abortBuild').mockImplementation(() => {});
    requireTileManager(scene).buildTileStylesCompleted({tile: {...Tile.slice(owner), mesh_data: {ground: {meshes: {a: {vertex_data: new Uint8Array(12), variant: {}}}}}}, progress: {done: true}});
    expect(error).toHaveBeenCalledWith(expect.objectContaining({message: 'Terrain staged mesh-byte budget exceeded'}));
    expect(previous.destroy).not.toHaveBeenCalled(); expect(owner.meshes.ground[0]).toBe(previous);
    requireTileManager(scene).tiles = {}; owner.freeResources(); scene.destroy();
});

test('a staged GPU upload failure releases unattached new buffers, aborts the raw batch and preserves admitted owners', () => {
    const scene = Scene.create({}, {terrain: {grids: []}}), owner = tile(), previous = mesh(), uploaded = mesh();
    Object.assign(scene, {generation: 1, styles: {first: {makeMesh: () => uploaded}, second: {makeMesh: () => {throw new Error('allocation');}}}, withWebGLContext: (operation: () => void) => operation()});
    scene.terrainTransaction = true; owner.generation = 1; owner.meshes = {ground: [previous]}; owner.beginTerrainStage();
    requireTileManager(scene).tiles = {[owner.key]: owner};
    const error = vi.spyOn(scene, 'tileManagerBuildError').mockImplementation(() => {});
    vi.spyOn(requireTileManager(scene), 'tileBuildStop').mockImplementation(() => {});
    const abort = vi.spyOn(Tile, 'abortBuild').mockImplementation(() => {});
    const batch = {first: {meshes: {a: {vertex_data: new Uint8Array(12), variant: {}}}}, second: {meshes: {a: {vertex_data: new Uint8Array(12), variant: {}}}}};
    requireTileManager(scene).buildTileStylesCompleted({tile: {...Tile.slice(owner), loaded: true, mesh_data: batch}, progress: {done: true}});
    expect(error).toHaveBeenCalledWith(expect.objectContaining({message: 'allocation'}));
    expect(uploaded.destroy).toHaveBeenCalledOnce(); expect(previous.destroy).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledWith(expect.objectContaining({mesh_data: batch}));
    requireTileManager(scene).tiles = {}; owner.freeResources(); scene.destroy();
});

test('query membership preserves the admitted clock, proxy visibility, fallback clips and separate staged bytes', () => {
    const owner = tile(), ground = mesh(), ignored = mesh(), staged = mesh();
    const query = {positions: new Float64Array([-1, -1, 0, 1, -1, 0, -1, 1, 0]), heights: new Float32Array(6), indices: new Uint16Array([0, 1, 2]), bounds: [-1, -1, 1, 1] as const};
    ground.terrainQueryMesh = query; staged.terrainQueryMesh = query; ground.terrainVisibleAt = 100;
    Object.assign(ground, {variant: {terrainTransitionDuration: 200, terrainStatistics: {vertices: 3, triangles: 1, suppressedTriangles: 0, meshBytes: 12, preparationMs: 1, detailLimited: false}}});
    Object.assign(owner, {fallback_for: new Map([['child', [0, -4096, 4096, 0]]])}); owner.meshes = {ground: [ground], other: [ignored]};
    owner.beginTerrainStage(); if (!owner.terrainStage) throw new Error('Missing stage'); owner.terrainStage.labels = {staged: [staged]};
    const manager = Object.create(TileManager.prototype); Object.defineProperty(manager, 'tiles', {value: {owner}}); manager.renderable_tiles = [owner];
    const entries = manager.getDrapedTerrainQueryEntries(200);
    expect(entries).toHaveLength(1); expect(entries[0].mesh).toBe(query); expect(entries[0].blend).toBe(0.5);
    const halfWorld = Math.PI * 6378137; expect(entries[0].clips).toEqual([[-halfWorld, -halfWorld, halfWorld, halfWorld]]);
    expect(manager.getTerrainDrapingStatistics()).toMatchObject({queryBytes: 102, stagedMeshBytes: 114});
    expect(manager.getDrapedTerrainQueryEntries(50)[0].blend).toBe(0); expect(manager.getDrapedTerrainQueryEntries(400)[0].blend).toBe(1);
    ground.terrainVisibleAt = undefined; expect(manager.getDrapedTerrainQueryEntries(200)[0].blend).toBe(0);
    expect(ground.terrainVisibleAt).toBe(200);
    expect(manager.getDrapedTerrainQueryEntries(250)[0].blend).toBe(0.25);
    ground.valid = false; expect(manager.getDrapedTerrainQueryEntries(200)).toEqual([]); ground.valid = true;
    Object.assign(owner, {proxy_for: [{meshes: {ground: [ground]}}]}); expect(manager.getDrapedTerrainQueryEntries(200)).toEqual([]);
    owner.freeResources();
});

test('generation publication refreshes draw/proxy ownership without pumping source loads', () => {
    const manager = Object.create(TileManager.prototype); manager.renderable_tiles = [];
    manager.updateProxyTiles = vi.fn(); manager.updateGlobeFallbackTiles = vi.fn(); manager.updateRenderableTiles = vi.fn();
    manager.scene = {style_manager: {updateActiveStyles: vi.fn(), updateActiveBlendOrders: vi.fn()}};
    manager.publishTerrainDisplay();
    expect(manager.updateProxyTiles).toHaveBeenCalledOnce(); expect(manager.updateGlobeFallbackTiles).toHaveBeenCalledOnce(); expect(manager.updateRenderableTiles).toHaveBeenCalledOnce();
    expect(manager.style_manager.updateActiveStyles).toHaveBeenCalledWith([]); expect(manager.style_manager.updateActiveBlendOrders).toHaveBeenCalledWith([]);
});

test('cooperative label work keeps a host renderer advancing even before staged geometry becomes drawable', async () => {
    const scene = Scene.create({}), redraw = vi.spyOn(scene, 'requestRedraw');
    const task: TaskRecord<void> = {run: vi.fn(() => true)};
    const completion = Task.add(task);
    try {
        scene.processTasks(); expect(redraw).toHaveBeenCalledOnce();
        await Task.finish(task, undefined); await completion;
        scene.processTasks(); expect(redraw).toHaveBeenCalledOnce();
    }
    finally {
        Task.remove(task); scene.destroy();
    }
});
