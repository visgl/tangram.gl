// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Lines} from '../src/styles/lines/lines';
import {Polygons} from '../src/styles/polygons/polygons';
import type {GeometryContext, GeometryStyleRuntime, LineStyleRuntime, RawGeometryDraw} from '../src/styles/geometry-style-types';
import VertexLayout from '../src/gl/vertex_layout';
import VertexData from '../src/gl/vertex_data';
import VertexArrayObject from '../src/gl/vao';
import type {VertexArrayContext} from '../src/gl/vao';
import gl from '../src/gl/constants';

const styles: (GeometryStyleRuntime | LineStyleRuntime)[] = [];

/** Create the same prototype-based style runtime used by the scene worker. */
function createStyle(shaderLanguage: 'glsl' | 'wgsl', kind: 'lines'): LineStyleRuntime;
function createStyle(shaderLanguage: 'glsl' | 'wgsl', kind: 'polygons'): GeometryStyleRuntime;
function createStyle(shaderLanguage: 'glsl' | 'wgsl', kind: 'lines' | 'polygons'): GeometryStyleRuntime | LineStyleRuntime {
  const style: GeometryStyleRuntime | LineStyleRuntime = Object.create(kind === 'lines' ? Lines : Polygons);
  style.init({generation: 1, styles: {[kind]: style}, shader_language: shaderLanguage});
  styles.push(style);
  style.feature_style.order = 10;
  style.feature_style.selection_color = [1, 0, 0, 1];
  return style;
}

/** Supply stable tile conversions without provider requests or camera state. */
function createContext(): GeometryContext {
  return {
    feature: {geometry: {type: 'Polygon'}, properties: {height: 20, min_height: 5}},
    zoom: 16, units_per_meter_overzoom: 2, meters_per_pixel: 1,
    tile: {id: 'geometry', pad_scale: 0.001, overzoom2: 1}, winding: 'CW'
  };
}

/** Authored values enter preprocessing without a precomputed mesh variant. */
function createDraw(overrides: Partial<RawGeometryDraw> = {}): RawGeometryDraw {
  return {layers: ['roads'], style: 'lines', color: [0.25, 0.5, 1, 1], width: 4, ...overrides};
}

afterEach(() => {
  styles.splice(0).forEach(style => style.destroy());
  VertexArrayObject.disabled = false;
  VertexArrayObject.bound_vao = [];
  VertexData.array_pool = [];
  VertexLayout.enabled_attribs = {};
  vi.restoreAllMocks();
});

