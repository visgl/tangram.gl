// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// Rendering styles


import StyleParser from './style_parser';
import type {StyleRuntime, StyleMethods, StyleInitOptions, StyleGLOptions, BuildFeature, BuildContext, BuildDraw, BuildGeometry, BuildFeatureStyle, BuildTileData, BuildMesh, LayerDebugTree, CountedLayerTree, RasterTextureInfo, RasterTextureTile} from './style-runtime-types';
import type {WorkerBuildTile, TileStylePayload, TileMeshVariant} from '../tile/tile-build-types';
import type {GeometryMeshVariant} from './geometry-style-types';
import type {PropertyCache, PropertyContext} from './property-types';
import type VertexLayout from '../gl/vertex_layout';
import VertexData from '../gl/vertex_data';
import type {VertexAttribute} from '../gl/vertex-types';
import type UniformBuffer from '../gl/uniform_buffer';
import type {MeshElementData, MeshRenderOptions} from '../gl/mesh-types';
import {markFeatureRendered} from './feature_annotations';
import FeatureSelection from '../selection/selection';
import gl from '../gl/constants'; // import GL constants since workers can't access GL context
import ShaderProgram from '../gl/shader_program';
import VBOMesh from '../gl/vbo_mesh';
import Texture from '../gl/texture';
import Material from '../lights/material';
import {PORTABLE_MATERIAL_UNIFORMS, getPortableMaterialUniforms} from '../lights/lighting-uniforms';
import Light from '../lights/light';
import {RasterTileSource} from '../sources/raster';
import log from '../utils/log';
import mergeObjects from '../utils/merge';
import Thread from '../utils/thread';
import WorkerBroker from '../utils/worker_broker';
import makeWireframeForTriangleElementData from '../builders/wireframe';
import {drapeTerrainMesh, getTerrainVertexLayout, extractDrapedTerrainQueryMesh} from '../procedures/terrain-draping';
import debugSettings from '../utils/debug_settings';
import Geo from '../utils/geo';
import {normalizeProjectedBasemapOptions, projectTileMesh, validateProjectedLights} from '../procedures/mesh-projector';

import selection_fragment_source from '../selection/selection_fragment.glsl';
import rasters_source from './raster/raster_globals.glsl';
import {heightDecode} from '../shader-modules/height-decode';

// Base class

