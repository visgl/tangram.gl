// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Style} from '../src/styles/style';
import VertexLayout from '../src/gl/vertex_layout';
import {getFeatureRenderedGeneration} from '../src/styles/feature_annotations';
import type {StyleRuntime} from '../src/styles/style-runtime-types';

/** Create the actual inherited lifecycle without a GPU, worker, or replacement implementation. */
function createStyle(): StyleRuntime {
    const style: StyleRuntime = Object.create(Style);
    style.name = 'checked-style';
    style.base = 'polygons';
    style.lighting = false;
    style.init({generation: 1, styles: {}, sources: {}});
    return style;
}

test('finalization preserves tile, mesh, variant and transfer ownership while clearing the build slot', async () => {
    const style = createStyle();
    const layout = new VertexLayout([{name: 'a_position', size: 3, type: 0x1406}]);
    style.vertexLayoutForMeshVariant = () => layout;
    const tile = {id: 'checked'};
    const variant = {key: 'main', selection: 0, mesh_order: 0, blend_order: 0};
    style.startData(tile);
    const original = style.tile_data[tile.id];
    if (!original) throw new Error('Style did not start its tile');
    const meshes = original.meshes;
    const mesh = style.getTileMesh(tile, variant);
    const buildingVertices = mesh.vertex_data;
    buildingVertices.addVertex([0, 0, 0]);
    buildingVertices.addVertex([1, 0, 0]);
    buildingVertices.addVertex([0, 1, 0]);
    try {
        const transferred = await style.endData(tile);
        expect(transferred).toBe(original);
        expect(transferred?.meshes).toBe(meshes);
        expect(transferred?.meshes.main).toBe(mesh);
        expect(transferred?.meshes.main.variant).toBe(variant);
        expect(transferred?.meshes.main.vertex_data).toBe(buildingVertices.vertex_buffer);
        expect(transferred?.meshes.main.vertex_data.byteLength).toBe(3 * layout.stride);
        expect(style.tile_data[tile.id]).toBeNull();
        expect(await style.endData(tile)).toBeNull();
    } finally {style.destroy();}
});

test('shader composition retains null block entries and scope provenance without rewriting arrays', () => {
    const style = createStyle();
    const blocks = ['first', 'second'];
    const scopes = [null, ''] as (string | null)[];
    style.vertex_shader_src = 'vertex';
    style.fragment_shader_src = 'fragment';
    style.gl = null;
    style.shader_language = 'wgsl';
    style.getWGSLShaderSource = () => '';
    style.shader_factory = () => {throw new Error('Source composition must not allocate shaders');};
    style.shaders.blocks = {color: blocks, removed: null};
    style.shaders.block_scopes = {color: scopes, removed: null};
    try {
        style.compileSetup();
        expect(style.program?.blocks.color).toBe(blocks);
        expect(style.program?.blocks.removed).toBeNull();
        expect(style.program?.block_scopes.color).toBe(scopes);
        expect(style.program?.block_scopes.removed).toBeNull();
    } finally {style.destroy();}
});

test('abstract and empty geometry cannot mark a feature rendered in the current generation', () => {
    const style = createStyle();
    const feature = {geometry: {type: 'Point' as const, coordinates: [0, 0] as [number, number]}, properties: {}};
    style._parseFeature = () => ({});
    const context = {tile: {id: 'empty', generation: 1}, layers: ['markers']};
    try {
        style.addFeature(feature, {order: 0, layers: ['markers']}, context);
        expect(feature).toEqual({geometry: {type: 'Point', coordinates: [0, 0]}, properties: {}});
        expect(getFeatureRenderedGeneration(feature)).toBeUndefined();
        expect(style.tile_data.empty?.meshes).toEqual({});
    } finally {style.destroy();}
});