describe('checked geometry pipeline', () => {
  test.each(['glsl', 'wgsl'] as const)('packs an untextured %s line from authored properties', shaderLanguage => {
    const style = createStyle(shaderLanguage, 'lines');
    const context = createContext();
    const draw = style._preprocess(createDraw());
    const feature = style._parseFeature(context.feature, draw, context)!;
    style.startData(context.tile);
    expect(style.buildLines([[[100, -100], [200, -100]]], feature, context)).toBe(2);
    const mesh = style.getTileMesh(context.tile, style.meshVariantTypeForDraw(feature));
    const packed = mesh.vertex_data.end();
    expect(packed.vertex_count).toBe(4);
    expect(packed.element_buffer).toHaveLength(6);
    expect(packed.vertex_buffer.byteLength).toBe(mesh.vertex_data.stride * 4);
    expect(mesh.vertex_data.vertex_layout.index.a_position).toBe(0);
    const layout = style.vertexLayoutForMeshVariant(mesh.variant);
    const attributes = layout.getBufferLayout().attributes;
    expect(attributes.some(attribute => attribute.attribute === 'a_offset')).toBe(shaderLanguage === 'wgsl');
    expect(layout.index.a_offset !== undefined).toBe(shaderLanguage === 'wgsl');
    expect(attributes.some(attribute => attribute.attribute === 'a_texcoord')).toBe(shaderLanguage === 'wgsl');
    if (shaderLanguage === 'wgsl') {
      const view = new DataView(packed.vertex_buffer.buffer, packed.vertex_buffer.byteOffset);
      expect(view.getFloat32(layout.offset.a_texcoord, true)).toBe(0);
      expect(view.getFloat32(layout.offset.a_texcoord + 4, true)).toBe(0);
    }
  });

  test('interpolates width/offset at adjacent zooms and restores the evaluation zoom', () => {
    const style = createStyle('glsl', 'lines');
    const context = createContext();
    const draw = style._preprocess(createDraw({width: [[16, 4], [17, 8]], offset: [[16, 2], [17, 4]]}));
    const feature = style._parseFeature(context.feature, draw, context)!;
    expect(context.zoom).toBe(16);
    expect(feature.width_unscaled).toBe(4);
    expect(feature.next_width_unscaled).toBe(8);
    expect(feature.width).toBe(20);
    expect(feature.width_scale).toBeCloseTo(-0.6);
    expect(feature.offset).toBe(16);
    expect(feature.offset_scale).toBeCloseTo(-0.75);
    style.startData(context.tile);
    expect(style.buildLines([[[100, -100], [200, -100]]], feature, context)).toBe(2);
    const mesh = style.getTileMesh(context.tile, style.meshVariantTypeForDraw(feature));
    const layout = mesh.vertex_data.vertex_layout;
    expect(layout.index.a_offset).toEqual(expect.any(Number));
    const packed = mesh.vertex_data.end();
    const view = new DataView(packed.vertex_buffer.buffer, packed.vertex_buffer.byteOffset);
    const offset = [view.getInt16(layout.offset.a_offset, true), view.getInt16(layout.offset.a_offset + 2, true)];
    expect(offset.some(component => component !== 0)).toBe(true);
  });

  test('reuses outline caches, limits order and copies interpolated offsets', () => {
    const style = createStyle('glsl', 'lines');
    const context = createContext();
    const draw = style._preprocess(createDraw({offset: 3, outline: createDraw({color: [1, 0, 0, 1], width: 2, order: 50})}));
    const feature = style._parseFeature(context.feature, draw, context)!;
    const outline = feature.outline!;
    expect(outline.width.value).toBe(8);
    expect(outline.order).toBe(9.5);
    expect(outline.offset_precalc).toBe(feature.offset);
    expect(outline.offset_scale_precalc).toBe(feature.offset_scale);
    const withoutOutline = style._preprocess(createDraw());
    expect(style._parseFeature(context.feature, withoutOutline, context)!.outline).toBe(outline);
    expect(outline.width.value).toBeNull();
    expect(outline.color).toBeNull();
  });

  test('keeps dash variants stable and draws outline meshes before their fill', () => {
    const style = createStyle('glsl', 'lines');
    const first = style._preprocess(createDraw({dash: [2, 4], dash_background_color: [0, 0, 0, 1]}));
    const second = style._preprocess(createDraw({dash: [2, 4], dash_background_color: [0, 0, 0, 1]}));
    const outline = style._preprocess(createDraw({dash: [2, 4], is_outline: true}));
    expect(second.variant).toBe(first.variant);
    expect(outline.variant).not.toBe(first.variant);
    expect(style.meshVariantTypeForDraw(first).mesh_order).toBe(1);
    expect(style.meshVariantTypeForDraw(outline).mesh_order).toBe(0);
    expect(style.meshVariantTypeForDraw(first).dash_key).toBe('__dash_[2,4]');
  });

  test.each(['glsl', 'wgsl'] as const)('packs %s polygon tops and walls without changing source rings', shaderLanguage => {
    const style = createStyle(shaderLanguage, 'polygons');
    const context = createContext();
    const polygon = [[[100, -100], [300, -100], [300, -300], [100, -300], [100, -100]]];
    const original = structuredClone(polygon);
    const draw = style._preprocess(createDraw({extrude: true, interactive: true}));
    const feature = style._parseFeature(context.feature, draw, context)!;
    expect(feature.height).toBe(320);
    expect(feature.min_height).toBe(80);
    style.startData(context.tile);
    expect(style.buildPolygons([polygon], feature, context)).toBe(10);
    const mesh = style.getTileMesh(context.tile, style.meshVariantTypeForDraw(feature));
    expect(mesh.vertex_data.end().element_buffer).toHaveLength(30);
    expect(polygon).toEqual(original);
    const layout = style.vertexLayoutForMeshVariant(mesh.variant);
    expect(layout.dynamic_attribs.find(attribute => attribute.name === 'a_normal')!.size).toBe(shaderLanguage === 'wgsl' ? 4 : 3);
    expect(layout.getBufferLayout().attributes.find(attribute => attribute.attribute === 'a_normal')!.format).toBe(shaderLanguage === 'wgsl' ? 'snorm8x4' : 'snorm8x3-webgl');
  });

  test('keeps packed views and prior vertex bytes intact while growing a buffer', () => {
    const layout = new VertexLayout([
      {name: 'a_position', size: 2, type: gl.SHORT},
      {name: 'a_color', size: 3, type: gl.UNSIGNED_BYTE},
      {name: 'a_uv', size: 2, type: gl.FLOAT}
    ]);
    const data = new VertexData(layout, {prealloc: 8});
    data.addVertex([12, -34, 255, 128, 1, 0.25, 0.5]);
    data.addVertex([56, -78, 2, 3, 4, 0.75, 1]);
    for (let vertex = 2; vertex < 9; vertex++) {
      data.addVertex([90, -12, 5, 6, 7, 0, 0]);
    }
    expect(data.realloc_count).toBe(1);
    expect(layout.offset).toEqual({a_position: 0, a_color: 4, a_uv: 8});
    expect(layout.index).toEqual({a_position: 0, a_color: 2, a_uv: 5});
    const view = new DataView(data.end().vertex_buffer.buffer);
    expect(view.getInt16(0, true)).toBe(12);
    expect(view.getInt16(2, true)).toBe(-34);
    expect(view.getUint8(4)).toBe(255);
    expect(view.getFloat32(8, true)).toBe(0.25);
    expect(view.getInt16(layout.stride, true)).toBe(56);
    expect(view.getFloat32(layout.stride + 12, true)).toBe(1);
  });
});