export var Style: StyleMethods = {
    init (this: StyleRuntime, { generation, styles, sources = {}, introspection, shader_language = 'glsl', config, projection_target, terrain, terrainRibbonZoom }: StyleInitOptions = {}) {
        this.setGeneration(generation);
        this.styles = styles;                       // styles for scene
        this.sources = sources;                     // data sources for scene
        this.shader_language = shader_language;     // keeps worker-built vertex layouts aligned with the renderer
        this.projection_target = projection_target;
        this.terrain = terrain;
        this.terrainRibbonZoom = terrainRibbonZoom;
        if (terrain && (config?.scene?.cpu_projection || this.shaders?.blocks?.position || this.shaders?.blocks?.width)) throw new Error('Terrain draping does not support CPU-projected scenes or procedural position/width blocks');
        this.cpu_projection = config?.scene?.cpu_projection === undefined ? undefined :
            normalizeProjectedBasemapOptions(config.scene.cpu_projection);
        this.screen_space_labels = Boolean(this.cpu_projection) || config?.scene?._host_screen_space_labels === true;
        if (this.cpu_projection) {
            validateProjectedLights(config?.lights);
            if (this.lighting && !(['polygons', 'raster'].includes(this.baseStyle()) &&
                ['vertex', 'fragment'].includes(String(this.lighting)))) throw new Error('CPU projection lighting requires polygon/raster vertex or fragment mode');
            const specularChannel = this.material?.specular;
            const specular = specularChannel !== null && typeof specularChannel === 'object' && 'amount' in specularChannel ? specularChannel.amount ?? specularChannel : specularChannel;
            const zeroSpecular = specular === undefined || specular === 0 ||
                (Array.isArray(specular) && specular.slice(0, 3).every(value => value === 0));
            if (this.material?.normal || !zeroSpecular) {
                throw new Error('CPU projection supports diffuse materials without normal maps or specular terms');
            }
        }
        this.defines = (Object.prototype.hasOwnProperty.call(this, 'defines') && this.defines) || {}; // #defines to be injected into the shaders
        this.defines.TANGRAM_TERRAIN_DRAPED = Boolean(terrain);
        this.shaders = (Object.prototype.hasOwnProperty.call(this, 'shaders') && this.shaders) || {}; // shader customization (uniforms, defines, blocks, etc.)
        this.introspection = introspection || false;
        this.selection = this.selection || this.introspection || false;   // flag indicating if this style supports feature selection
        this.compile_setup = false;                 // one-time setup steps for program compilation
        this.program = null;                        // GL program reference (for main render pass)
        this.selection_program = null;              // GL program reference for feature selection render pass
        this.feature_style = {};                    // style for feature currently being parsed, shared to lessen GC/memory thrash
        this.vertex_template = [];                  // shared single-vertex template, filled out by each style
        this.tile_data = {};
        this.stencil_proxy_tiles = true;            // applied to proxy tiles w/non-opaque blend mode to avoid compounding alpha

        this.variants = {}; // mesh variants by variant key
        this.vertex_layouts = {}; // vertex layouts by variant key

        // Default world coords to wrap every 100,000 meters, can turn off by setting this to 'false'
        this.defines.TANGRAM_WORLD_POSITION_WRAP = 100000;

        // Blending
        // `opaque` styles are drawn first/under other styles, without alpha blending
        this.blend = this.blend || 'opaque'; // default to opaque
        if (this.blend !== 'opaque') {
            // non-opaque styles can customize their blend order, which will determine which features
            // are drawn first/under each other
            if (this.blend_order == null) {
                this.blend_order = this.default_blend_orders[this.blend];
            }
        }
        else {
            // `opaque` ignores blend order, always render first/under
            this.blend_order = this.default_blend_orders[this.blend];
        }

        this.defines[`TANGRAM_BLEND_${this.blend.toUpperCase()}`] = true;

        this.removeShaderBlock('setup'); // clear before material injection

        // If the style defines its own material, replace the inherited material instance
        if (!(this.material instanceof Material)) {
            if (!Material.isValid(this.material)) {
                this.material = StyleParser.defaults.material;
            }
            this.material = new Material(this.material);
        }
        this.material.inject(this);

        // Set lighting mode: fragment, vertex, or none (specified as 'false')
        Light.setMode(this.cpu_projection ? this.lighting ?? false : this.lighting, this);

        // Setup raster samplers if needed
        this.setupRasters();

        // Setup shader definitions for custom attributes
        this.setupCustomAttributes();

        this.initialized = true;
    },

    destroy (this: StyleRuntime) {
        if (Object.prototype.hasOwnProperty.call(this, 'portable_material_buffer')) {
            this.portable_material_buffer?.destroy();
        }
        this.portable_material_buffer = null;
        if (Object.prototype.hasOwnProperty.call(this, 'program') && this.program) {
            this.program.destroy();
            this.program = null;
        }

        if (Object.prototype.hasOwnProperty.call(this, 'selection_program') && this.selection_program) {
            this.selection_program.destroy();
            this.selection_program = null;
        }

        WorkerBroker.removeTarget(this.main_thread_target);
        this.gl = null;
        this.resource_context = null;
        this.uniform_blocks = null;
        this.uniform_block_factory = null;
        this.initialized = false;
    },

    reset () {
    },

    baseStyle (this: StyleRuntime): string {
        return this.base || this.name;
    },

    setGeneration (this: StyleRuntime, generation: number | undefined) {
        // Scene generation id this style was created for
        this.generation = generation;

        // Provide a hook for this object to be called from worker threads
        this.main_thread_target = ['Style', this.name, this.generation].join('_');
        if (Thread.is_main) {
            WorkerBroker.addTarget(this.main_thread_target, this);
        }
    },

    /*** Style parsing and geometry construction ***/

    // Returns an object to hold feature data (for a tile or other object)
    startData (this: StyleRuntime, tile: Pick<WorkerBuildTile, 'id'>) {
        this.tile_data[tile.id] = this.tile_data[tile.id] || {
            meshes: {},
            uniforms: {},
            textures: []
        };
    },

    // Finalizes an object holding feature data (for a tile or other object)
    async endData (this: StyleRuntime, tile: import('./style-runtime-types').StyleFinalizeTile) {
        var tile_data = this.tile_data[tile.id];
        this.tile_data[tile.id] = null;

        if (tile_data && Object.keys(tile_data.meshes).length > 0) {
            const transferredMeshes: Record<string, BuildMesh<Uint8Array>> = {};
            for (let variant in tile_data.meshes) {
                const buildingMesh = tile_data.meshes[variant];
                const vertexData = buildingMesh.vertex_data;
                if (vertexData instanceof Uint8Array) throw new Error('Style mesh has already been finalized');

                // Remove empty mesh variants
                if (vertexData.vertex_count === 0) {
                    delete tile_data.meshes[variant];
                    continue;
                }

                // Only keep final byte buffer
                vertexData.end();
                let mesh: BuildMesh<Uint8Array> = Object.assign(buildingMesh, {vertex_elements: vertexData.element_buffer, vertex_data: vertexData.vertex_buffer});
                transferredMeshes[variant] = mesh;
                if ((this.terrain || this.cpu_projection) && (!tile.min || !tile.coords)) throw new Error('Projected tile has no address');
                if (this.terrain) {
                    const originalLayout = this.vertexLayoutForMeshVariant(mesh.variant);
                    if (!originalLayout) throw new Error('Style has no terrain vertex layout');
                    const draped = drapeTerrainMesh({vertices: mesh.vertex_data, indices: mesh.vertex_elements || false,
                        layout: originalLayout, origin: [tile.min!.x, tile.min!.y], tileZoom: tile.coords!.z, styleZoom: tile.style_z, ribbonZoom: this.terrainRibbonZoom,
                        annotations: ['points', 'text'].includes(this.baseStyle()),
                        styled: ['polygons', 'lines'].includes(this.baseStyle()),
                        ground: this.baseStyle() === 'raster' && this.terrain.querySurfaceStyles.includes(this.name), terrain: this.terrain});
                    mesh.vertex_data = draped.vertices; mesh.vertex_elements = draped.indices;
                    if (mesh.labels) {
                        const stride = getTerrainVertexLayout(originalLayout).stride;
                        for (const label of Object.values(mesh.labels)) label.ranges = label.ranges.map(([offset, count]) => [offset / originalLayout.stride * stride, count]);
                    }
                    mesh.variant = {...mesh.variant, terrain: true, terrainStatistics: draped.statistics, terrainTransitionDuration: this.terrain.transitionDuration,
                        terrainGeneration: this.terrain.transitionGeneration, terrainGroundClip: draped.groundClip};
                    if (!draped.indices.length) {delete tile_data.meshes[variant]; delete transferredMeshes[variant]; continue;}
                    if (this.terrain.querySurfaceStyles.includes(this.name)) {
                        if (this.baseStyle() !== 'raster') throw new Error('Terrain query surfaces require a ground raster style');
                        mesh.terrain_surface = extractDrapedTerrainQueryMesh(draped.vertices, draped.indices, getTerrainVertexLayout(originalLayout), [tile.min!.x, tile.min!.y], tile.coords!.z, this.terrain.maxQueryMeshBytes, draped.groundPositions);
                    }
                }
                if (this.cpu_projection) {
                    if (!['polygons', 'raster', 'lines', 'points', 'text'].includes(this.baseStyle())) throw new Error('CPU projection requires ground meshes or screen-facing annotations');
                    const layout = this.vertexLayoutForMeshVariant(mesh.variant);
                    if (!layout) throw new Error('Style has no projected vertex layout');
                    const geometry = this.baseStyle();
                    if (geometry !== 'polygons' && geometry !== 'raster' && geometry !== 'lines' && geometry !== 'points' && geometry !== 'text') throw new Error('Unsupported projected style geometry');
                    const projection = this.cpu_projection;
                    const projected = await projectTileMesh({vertices: mesh.vertex_data, indices: mesh.vertex_elements || false,
                        layout, tile: {...tile, min: tile.min!, coords: tile.coords!}, geometry, projection,
                        projectionCacheKey: this.projection_target,
                        projectPositions: this.projection_target ? coordinates => WorkerBroker.postMessage(
                            `${this.projection_target}.projectPositions`, WorkerBroker.withTransferables(coordinates, projection.type)) : undefined});
                    mesh.vertex_data = projected.vertices;
                    mesh.vertex_elements = projected.indices;
                    if (projected.indices.length === 0) {delete tile_data.meshes[variant]; delete transferredMeshes[variant];}
                }
            }

            // Fully clipped meshes need neither GPU buffers nor raster texture acquisition.
            if ((this.cpu_projection || this.terrain) && Object.keys(tile_data.meshes).length === 0) return null;

            // Load raster tiles passed from data source
            // Blocks mesh completion to avoid flickering
            return this.buildRasterTextures(tile, Object.assign(tile_data, {meshes: Object.assign(tile_data.meshes, transferredMeshes)}));
        }
        else {
            return null; // don't send tile data back if doesn't have geometry
        }
    },

    // Has mesh data for a given tile?
    hasDataForTile (this: StyleRuntime, tile: Pick<WorkerBuildTile, 'id'>) {
        return this.tile_data[tile.id] != null;
    },

    getTileMesh (this: StyleRuntime, tile: Pick<WorkerBuildTile, 'id'>, variant: GeometryMeshVariant & TileMeshVariant) {
        const data = this.tile_data[tile.id];
        if (!data) throw new Error('Style tile geometry has not started');
        const meshes = data.meshes;
        if (meshes[variant.key] == null) {
            const vertex_layout = this.vertexLayoutForMeshVariant(variant);
            if (!vertex_layout) throw new Error('Style has no vertex layout');
            meshes[variant.key] = {
                variant,
                vertex_data: vertex_layout.createVertexData()
            };
        }
        return meshes[variant.key];
    },

    vertexLayoutForMeshVariant (_variant: TileMeshVariant | undefined): VertexLayout | undefined {
        // styles must implement
        return undefined;
    },

    meshVariantTypeForDraw (_draw: BuildDraw): (GeometryMeshVariant & TileMeshVariant) | undefined {
        // styles must implement
        return undefined;
    },

    addFeature (this: StyleRuntime, feature: BuildFeature, draw: BuildDraw, context: BuildContext) {
        let tile = context.tile;
        if (tile.generation !== this.generation) {
            return;
        }

        if (!this.tile_data[tile.id]) {
            this.startData(tile);
        }

        let style = this.parseFeature(feature, draw, context);
        if (!style) {
            return; // skip feature
        }

        if (Number(this.buildGeometry(feature.geometry, style, context)) > 0 && this.generation !== undefined) {
            markFeatureRendered(feature, this.generation); // bookkeeping must not mutate shared decoded content
        }
    },

    buildGeometry (this: StyleRuntime, geometry: BuildGeometry, style: BuildFeatureStyle, context: BuildContext) {
        let geom_count: number | undefined;
        if (geometry.type === 'Polygon') {
            geom_count = this.buildPolygons([geometry.coordinates], style, context);
        }
        else if (geometry.type === 'MultiPolygon') {
            geom_count = this.buildPolygons(geometry.coordinates, style, context);
        }
        else if (geometry.type === 'LineString') {
            geom_count = this.buildLines([geometry.coordinates], style, context);
        }
        else if (geometry.type === 'MultiLineString') {
            geom_count = this.buildLines(geometry.coordinates, style, context);
        }
        else if (geometry.type === 'Point') {
            geom_count = this.buildPoints([geometry.coordinates], style, context);
        }
        else if (geometry.type === 'MultiPoint') {
            geom_count = this.buildPoints(geometry.coordinates, style, context);
        }

        // Optionally collect per-layer stats
        if (geom_count !== undefined && geom_count > 0 && debugSettings.layer_stats) {
            let tile = context.tile;
            if (!tile.debug) throw new Error('Style debug tile has no counters');
            tile.debug.layers = tile.debug.layers || { list: {}, tree: {} };
            let list = tile.debug.layers.list;
            let tree = tile.debug.layers.tree;
            let ftree: CountedLayerTree = {}; // tree of layers for this feature
            context.layers?.forEach(layer => {
                addLayerDebugEntry(list, layer, 1, geom_count, {[this.name]: geom_count}, {[this.baseStyle()]: geom_count});

                let node = tree;
                let fnode = ftree;
                let levels = layer.split(':');
                for (let i=0; i < levels.length; i++) {
                    let level = levels[i];
                    node[level] = node[level] || { features: 0, geoms: 0, styles: {}, base: {} };

                    if (fnode[level] == null) { // only count each layer level once per feature
                        fnode[level] = {};
                        addLayerDebugEntry(node, level, 1, geom_count, {[this.name]: geom_count}, {[this.baseStyle()]: geom_count});
                    }

                    if (i < levels.length - 1) {
                        node[level].layers = node[level].layers || {};
                    }
                    node = node[level].layers ?? {};
                    fnode = fnode[level];
                }
            });
        }

        return geom_count;
    },

    parseFeature (this: StyleRuntime, feature: BuildFeature, draw: BuildDraw, context: BuildContext): BuildFeatureStyle | undefined {
        try {
            var style: BuildFeatureStyle | undefined = this.feature_style;

            // Calculate order
            style.order = this.parseOrder(draw.order, context);
            if (style.order == null && this.blend !== 'overlay') {
                let msg = `Layer '${draw.layers?.join(', ')}', draw group '${draw.group}': `;
                msg += '\'order\' parameter is required unless blend mode is \'overlay\'';
                if (draw.order != null) {
                    msg += '; \'order\' was set to a dynamic value (e.g. string tied to feature property, ';
                    msg += 'or JS function), but evaluated to null for one or more features';
                }
                log({ level: 'warn', once: true }, msg);
                return;
            }

            // Subclass implementation
            style = this._parseFeature(feature, draw, context);
            if (!style) {
                return; // skip feature
            }

            // Custom attributes
            if (this.shaders.attributes) {
                style.attributes = style.attributes || {};
                for (const aname in this.shaders.attributes) {
                    const attribute = draw.attributes?.[aname];
                    if (attribute !== undefined && !isPropertyCache(attribute)) throw new Error('Custom attribute is not preprocessed');
                    style.attributes[aname] = StyleParser.evalCachedProperty(attribute, context);
                    // set attribute value to zero for null/undefined/non-numeric values
                    if (typeof style.attributes[aname] !== 'number') {
                        style.attributes[aname] = 0;
                    }
                }
            }

            // Feature selection (only if feature is marked as interactive, and style supports it)
            if (this.selection) {
                style.interactive = StyleParser.evalProperty(draw.interactive, context);
            }
            else {
                style.interactive = false;
            }

            if (style.interactive === true) {
                const tile = context.tile;
                if (tile.generation == null || !tile.key || !tile.coords || tile.style_z === undefined || !tile.source) throw new Error('Interactive style tile is incomplete');
                if (typeof context.source !== 'string' || (context.layer !== undefined && typeof context.layer !== 'string')) throw new Error('Interactive style context has invalid source metadata');
                style.selection_color = FeatureSelection.makeColor(feature, {...tile, key: tile.key, coords: tile.coords, style_z: tile.style_z, source: tile.source, generation: tile.generation}, {...context, layers: context.layers ?? [], source: context.source, layer: context.layer});
            }
            else {
                style.selection_color = FeatureSelection.defaultColor;
            }

            return style;
        }
        catch (error) {
            log('error', 'Style.parseFeature: style parsing error', feature, style, error instanceof Error ? error.stack : undefined);
        }
    },

    _parseFeature (this: StyleRuntime, _feature: BuildFeature, _draw: BuildDraw, _context: BuildContext): BuildFeatureStyle | undefined {
        return this.feature_style;
    },

    preprocess (this: StyleRuntime, draw: BuildDraw) {
        // Preprocess first time
        if (!draw.preprocessed) {
            // Apply draw defaults
            if (this.draw) {
                // Merge each property separately to avoid modifying `draw` instance identity
                for (let param in this.draw) {
                    let val = this.draw[param];
                    if (typeof val === 'object' && !Array.isArray(val)) {  // nested param (e.g. `outline`)
                        Reflect.set(draw, param, mergeObjects({}, val, Object(Reflect.get(draw, param))));
                    }
                    else if (Reflect.get(draw, param) == null) { // simple param (single scalar value or array)
                        Reflect.set(draw, param, val);
                    }
                }
            }

            if (!this.selection) {
                draw.interactive = false; // always disable feature selection for when style doesn't support it
            }
            else if (this.introspection) {
                draw.interactive = true;  // always enable feature selection for introspection
            }

            const preprocessed = this._preprocess(draw); // optional subclass implementation
            if (!preprocessed) {
                return;
            }
            draw = preprocessed;

            // Custom attributes
            if (this.shaders.attributes) {
                draw.attributes = draw.attributes || {};
                for (const aname in this.shaders.attributes) {
                    draw.attributes[aname] = StyleParser.createPropertyCache(
                        draw.attributes[aname] != null ? draw.attributes[aname] : 0);
                }
            }

            draw.preprocessed = true;
        }
        return draw;
    },

    // optionally implemented by subclass
    _preprocess (draw: BuildDraw): BuildDraw | undefined {
        return draw;
    },

    // Parse an order value
    parseOrder (order: unknown, context: PropertyContext): unknown {
        // Calculate order if it was not cached
        if (typeof order !== 'number') {
            return StyleParser.calculateOrder(order, context);
        }
        return order;
    },

    // Expand final precision for half-layers (for outlines)
    scaleOrder (order: number) {
        return order * 2;
    },

    // Parse a color of choose a default if acceptable, return undefined if color missing
    parseColor(this: StyleRuntime, color: PropertyCache | null | undefined, context: PropertyContext) {
        // Need either a color, or a shader block for 'color' or 'filter'
        if (color) {
            return StyleParser.evalCachedColorProperty(color, context);
        }
        else if (this.shaders.blocks?.color || this.shaders.blocks?.filter) {
            return StyleParser.defaults.color;
        }
    },

    // Build functions are no-ops until overriden
    buildPolygons (_polygons: Extract<BuildGeometry, {type: 'MultiPolygon'}>['coordinates'], _style: BuildFeatureStyle, _context: BuildContext) { return 0; },
    buildLines (_lines: number[][][], _style: BuildFeatureStyle, _context: BuildContext) { return 0; },
    buildPoints (_points: number[][], _style: BuildFeatureStyle, _context: BuildContext) { return 0; },


    /*** GL state and rendering ***/

    setGL (this: StyleRuntime, gl: WebGLRenderingContext | null, uniform_blocks: Record<string, UniformBuffer> = {}, options: StyleGLOptions = {}) {
        this.gl = gl;
        this.resource_context = options.resourceContext || gl;
        this.uniform_blocks = uniform_blocks;
        this.shader_language = options.shaderLanguage || 'glsl';
        this.shader_factory = options.shaderFactory;
        this.shader_program_validator = options.shaderProgramValidator;
        this.device_shader_compilation = options.deviceShaderCompilation === true;
        this.uniform_block_factory = options.uniformBlockFactory;
        this.mesh_buffer_factory = options.meshBufferFactory;
        this.texture_factory = options.textureFactory;
        this.defer_uniform_blocks = options.deferUniformBlocks === true;
        this.defer_texture_bindings = options.deferTextureBindings === true;
        this.defer_uniform_updates = options.deferUniformUpdates === true;
        this.max_texture_size = options.maxTextureSize || Texture.getMaxTextureSize(this.gl);
        if (Object.prototype.hasOwnProperty.call(this, 'portable_material_buffer')) {
            this.portable_material_buffer?.destroy();
        }
        this.portable_material_buffer = null;
        this.portable_lighting_mode = undefined;
        this.portable_light_count = options.portableLightCount;
        if (options.portableLighting && ['polygons', 'lines', 'raster'].includes(this.baseStyle())) {
            this.portable_lighting_mode = this.defines.TANGRAM_LIGHTING_VERTEX ? 'vertex' :
                this.defines.TANGRAM_LIGHTING_FRAGMENT ? 'fragment' : false;
            if (this.portable_lighting_mode) {
                if (!(this.material instanceof Material)) throw new Error('Style material has not been initialized');
                if (!this.uniform_block_factory) throw new Error('Style has no uniform block factory');
                getPortableMaterialUniforms(this.material);
                this.portable_material_buffer = this.uniform_block_factory({
                    name: 'TangramMaterial', binding: 7, uniforms: PORTABLE_MATERIAL_UNIFORMS
                });
                this.uniform_blocks = {...this.uniform_blocks, TangramMaterial: this.portable_material_buffer};
            }
        }
    },

    makeMesh (this: StyleRuntime, vertex_data: Uint8Array, vertex_elements: MeshElementData, options: Partial<TileStylePayload> = {}) {
        options = { ...options, bufferFactory: this.mesh_buffer_factory };
        if (['polygons', 'lines', 'raster'].includes(this.baseStyle()) &&
            Number.isInteger(options.tileZoom)) {
            options.globeRefinement = {tileZoom: Number(options.tileZoom), tileScale: Geo.tile_scale};
            if (this.shaders?.blocks?.position) {
                options.globeRefinementError = `Globe projection does not support style '${this.name}' with a position shader block`;
            }
        }
        // Custom layout hooks may intentionally ignore absent variant metadata.
        let vertex_layout = this.vertexLayoutForMeshVariant(options.variant);
        if (!vertex_layout) throw new Error('Style has no mesh vertex layout');
        if (options.variant?.terrain) {
            vertex_layout = getTerrainVertexLayout(vertex_layout);
            // The worker already refines terrain topology; do not rebuild a second main-thread globe mesh.
            options.globeRefinement = undefined;
        }

        if (debugSettings.wireframe) {
            // In wireframe debug mode, transform mesh into lines
            vertex_elements = makeWireframeForTriangleElementData(vertex_elements || new Uint16Array());
            return new VBOMesh(this.gl, vertex_data, vertex_elements, vertex_layout,
                { ...options, globeRefinement: undefined, draw_mode: 0x0001 });
        }

        return new VBOMesh(this.gl, vertex_data, vertex_elements, vertex_layout, options);
    },

    render (mesh: VBOMesh, options: MeshRenderOptions) {
        return mesh.render(options);
    },

    // Get a specific program, compiling if necessary
    getProgram (this: StyleRuntime, key: 'program' | 'selection_program' = 'program') {
        this.compileSetup();

        const program = this[key];
        if (!program || program.error) {
            return;
        }

        if (!program.compiled) {
            log('debug', `Compiling style '${this.name}', program key '${key}'`);
            try {
                program.compile();
            }
            catch (e) {
                log('error', `Style: error compiling program for style '${this.name}' (program key '${key}')`,
                    this, e instanceof Error ? e.stack : undefined, Reflect.get(Object(e), 'type'), Reflect.get(Object(e), 'shader_errors'));
                throw e; // re-throw so users can be notified via event subscriptions
            }
        }
        return program;
    },

    // One-time setup for compiling style's programs
    compileSetup (this: StyleRuntime) {
        if (this.compile_setup) {
            return;
        }

        if (!this.gl && !this.shader_factory) {
            throw(new Error(`style.compile(): skipping for ${this.name} because no rendering backend is configured`));
        }

        // Build defines & for selection (need to create a new object since the first is stored as a reference by the program)
        var defines = this.buildDefineList();
        var selection_defines: Record<string, unknown> | undefined;
        if (this.selection) {
            selection_defines = Object.assign({}, defines);
            selection_defines.TANGRAM_FEATURE_SELECTION = true;
        }

        // Shader blocks
        const blocks = this.shaders.blocks ?? {};
        const block_scopes = this.shaders.block_scopes ?? {};

        // Uniforms
        var uniforms = Object.assign({}, this.shaders && this.shaders.uniforms);
        for (let u in uniforms) { // validate uniforms
            if (uniforms[u] == null) {
                log({ level: 'warn', once: true }, `Style '${this.name}' has invalid uniform '${u}': uniform values must be non-null`);
            }
        }

        // Accept a single extension, or an array of extensions
        var extensions = (this.shaders && this.shaders.extensions);
        if (typeof extensions === 'string') {
            extensions = [extensions];
        }

        let vertex_shader_src = this.vertex_shader_src;
        let fragment_shader_src = this.fragment_shader_src;
        if (this.shader_language === 'wgsl') {
            if (typeof this.getWGSLShaderSource !== 'function') {
                throw new Error(`style '${this.name}' does not have a portable WGSL shader`);
            }
            vertex_shader_src = fragment_shader_src = this.getWGSLShaderSource();
        }

        // Create shaders
        this.program = new ShaderProgram(
            this.gl,
            vertex_shader_src,
            fragment_shader_src,
            {
                name: this.name,
                defines,
                uniforms,
                uniform_blocks: this.uniform_blocks ?? undefined,
                shaderLanguage: this.shader_language,
                deviceShaderCompilation: this.device_shader_compilation,
                shaderProgramValidator: this.shader_program_validator,
                deferUniformBlocks: this.defer_uniform_blocks,
                deferTextureBindings: this.defer_texture_bindings,
                deferUniformUpdates: this.defer_uniform_updates,
                shaderFactory: this.shader_factory,
                blocks,
                block_scopes,
                extensions
            }
        );

        if (this.selection) {
            const selection_source = this.shader_language === 'wgsl' ? this.getWGSLShaderSource?.(true) : null;
            this.selection_program = new ShaderProgram(
                this.gl,
                selection_source ?? this.vertex_shader_src,
                selection_source ?? selection_fragment_source,
                {
                    name: (this.name + ' (selection)'),
                    defines: selection_defines,
                    uniforms,
                    uniform_blocks: this.uniform_blocks ?? undefined,
                    shaderLanguage: this.shader_language,
                    deviceShaderCompilation: this.device_shader_compilation,
                    shaderProgramValidator: this.shader_program_validator,
                    deferUniformBlocks: this.defer_uniform_blocks,
                    deferTextureBindings: this.defer_texture_bindings,
                    deferUniformUpdates: this.defer_uniform_updates,
                    shaderFactory: this.shader_factory,
                    blocks,
                    block_scopes,
                    extensions
                }
            );
        }
        else {
            this.selection_program = null;
        }

        this.compile_setup = true;
    },

    // Add a shader block
    addShaderBlock (this: StyleRuntime, key: string, block: string, scope: string | null = null) {
        this.shaders.blocks = this.shaders.blocks || {};
        this.shaders.blocks[key] = this.shaders.blocks[key] || [];
        this.shaders.blocks[key].push(block);

        this.shaders.block_scopes = this.shaders.block_scopes || {};
        this.shaders.block_scopes[key] = this.shaders.block_scopes[key] || [];
        this.shaders.block_scopes[key].push(scope);
    },

    // Remove all shader blocks for key
    removeShaderBlock (this: StyleRuntime, key: string) {
        if (this.shaders.blocks) {
            this.shaders.blocks[key] = null;
        }

        if (this.shaders.block_scopes) {
            this.shaders.block_scopes[key] = null;
        }
    },

    replaceShaderBlock (this: StyleRuntime, key: string, block: string, scope: string | null = null) {
        this.removeShaderBlock(key);
        this.addShaderBlock(key, block, scope);
    },

    /** TODO: could probably combine and generalize this with similar method in ShaderProgram
     * (list of define objects that inherit from each other)
     */
    buildDefineList (this: StyleRuntime) {
        // Add any custom defines to built-in style defines
        var defines: Record<string, unknown> = {}; // create a new object to avoid mutating a prototype value that may be shared with other styles
        if (this.defines != null) {
            for (var d in this.defines) {
                defines[d] = this.defines[d];
            }
        }
        if (this.shaders != null && this.shaders.defines != null) {
            for (d in this.shaders.defines) {
                defines[d] = this.shaders.defines[d];
            }
        }
        return defines;

    },

    // Determines if 'raster' parameter is set to a valid value
    hasRasters (this: StyleRuntime) {
        return (['color', 'normal', 'custom'].indexOf(String(this.raster)) > -1);
    },

    // Setup raster access in shaders
    setupRasters (this: StyleRuntime) {
        if (!this.hasRasters()) {
            return;
        }

        // Enable raster textures and configure how first raster is applied
        if (this.raster === 'color') {
            this.defines.TANGRAM_RASTER_TEXTURE_COLOR = true;
        }
        else if (this.raster === 'normal') {
            this.defines.TANGRAM_RASTER_TEXTURE_NORMAL = true;
        }
        // else custom raster (samplers will be made available but not automatically applied)

        // A given style may be built with multiple data sources, each of which may attach
        // a variable number of raster sources (0 to N, where N is the max number of raster sources
        // defined for the scene). This means we don't know *which* or *how many* rasters will be
        // bound now, at initial compile-time; we only know this at geometry build-time. To ensure
        // that we can bind as many raster sources as needed, we declare our uniform arrays to hold
        // the maximum number of possible sources. At render time, only the necessary number of rasters
        // are bound (the remaining slots aren't intended to be accessed).
        let num_raster_sources =
            Object.keys(this.sources)
                .filter(s => this.sources[s] instanceof RasterTileSource)
                .length;

        this.defines.TANGRAM_NUM_RASTER_SOURCES = `${num_raster_sources}`; // force to string to avoid auto-float conversion
        if (num_raster_sources > 0) {
            // Track how many raster sources have alpha masking (used for handling transparency outside raster image)
            const num_masked_rasters = Object.keys(this.sources)
                .filter(s => 'mask_alpha' in this.sources[s] && this.sources[s].mask_alpha)
                .length;
            this.defines.TANGRAM_HAS_MASKED_RASTERS = (num_masked_rasters > 0);
            this.defines.TANGRAM_ALL_MASKED_RASTERS = (num_masked_rasters === num_raster_sources);

            // Use model position of tile's coordinate zoom for raster tile texture UVs
            this.defines.TANGRAM_MODEL_POSITION_BASE_ZOOM_VARYING = true;

            // Uniforms and samplers
            // Global style blocks are compiled in both stages, even when only
            // the fragment stage samples rasters. Decoding itself is binding-free.
            this.replaceShaderBlock('raster', `${heightDecode.vs}\n${rasters_source}`, 'Raster');
        }
    },

    // Load raster tile textures and set uniforms
    async buildRasterTextures (this: StyleRuntime, tile: import('./style-runtime-types').StyleFinalizeTile, tile_data: BuildTileData<Uint8Array>) {
        // skip if style doesn't support rasters
        if (!this.hasRasters()) {
            return tile_data;
        }

        // skip if source didn't attach any rasters to tile
        if (!tile.rasters?.length) {
            return tile_data;
        }
        const coords = tile.coords;
        if (!coords) throw new Error('Raster tile has no address');

        // Load textures on main thread and return when done
        // We want to block the building of a raster tile mesh until its texture is loaded,
        // to avoid flickering while loading (texture will render as black)
        let textures;
        try {
            textures = await WorkerBroker.postMessage<RasterTextureInfo[] | undefined>(
                `${this.main_thread_target}.loadTextures`,
                { coords: tile.coords, source: tile.source, rasters: tile.rasters, min: tile.min, max: tile.max }
            );
        }
        catch (e) { // error thrown if style has been removed from main thread
            return tile_data;
        }

        if (!textures || textures.length < 1) { // no textures found (unexpected)
            // TODO: warning
            return tile_data;
        }
        else if (textures.some(t => !t.loaded)) { // some textures failed, throw out style for this tile
            return null;
        }

        // Enable alpha masking if needed (for transparency outside raster image, on first raster only)
        const firstRaster = this.sources[tile.rasters[0]];
        tile_data.uniforms['u_raster_mask_alpha'] = ('mask_alpha' in firstRaster && firstRaster.mask_alpha === true);

        // Set texture uniforms (returned after loading from main thread)
        const u_samplers: string[] = tile_data.uniforms['u_rasters'] = [];
        const u_sizes: number[][] = tile_data.uniforms['u_raster_sizes'] = [];
        const u_offsets: number[][] = tile_data.uniforms['u_raster_offsets'] = [];

        textures.forEach(t => {
            const i = t.index;
            u_samplers[i] = t.name;
            tile_data.textures.push(t.name);

            u_sizes[i] = [t.width, t.height];

            // Tile geometry may be at a higher zoom than the raster tile texture,
            // (e.g. an overzoomed raster tile), in which case we need to adjust the
            // raster texture UVs to offset to the appropriate starting point for
            // this geometry tile.
            if (coords.z > t.coords.z) {
                let dz = coords.z - t.coords.z; // # of levels raster source is overzoomed
                let dz2 = Math.pow(2, dz);
                u_offsets[i] = [
                    (((coords.x % dz2) + dz2) % dz2) / dz2, // double-modulo to handle negative (wrapped) tile coords
                    (dz2 - 1 - (coords.y % dz2)) / dz2, // GL texture coords are +Y up
                    1 / dz2
                ];
            }
            else {
                u_offsets[i] = [0, 0, 1];
            }
        });

        return tile_data;
    },

    // Determine which raster tile textures need to load for this tile, load them and return metadata to worker
    // Called on main thread
    async loadTextures (this: StyleRuntime, tile: RasterTextureTile) {
        let configs: Record<string, import('../gl/texture').TextureOptions & {name: string; coords: RasterTextureInfo['coords']}> = {}; // texture configs to pass to texture builder, keyed by texture name
        let index: Record<string, number> = {};   // index into raster sampler array, keyed by texture name
        let queue: Promise<void>[] = [];

        // Find raster textures that need to be loaded
        tile.rasters.map(r => this.sources[r]).filter(x => x).forEach((source, i) => {
            if (source instanceof RasterTileSource) {
                queue.push(source.tileTexture(tile, this).then(config => {
                    configs[config.name] = config;
                    index[config.name] = i;
                }));
            }
        });
        await Promise.all(queue);

        // Create and load raster textures
        await Texture.createFromObject(this.resource_context, configs);
        let textures = await Promise.all(Object.keys(configs)
            .flatMap(name => {const texture = Texture.textures[name]; return texture instanceof Texture ? [texture.load()] : [];})
        );
        textures.forEach(t => t.retain());

        // Take a subset of texture metadata, and decorate with raster-specific info
        // NB: only return name and size of textures loaded, because we can't send actual texture objects to worker
        return textures.map(t => ({
            name: t.name,
            width: t.width,
            height: t.height,
            loaded: t.loaded,
            index: index[t.name],          // raster sampler index
            coords: configs[t.name].coords // tile coords of raster tile
        }));
    },

    // Setup shader definitions for custom attributes
    setupCustomAttributes(this: StyleRuntime) {
        if (this.shaders.attributes) {
            for (const [aname, attrib] of Object.entries(this.shaders.attributes)) {
                // alias each custom attribute to the internal attribute name in vertex shader,
                // and internal varying name in fragment shader (if varying is enabled)
                if (attrib.type === 'float') {
                    if (attrib.varying !== false) {
                        this.addShaderBlock('attributes', `
                            #ifdef TANGRAM_VERTEX_SHADER
                                attribute float a_${aname};
                                varying float v_${aname};
                                #define ${aname} a_${aname}
                            #else
                                varying float v_${aname};
                                #define ${aname} v_${aname}
                            #endif
                        `);
                        this.addShaderBlock('setup', `#ifdef TANGRAM_VERTEX_SHADER\nv_${aname} = a_${aname};\n#endif`);
                    }
                    else {
                        this.addShaderBlock('attributes', `
                            #ifdef TANGRAM_VERTEX_SHADER
                                attribute float a_${aname};
                                #define ${aname} a_${aname}
                            #endif
                        `);
                    }
                }
            }
        }
    },

    // Add custom attributes to a list of attributes for initializing a vertex layout
    addCustomAttributesToAttributeList(this: StyleRuntime, attribs: VertexAttribute[]) {
        if (this.shaders.attributes) {
            for (const [aname, attrib] of Object.entries(this.shaders.attributes)) {
                if (attrib.type === 'float') {
                    attribs.push({ name: `a_${aname}`, size: 1, type: gl.FLOAT, normalized: false });
                }
            }
        }
        return attribs;
    },

    // Add current feature values for custom attributes to vertex template
    addCustomAttributesToVertexTemplate(this: StyleRuntime, draw: BuildFeatureStyle, index: number) {
        if (this.shaders.attributes) {
            for (let aname in this.shaders.attributes) {
                const value = draw.attributes?.[aname];
                this.vertex_template[index++] = typeof value === 'number' ? value : 0;
            }
        }
    },

    // Setup any GL state for rendering
    setup (this: StyleRuntime) {
        this.setUniforms();
        if (this.portable_material_buffer) {
            if (!(this.material instanceof Material)) throw new Error('Style material has not been initialized');
            this.portable_material_buffer.setUniforms(getPortableMaterialUniforms(this.material));
        } else {
            if (!(this.material instanceof Material)) throw new Error('Style material has not been initialized');
            this.material.setupProgram(ShaderProgram.current);
        }
    },

    // Set style uniforms on currently bound program
    setUniforms (this: StyleRuntime) {
        var program = ShaderProgram.current;
        if (!program) {
            return;
        }

        program.setUniforms(this.shaders?.uniforms ?? {}, true); // reset texture unit to 0
    },

    // Render state settings by blend mode
    render_states: {
        opaque: { depth_test: true, depth_write: true },
        translucent: { depth_test: true, depth_write: true },
        add: { depth_test: true, depth_write: false },
        multiply: { depth_test: true, depth_write: false },
        inlay: { depth_test: true, depth_write: false },
        overlay: { depth_test: false, depth_write: false }
    },

    // Default sort order for blend modes
    default_blend_orders: {
        opaque: Number.MIN_SAFE_INTEGER,
        add: 1,
        multiply: 2,
        inlay: 3,
        translucent: 4,
        overlay: 5
    },

    getBlendOrderForDraw (this: StyleRuntime, draw: {blend_order?: number}): number | undefined {
        // Allow draw block to override blend_order for non-opaque blend styles
        return ((this.blend !== 'opaque' && draw.blend_order != null) ? draw.blend_order : this.blend_order);
    }

};

// add feature and geometry counts for a single layer
export function addLayerDebugEntry (target: LayerDebugTree, layer: string, faeture_count: number, geom_count: number, styles: Record<string, number>, bases: Record<string, number>) {
    target[layer] = target[layer] || { features: 0, geoms: 0, styles: {}, base: {} };
    target[layer].features += faeture_count;    // feature count
    target[layer].geoms += geom_count;          // geometry count

    // geometry count by style
    for (let style in styles) {
        target[layer].styles[style] = target[layer].styles[style] || 0;
        target[layer].styles[style] += styles[style];
    }

    // geometry count by base style
    for (let style in bases) {
        target[layer].base[style] = target[layer].base[style] || 0;
        target[layer].base[style] += bases[style];
    }
}

/** Cache normalization installs the value slot before feature evaluation. */
function isPropertyCache(value: unknown): value is PropertyCache {
    return value !== null && typeof value === 'object' && 'value' in value;
}
