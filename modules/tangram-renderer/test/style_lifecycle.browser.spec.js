// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {Style, addLayerDebugEntry} from '../src/styles/style';
import StyleParser from '../src/styles/style_parser';
import {getFeatureRenderedGeneration} from '../src/styles/feature_annotations';
import FeatureSelection from '../src/selection/selection';
import {RasterTileSource} from '../src/sources/raster';
import WorkerBroker from '../src/utils/worker_broker';
import ShaderProgram from '../src/gl/shader_program';
import debugSettings from '../src/utils/debug_settings';

function createStyle(overrides = {}) {
    const style = Object.create(Style);
    Object.assign(style, {
        base: 'polygons',
        blend: 'opaque',
        blend_order: 0,
        defines: {},
        draw: null,
        feature_style: {},
        generation: 4,
        introspection: false,
        name: 'custom',
        raster: null,
        selection: true,
        shaders: {attributes: null, blocks: {}, defines: {}, uniforms: {}},
        sources: {},
        styles: {},
        tile_data: {},
        vertex_template: [],
        ...overrides
    });
    return style;
}

afterEach(() => {
    vi.restoreAllMocks();
    debugSettings.layer_stats = false;
});

describe('generic style data lifecycle', () => {
    test('starts, detects, retrieves, and finalizes tile mesh data', async () => {
        const style = createStyle();
        const tile = {id: 'tile', rasters: []};
        style.startData(tile);
        expect(style.hasDataForTile(tile)).toBe(true);

        const vertexData = {
            element_buffer: new Uint16Array([0, 1, 2]),
            end: vi.fn(),
            vertex_buffer: new Uint8Array([1, 2]),
            vertex_count: 3
        };
        style.vertexLayoutForMeshVariant = vi.fn(() => ({createVertexData: () => vertexData}));
        const variant = {key: 'main'};
        expect(style.getTileMesh(tile, variant)).toBe(style.getTileMesh(tile, variant));
        vi.spyOn(style, 'buildRasterTextures').mockImplementation(async (inputTile, data) => data);
        const data = await style.endData(tile);
        expect(vertexData.end).toHaveBeenCalled();
        expect(data.meshes.main.vertex_data).toBe(vertexData.vertex_buffer);
        expect(data.meshes.main.vertex_elements).toBe(vertexData.element_buffer);
        expect(style.hasDataForTile(tile)).toBe(false);

        style.startData(tile);
        style.tile_data.tile.meshes.empty = {vertex_data: {...vertexData, vertex_count: 0}};
        await expect(style.endData(tile)).resolves.toMatchObject({meshes: {}});

        style.startData(tile);
        await expect(style.endData(tile)).resolves.toBeNull();
    });

    test('routes every GeoJSON geometry and marks rendered features', () => {
        const style = createStyle();
        style.buildPolygons = vi.fn(() => 2);
        style.buildLines = vi.fn(() => 3);
        style.buildPoints = vi.fn(() => 1);
        const context = {layers: ['roads:major'], tile: {debug: {}, generation: 4, id: 'tile'}};
        const cases = [
            ['Polygon', [[]], style.buildPolygons],
            ['MultiPolygon', [[[]]], style.buildPolygons],
            ['LineString', [], style.buildLines],
            ['MultiLineString', [[]], style.buildLines],
            ['Point', [0, 0], style.buildPoints],
            ['MultiPoint', [[0, 0]], style.buildPoints]
        ];
        for (const [type, coordinates, build] of cases) {
            const before = build.mock.calls.length;
            expect(style.buildGeometry({type, coordinates}, {}, context)).toBeGreaterThan(0);
            expect(build.mock.calls.length).toBe(before + 1);
        }

        style.parseFeature = vi.fn(() => ({}));
        style.buildGeometry = vi.fn(() => 1);
        const feature = {geometry: {type: 'Point', coordinates: [0, 0]}};
        style.addFeature(feature, {}, context);
        expect(getFeatureRenderedGeneration(feature)).toBe(4);
        expect(feature).not.toHaveProperty('generation');
        style.addFeature({}, {}, {...context, tile: {...context.tile, generation: 3}});
        style.parseFeature.mockReturnValue(null);
        style.addFeature(feature, {}, context);
    });

    test('collects nested layer geometry statistics', () => {
        const style = createStyle();
        style.buildPoints = vi.fn(() => 2);
        debugSettings.layer_stats = true;
        const tile = {debug: {}, id: 'tile'};
        style.buildGeometry({type: 'Point', coordinates: [0, 0]}, {}, {layers: ['roads:major', 'transport'], tile});
        expect(tile.debug.layers.list['roads:major']).toMatchObject({features: 1, geoms: 2});
        expect(tile.debug.layers.tree.roads.layers.major.geoms).toBe(2);

        const target = {};
        addLayerDebugEntry(target, 'places', 2, 3, {points: 3}, {points: 3});
        addLayerDebugEntry(target, 'places', 1, 2, {points: 2}, {points: 2});
        expect(target.places).toEqual({features: 3, geoms: 5, styles: {points: 5}, base: {points: 5}});
    });

    test('parses order, custom attributes, and feature selection', () => {
        const style = createStyle({blend: 'overlay'});
        style.shaders.attributes = {speed: {type: 'float'}};
        style._parseFeature = vi.fn(() => style.feature_style);
        vi.spyOn(FeatureSelection, 'makeColor').mockReturnValue([1, 2, 3, 4]);
        const draw = {
            attributes: {speed: StyleParser.createPropertyCache(() => 12)},
            interactive: true,
            layers: ['roads'],
            order: context => context.order
        };
        const context = {order: 5, tile: {}};
        expect(style.parseFeature({}, draw, context)).toMatchObject({
            attributes: {speed: 12},
            interactive: true,
            order: 5,
            selection_color: [1, 2, 3, 4]
        });

        draw.attributes.speed = StyleParser.createPropertyCache(() => null);
        draw.interactive = false;
        expect(style.parseFeature({}, draw, context).attributes.speed).toBe(0);
        style.selection = false;
        expect(style.parseFeature({}, draw, context).interactive).toBe(false);
    });

    test('applies draw defaults, introspection, and cached custom attributes', () => {
        const style = createStyle({
            draw: {color: '#fff', outline: {color: '#000', width: 1}},
            introspection: true,
            shaders: {attributes: {speed: {type: 'float'}}, blocks: {}}
        });
        style._preprocess = vi.fn(draw => draw);
        const draw = style.preprocess({outline: {width: 2}});
        expect(draw).toMatchObject({color: '#fff', interactive: true, preprocessed: true});
        expect(draw.outline).toEqual({color: '#000', width: 2});
        expect(draw.attributes.speed).toBeDefined();
        expect(style.preprocess(draw)).toBe(draw);

        style.selection = false;
        const noSelection = style.preprocess({});
        expect(noSelection.interactive).toBe(false);
        style._preprocess.mockReturnValueOnce(null);
        expect(style.preprocess({})).toBeUndefined();
    });

    test('manages shader blocks, defines, colors, and blend order', () => {
        const style = createStyle({blend: 'add', blend_order: 4, defines: {BASE: true}});
        style.shaders.defines = {CUSTOM: 2};
        style.addShaderBlock('color', 'first', 'Style');
        style.addShaderBlock('color', 'second');
        expect(style.shaders.blocks.color).toEqual(['first', 'second']);
        expect(style.shaders.block_scopes.color).toEqual(['Style', null]);
        style.replaceShaderBlock('color', 'replacement', 'Replace');
        expect(style.shaders.blocks.color).toEqual(['replacement']);
        style.removeShaderBlock('color');
        expect(style.shaders.blocks.color).toBeNull();
        expect(style.buildDefineList()).toEqual({BASE: true, CUSTOM: 2});
        expect(style.baseStyle()).toBe('polygons');
        expect(style.scaleOrder(2.5)).toBe(5);
        expect(style.parseOrder(3, {})).toBe(3);
        expect(style.parseColor(null, {})).toBeUndefined();
        style.shaders.blocks.filter = ['filter'];
        expect(style.parseColor(null, {})).toEqual(StyleParser.defaults.color);
        expect(style.getBlendOrderForDraw({blend_order: 9})).toBe(9);
        style.blend = 'opaque';
        expect(style.getBlendOrderForDraw({blend_order: 9})).toBe(4);
    });

    test('configures raster shaders and worker texture metadata', async () => {
        const raster = Object.create(RasterTileSource.prototype);
        raster.mask_alpha = true;
        const style = createStyle({raster: 'color', sources: {raster}});
        style.setupRasters();
        expect(style.defines).toMatchObject({
            TANGRAM_ALL_MASKED_RASTERS: true,
            TANGRAM_HAS_MASKED_RASTERS: true,
            TANGRAM_NUM_RASTER_SOURCES: '1',
            TANGRAM_RASTER_TEXTURE_COLOR: true
        });
        expect(style.shaders.blocks.raster).toHaveLength(1);

        style.main_thread_target = 'Style_custom_4';
        vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue([
            {coords: {x: 0, y: 0, z: 1}, height: 256, index: 0, loaded: true, name: 'raster-tile', width: 256}
        ]);
        const tile = {coords: {x: 1, y: 1, z: 2}, max: {}, min: {}, rasters: ['raster'], source: 'osm'};
        const data = {textures: [], uniforms: {}};
        expect(await style.buildRasterTextures(tile, data)).toBe(data);
        expect(data.uniforms).toMatchObject({
            u_raster_mask_alpha: true,
            u_rasters: ['raster-tile'],
            u_raster_sizes: [[256, 256]],
            u_raster_offsets: [[0.5, 0, 0.5]]
        });

        style.raster = null;
        expect(await style.buildRasterTextures(tile, data)).toBe(data);
    });

    test('adds custom vertex attributes and applies current-program uniforms', () => {
        const style = createStyle({shaders: {
            attributes: {speed: {type: 'float'}, hidden: {type: 'float', varying: false}, ignored: {type: 'vec2'}},
            blocks: {},
            uniforms: {u_scale: 2}
        }});
        style.setupCustomAttributes();
        expect(style.shaders.blocks.attributes).toHaveLength(2);
        const attributes = style.addCustomAttributesToAttributeList([]);
        expect(attributes.map(attribute => attribute.name)).toEqual(['a_speed', 'a_hidden']);
        style.addCustomAttributesToVertexTemplate({attributes: {speed: 3}}, 0);
        expect(style.vertex_template.slice(0, 3)).toEqual([3, 0, 0]);

        const program = {setUniforms: vi.fn()};
        ShaderProgram.current = program;
        style.material = {setupProgram: vi.fn()};
        style.setup();
        expect(program.setUniforms).toHaveBeenCalledWith({u_scale: 2}, true);
        expect(style.material.setupProgram).toHaveBeenCalledWith(program);
        ShaderProgram.current = null;
        style.setUniforms();
    });

    test('records rendering backend options and delegates mesh rendering', () => {
        const style = createStyle();
        const gl = {};
        style.setGL(gl, {Scene: {}}, {
            deviceShaderCompilation: true,
            deferTextureBindings: true,
            deferUniformBlocks: true,
            deferUniformUpdates: true,
            maxTextureSize: 2048,
            meshBufferFactory: vi.fn(),
            resourceContext: {device: true},
            shaderFactory: vi.fn(),
            shaderProgramValidator: vi.fn(),
            shaderLanguage: 'wgsl',
            textureFactory: vi.fn(),
            uniformBlockFactory: vi.fn()
        });
        expect(style).toMatchObject({
            device_shader_compilation: true,
            defer_texture_bindings: true,
            defer_uniform_blocks: true,
            defer_uniform_updates: true,
            max_texture_size: 2048,
            shader_program_validator: expect.any(Function),
            shader_language: 'wgsl'
        });
        const mesh = {render: vi.fn(() => 6)};
        expect(style.render(mesh, {mode: 'main'})).toBe(6);
        expect(mesh.render).toHaveBeenCalledWith({mode: 'main'});
        expect(style.buildPolygons()).toBe(0);
        expect(style.buildLines()).toBe(0);
        expect(style.buildPoints()).toBe(0);
    });
});
