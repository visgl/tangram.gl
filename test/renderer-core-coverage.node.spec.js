// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, describe, expect, it} from 'vitest';

describe('renderer core utility modules', () => {
  let SceneBundle;
  let ZipSceneBundle;
  let createSceneBundle;
  let Utils;
  let flattenGlobalProperties;
  let isGlobalReference;
  let isGlobalSubstitution;
  let applyGlobalProperties;
  let GLSL;
  let RenderStateManager;
  let RenderState;
  let VertexElements;
  let VertexLayout;
  let TileID;
  let TilePyramid;
  let isTextCurveBlacklisted;
  let isTextNeutral;
  let isTextRTL;
  let splitLabelText;
  let MultiLine;

  beforeAll(async () => {
    globalThis.self = globalThis;
    globalThis.self.addEventListener = () => {};
    GLSL = (await import('../modules/tangram-renderer/src/gl/glsl.ts')).default;
    ({default: RenderStateManager, RenderState} = await import('../modules/tangram-renderer/src/gl/render_state.ts'));
    VertexElements = (await import('../modules/tangram-renderer/src/gl/vertex_elements.ts')).default;
    VertexLayout = (await import('../modules/tangram-renderer/src/gl/vertex_layout.ts')).default;
    ({TileID} = await import('../modules/tangram-renderer/src/tile/tile_id.js'));
    TilePyramid = (await import('../modules/tangram-renderer/src/tile/tile_pyramid.js')).default;
    ({isTextCurveBlacklisted, isTextNeutral, isTextRTL, splitLabelText} = await import('@tangram.gl/map-utils/text/canvas'));
    MultiLine = (await import('../modules/tangram-renderer/src/styles/text/text_wrap.js')).default;
    ({SceneBundle, ZipSceneBundle, createSceneBundle} = await import('../modules/tangram-renderer/src/scene/scene_bundle.js'));
    Utils = (await import('../modules/tangram-renderer/src/utils/utils.js')).default;
    ({flattenGlobalProperties, isGlobalReference, isGlobalSubstitution, applyGlobalProperties} = await import('../modules/tangram-renderer/src/scene/globals.js'));
  });

  describe('GLSL helpers', () => {
    it('parses uniform values into WebGL setter metadata', () => {
      const parsed = GLSL.parseUniforms({
        scalar: 1,
        vector: [1, 2, 3],
        values: [1, 2, 3, 4, 5],
        textures: ['a', 'b'],
        matrixRows: [[1, 2], [3, 4]],
        enabled: true,
        texture: 'atlas'
      });
      expect(parsed).toEqual(expect.arrayContaining([
        expect.objectContaining({name: 'scalar', type: 'float', method: '1f'}),
        expect.objectContaining({name: 'vector', type: 'vec3', method: '3fv'}),
        expect.objectContaining({name: 'values[0]', type: 'float[]'}),
        expect.objectContaining({name: 'textures[1]', type: 'sampler2D'}),
        expect.objectContaining({name: 'matrixRows[0]', type: 'vec2'}),
        expect.objectContaining({name: 'enabled', type: 'bool'}),
        expect.objectContaining({name: 'texture', type: 'sampler2D'})
      ]));
    });

    it('defines variables, uniforms, and expanded colors', () => {
      expect(GLSL.defineVariable('position', [1, 2, 3])).toBe('vec3 position;\n');
      expect(GLSL.defineVariable('indices', [1, 2, 3, 4, 5])).toBe('float indices[5];\n');
      expect(GLSL.defineVariable('textures', ['a', 'b'])).toBe('sampler2D textures[2];\n');
      expect(GLSL.defineUniform('enabled', true)).toBe('uniform bool enabled;\n');
      expect(GLSL.defineVariable('invalid', {value: 1})).toBeUndefined();
      expect(GLSL.expandVec3([1, '2'], 3)).toEqual([1, 2, 3]);
      expect(GLSL.expandVec3(2)).toEqual([2, 2, 2]);
      expect(GLSL.expandVec3([1, 2, 3])).toEqual([1, 2, 3]);
      expect(GLSL.expandVec3('invalid')).toBeUndefined();
      expect(GLSL.expandVec4([1, 2, 3], 0.5)).toEqual([1, 2, 3, 0.5]);
      expect(GLSL.expandVec4(2, 0.5)).toEqual([2, 2, 2, 0.5]);
      expect(GLSL.expandVec4([1, 2])).toEqual([1, 2]);
      expect(GLSL.expandVec4('invalid')).toBeUndefined();
    });
  });

  describe('vertex buffers and layouts', () => {
    it('switches index buffers between 16-bit and 32-bit overflow', () => {
      VertexElements.setElementIndexUint(false);
      const limited = new VertexElements();
      limited.push(1);
      limited.push(65536);
      expect(limited.has_overflown).toBe(true);
      expect(limited.end()).toBeInstanceOf(Uint16Array);
      expect(limited.end()).toBe(false);

      VertexElements.setElementIndexUint(true);
      const extended = new VertexElements();
      extended.push(65536);
      const buffer = extended.end();
      expect(buffer).toBeInstanceOf(Uint32Array);
      expect(Array.from(buffer)).toEqual([65536]);
      VertexElements.setElementIndexUint(false);
    });

    it('describes dynamic and static attributes and writes vertex data', () => {
      const layout = new VertexLayout([
        {name: 'position', size: 3, type: 5126, normalized: false},
        {name: 'color', size: 4, type: 5121, normalized: true, static: [1, 0, 0, 1]},
        {name: 'id', size: 1, type: 5123, normalized: false}
      ]);
      expect(layout.dynamic_attribs).toHaveLength(2);
      expect(layout.static_attribs).toHaveLength(1);
      expect(layout.getBufferLayout()).toMatchObject({name: 'vertices', attributes: [
        {attribute: 'position', format: 'float32x3', byteOffset: 0},
        {attribute: 'id', format: 'uint16'}
      ]});
      expect(layout.getStaticAttributes()).toEqual([{attribute: 'color', value: [1, 0, 0, 1]}]);
      const vertexData = layout.createVertexData();
      vertexData.addVertex([1, 2, 3, 7]);
      expect(vertexData.offset).toBe(layout.stride);
      expect(vertexData.views[5126][0]).toBe(1);
      expect(vertexData.views[5123][6]).toBe(7);
    });
  });

  describe('tile identity and pyramid', () => {
    const source = {name: 'osm', id: 'osm', zooms: [0, 2, 4], zoom_bias: 0};

    it('normalizes coordinates and computes tile relationships', () => {
      expect(TileID.coord({x: 1, y: 2, z: 3})).toEqual({x: 1, y: 2, z: 3, key: '1/2/3'});
      expect(TileID.key({x: 1, y: 2, z: 3}, source, 3)).toBe('osm/1/2/3/3');
      expect(TileID.key({x: 1, y: -1, z: 3}, source, 3)).toBeUndefined();
      expect(TileID.coordAtZoom({x: 5, y: 7, z: 3}, 2)).toMatchObject({x: 2, y: 3, z: 2});
      expect(TileID.coordAtZoom({x: 5, y: 7, z: 3}, -1)).toMatchObject({z: 0});
      expect(TileID.findZoomInRange(3, source.zooms)).toBe(2);
      expect(TileID.coordForTileZooms({x: 5, y: 7, z: 3}, source.zooms)).toMatchObject({z: 2});
      expect(TileID.isDescendant({x: 2, y: 3, z: 2}, {x: 5, y: 7, z: 3})).toBe(true);
      expect(TileID.isDescendant({x: 2, y: 3, z: 2}, {x: 2, y: 3, z: 2})).toBe(false);
    });

    it('creates parent and child tile records and caches children', () => {
      const tile = {coords: {x: 1, y: 1, z: 2}, source, style_z: 4};
      tile.key = TileID.key(tile.coords, source, tile.style_z);
      const parent = TileID.parent(tile);
      expect(parent).toMatchObject({style_z: 3, source});
      const children = TileID.children(tile);
      expect(children).toHaveLength(16);
      expect(TileID.children(tile)).toEqual(children);
      const pyramid = new TilePyramid();
      pyramid.addTile({...tile, loaded: true});
      expect(pyramid.tiles[tile.key].tile.loaded).toBe(true);
      expect(pyramid.getAncestor(tile)).toBeUndefined();
      expect(pyramid.getDescendants(tile)).toEqual([]);
      pyramid.removeTile(tile);
      expect(pyramid.tiles[tile.key]).toBeUndefined();
    });
  });

  describe('text segmentation and wrapping', () => {
    it('detects directionality and caches grapheme segments', () => {
      expect(isTextRTL('שלום')).toBe(true);
      expect(isTextRTL('road')).toBe(false);
      expect(isTextNeutral('-')).toBe(true);
      expect(isTextCurveBlacklisted('᠀')).toBe(true);
      expect(isTextCurveBlacklisted('road')).toBe(false);
      const cache = {segment: {}, stats: {segment_hits: 0, segment_misses: 0}};
      expect(splitLabelText('abcdef', false, cache)).toEqual(['ab', 'cd', 'ef']);
      expect(splitLabelText('abcdef', false, cache)).toEqual(['ab', 'cd', 'ef']);
      expect(cache.stats.segment_hits).toBe(1);
      expect(splitLabelText('אבג', true, cache)).toHaveLength(3);
      expect(splitLabelText('a', false, cache)).toEqual(['a']);
    });

    it('wraps measured text, explicit breaks, and ellipses', () => {
      const context = {measureText: text => ({width: text.length * 5})};
      const wrapped = MultiLine.parse('one two three', 7, 2, 10, context);
      expect(wrapped.lines.map(line => line.text)).toEqual(['one two', 'three']);
      expect(wrapped.width).toBeGreaterThan(0);
      const explicit = MultiLine.parse('one\ntwo', Infinity, Infinity, 10, context);
      expect(explicit.lines.map(line => line.text)).toEqual(['one', 'two']);
      expect(explicit.height).toBe(20);
    });
  });

  describe('render states and scene bundles', () => {
    it('only applies changed render state values', () => {
      const values = [];
      const state = new RenderState({enabled: true}, value => values.push(value));
      state.set({enabled: true});
      state.set({enabled: false});
      state.invalidate();
      state.set({enabled: false});
      expect(values).toEqual([{enabled: true}, {enabled: false}, {enabled: false}]);

      const gl = {
        BACK: 1029, ONE_MINUS_SRC_ALPHA: 771, ONE: 1, LESS: 513,
        CULL_FACE: 2884, BLEND: 3042, DEPTH_TEST: 2929,
        depthFunc: () => {}, enable: () => {}, disable: () => {}, cullFace: () => {},
        blendFuncSeparate: () => {}, blendFunc: () => {}, depthMask: () => {}
      };
      const manager = new RenderStateManager(gl);
      manager.culling.set({cull: false, face: gl.BACK});
      manager.blending.set({blend: true, src: 1, dst: 2, src_alpha: 1, dst_alpha: 2});
      manager.depth_write.set({depth_write: false});
      manager.depth_test.set({depth_test: false});
      manager.invalidate();
    });

    it('resolves scene bundle resources and zip roots', () => {
      globalThis.document = {
        createElement: () => ({set href(value) {this._href = value;}, get href() {return this._href;}, origin: 'https://example.com', protocol: 'https:', host: 'example.com'})
      };
      const bundle = new SceneBundle('https://example.com/styles/scene.yaml');
      expect(bundle.path).toBe('https://example.com/styles/');
      expect(bundle.resourceFor('icons/poi.png')).toEqual({
        url: 'https://example.com/styles/icons/poi.png',
        path: 'icons/',
        type: 'png'
      });
      expect(bundle.resourceFor('global.theme')).toMatchObject({url: 'global.theme'});
      expect(createSceneBundle('scene.yaml')).toBeInstanceOf(SceneBundle);
      expect(createSceneBundle('scene.zip')).toBeInstanceOf(ZipSceneBundle);
      const zip = new ZipSceneBundle('scene.zip');
      zip.files = {'scene.yaml': {depth: 0, type: 'yaml'}, 'assets/icon.png': {depth: 1, type: 'png'}};
      zip.findRoot();
      expect(zip.root).toBe('scene.yaml');
      expect(zip.typeFor('assets/icon.png')).toBe('png');
      expect(() => { zip.files['other.yaml'] = {depth: 0, type: 'yaml'}; zip.root = null; zip.findRoot(); }).toThrow('single scene file');
    });
  });

  describe('global properties and general utilities', () => {
    it('flattens and substitutes global references', () => {
      expect(isGlobalReference('global.colors.road')).toBe(true);
      expect(isGlobalReference('colors.road')).toBe(false);
      const globals = flattenGlobalProperties({colors: {road: '#fff'}, alias: 'global.colors.road'});
      expect(globals).toMatchObject({'global.colors.road': '#fff', 'global.alias': 'global.colors.road'});
      const target = {color: 'global.colors.road', nested: ['global.colors.road']};
      applyGlobalProperties(globals, target, target, 'color');
      applyGlobalProperties(globals, target.nested, target, 'nested');
      expect(target.color).toBe('#fff');
      expect(isGlobalSubstitution(target, 'color')).toBe(true);
      expect(isGlobalSubstitution(target, ['nested', 0])).toBe(true);
      target.color = 'blue';
      expect(target.color).toBe('blue');
    });

    it('interpolates values, serializes functions, and detects power-of-two sizes', () => {
      expect(Utils.interpolate(2, [[0, 0], [4, 8]])).toBe(4);
      expect(Utils.interpolate(-1, [[0, 0], [4, 8]])).toBe(0);
      expect(Utils.interpolate(5, [[0, 0], [4, 8]])).toBe(8);
      expect(Utils.interpolate(2, [[0, [0, 10]], [4, [4, 20]]])).toEqual([2, 15]);
      expect(Utils.interpolate(2, [[0, 0], [4, 8]], value => value * 2)).toBe(8);
      expect(Utils.isPowerOf2(8)).toBe(true);
      expect(Utils.isPowerOf2(7)).toBe(false);
      expect(Utils.toCSSColor([1, 0.5, 0, 1])).toBe('rgb(255, 128, 0)');
      expect(Utils.toCSSColor([1, 0.5, 0, 0.5])).toBe('rgba(255, 128, 0, 0.5)');
      expect(Utils.serializeWithFunctions({run: () => 1})).toContain('() => 1');
    });
  });
});