describe('checked vertex-array bindings', () => {
  test('adapts native WebGL 2 VAOs and keeps bindings separate for each context', () => {
    const first = document.createElement('canvas').getContext('webgl2')!;
    const second = document.createElement('canvas').getContext('webgl2')!;
    const setup = vi.fn();
    const binding = VertexArrayObject.create(first, setup);
    VertexArrayObject.bind(first, binding);
    expect(first.getParameter(first.VERTEX_ARRAY_BINDING)).toBe(binding._vao);
    expect(VertexArrayObject.getCurrentBinding(first)).toBe(binding);
    expect(VertexArrayObject.getCurrentBinding(second)).toBeUndefined();
    expect(setup).toHaveBeenCalledTimes(1);
    VertexArrayObject.bind(first, null);
    expect(first.getParameter(first.VERTEX_ARRAY_BINDING)).toBeNull();
    VertexArrayObject.destroy(first, binding);
    expect(binding._vao).toBeNull();
    first.getExtension('WEBGL_lose_context')?.loseContext();
    second.getExtension('WEBGL_lose_context')?.loseContext();
  });

  test('uses setup and explicit teardown when native VAOs are disabled', () => {
    const context: VertexArrayContext = {getExtension: () => null};
    VertexArrayObject.disabled = true;
    const setup = vi.fn();
    const teardown = vi.fn();
    const binding = VertexArrayObject.create(context, setup, teardown);
    VertexArrayObject.bind(context, binding);
    // Preserve the legacy fallback: bind replays setup; it does not track a native handle.
    expect(setup).toHaveBeenCalledTimes(2);
    VertexArrayObject.setCurrentBinding(context, binding);
    VertexArrayObject.bind(context, null);
    expect(teardown).toHaveBeenCalledTimes(1);
    VertexArrayObject.destroy(context, binding);
    expect(VertexArrayObject.getCurrentBinding(context)).toBeNull();
  });
});
