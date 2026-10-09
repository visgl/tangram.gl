// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// Polygon rendering style

import type {GeometryStyleRuntime, GeometryFeature, GeometryDraw, RawGeometryDraw, GeometryContext, GeometryMeshVariant, PolygonFeatureStyle, GeometryBuildMesh, GeometryExtrusion} from '../geometry-style-types';
import type {GeometryPolygon} from '../../builders/geometry-types';

import {Style} from '../style';
import StyleParser from '../style_parser';
import gl from '../../gl/constants'; // web workers don't have access to GL context, so import all GL constants
import VertexLayout from '../../gl/vertex_layout';
import {buildPolygons, buildExtrudedPolygons} from '../../builders/polygons';
import Geo from '../../utils/geo';

import polygons_vs from './polygons_vertex.glsl';
import polygons_fs from './polygons_fragment.glsl';
import {buildPolygonsWGSL} from './polygons_wgsl';
import {GLOBE_PROJECTION_GLSL} from '../../scene/projection_shaders';

export const Polygons: GeometryStyleRuntime = Object.create(Style);

Object.assign(Polygons, {
    name: 'polygons',
    built_in: true,
    vertex_shader_src: polygons_vs.replace('#pragma tangram: projection', GLOBE_PROJECTION_GLSL),
    fragment_shader_src: polygons_fs,
    selection: true, // enable feature selection

    getWGSLShaderSource(this: GeometryStyleRuntime, selection = false) {
        return buildPolygonsWGSL({ raster: this.raster === 'color', lighting: this.portable_lighting_mode,
            lightCount: this.portable_light_count, cpuProjection: Boolean(this.cpu_projection), selection });
    },

    init(this: GeometryStyleRuntime) {
        Style.init.apply(this, arguments as unknown as Parameters<typeof Style.init>);

        // Tell the shader about optional attributes (shader is shared with lines style, which has different config)
        this.defines.TANGRAM_NORMAL_ATTRIBUTE = true;
        this.defines.TANGRAM_TEXTURE_COORDS = this.texcoords;
        this.defines.TANGRAM_CPU_PROJECTED = Boolean(this.cpu_projection && ['polygons', 'raster'].includes(this.baseStyle()));
        const positionBlocks = this.shaders?.blocks?.position;
        const attributes = this.shaders?.attributes;
        const hasPositionBlocks = Array.isArray(positionBlocks) ? positionBlocks.length > 0 : Boolean(positionBlocks);
        const hasAttributes = attributes && typeof attributes === 'object' ? Object.keys(attributes).length > 0 : Boolean(attributes);
        if (this.cpu_projection && ['polygons', 'raster'].includes(this.baseStyle()) &&
            (hasPositionBlocks || hasAttributes)) {
            throw new Error('CPU projection requires unlit polygons without position blocks or custom attributes');
        }
    },

    _parseFeature (this: GeometryStyleRuntime, feature: GeometryFeature, draw: GeometryDraw, context: GeometryContext) {
        var style = this.feature_style;

        style.color = this.parseColor(draw.color, context);
        if (!style.color) {
            return null;
        }

        style.alpha = StyleParser.evalCachedProperty(draw.alpha, context) as number | undefined; // optional alpha override

        style.variant = draw.variant; // pre-calculated mesh variant

        style.z = (StyleParser.evalCachedDistanceProperty(draw.z, context) as number) || StyleParser.defaults.z;
        style.z *= Geo.height_scale; // provide sub-meter precision of height values

        style.extrude = StyleParser.evalProperty(draw.extrude, context) as GeometryExtrusion;
        if (style.extrude) {
            // use feature's height and min_height properties
            if (style.extrude === true) {
                style.height = feature.properties.height || StyleParser.defaults.height;
                style.min_height = feature.properties.min_height || StyleParser.defaults.min_height;

            }
            // explicit height, no min_height
            else if (typeof style.extrude === 'number') {
                style.height = style.extrude;
                style.min_height = 0;
            }
            // explicit height and min_height
            else if (Array.isArray(style.extrude)) {
                style.min_height = style.extrude[0];
                style.height = style.extrude[1];
            }

            style.height *= Geo.height_scale;       // provide sub-meter precision of height values
            style.min_height *= Geo.height_scale;
        }

        if (this.cpu_projection) {
            const heights = style.extrude ? [style.z + style.min_height, style.z + style.height] : [style.z];
            if (heights.some(height => !Number.isFinite(height) || height < -32768 || height > 32767)) {
                throw new Error('Projected polygon height exceeds signed 16-bit meter packing');
            }
            if (!this.cpu_projection.allowElevation && heights.some(height => height !== 0)) {
                throw new Error('Projected polygon elevation requires allowElevation');
            }
        }
        style.tile_edges = draw.tile_edges; // usually activated for debugging, or rare visualization needs

        return style;
    },

    _preprocess (this: GeometryStyleRuntime, draw: RawGeometryDraw) {
        draw.color = StyleParser.createColorPropertyCache(draw.color);
        draw.alpha = StyleParser.createPropertyCache(draw.alpha);
        draw.z = StyleParser.createPropertyCache(draw.z, StyleParser.parseUnits);
        this.computeVariant(draw);
        // Cache creation is the normalization boundary for authored draw values.
        return draw as GeometryDraw;
    },

    // Calculate and store mesh variant (unique by draw group but not feature)
    computeVariant (this: GeometryStyleRuntime, draw: GeometryDraw | RawGeometryDraw) {
        // Factors that determine a unique mesh rendering variant
        const selection = (draw.interactive ? 1 : 0); // whether feature has interactivity
        const normal = (draw.extrude != null ? 1 : 0); // whether feature has extrusion (need per-vertex normals)
        const texcoords = (this.texcoords ? 1 : 0); // whether feature has texture UVs
        const blend_order = this.getBlendOrderForDraw(draw);
        const key = [selection, normal, texcoords, blend_order].join('/');
        draw.variant = key;

        if (this.variants[key] == null) {
            this.variants[key] = {
                key,
                blend_order,
                mesh_order: 0,
                selection,
                normal,
                texcoords
            };
        }
    },

    // Override
    // Create or return desired vertex layout permutation based on flags
    vertexLayoutForMeshVariant (this: GeometryStyleRuntime, variant: GeometryMeshVariant) {
        if (this.vertex_layouts[variant.key] == null) {
            const portable_normal = this.shader_language === 'wgsl';
            // Attributes for this mesh variant
            // Optional attributes have placeholder values assigned with `static` parameter
            const attribs = [
                { name: 'a_position', size: 4, type: gl.SHORT, normalized: false },
                {
                    name: 'a_normal',
                    size: portable_normal ? 4 : 3,
                    type: gl.BYTE,
                    normalized: true,
                    static: (variant.normal || portable_normal ? null : [0, 0, 1])
                }, // gets padded to 4-bytes
                { name: 'a_color', size: 4, type: gl.UNSIGNED_BYTE, normalized: true },
                { name: 'a_selection_color', size: 4, type: gl.UNSIGNED_BYTE, normalized: true, static: (variant.selection || portable_normal ? null : [0, 0, 0, 0]) },
                { name: 'a_texcoord', size: 2, type: gl.UNSIGNED_SHORT, normalized: true, static: (variant.texcoords ? null : [0, 0]) }
            ];

            this.addCustomAttributesToAttributeList(attribs);
            if (this.cpu_projection && ['polygons', 'raster'].includes(this.baseStyle())) {
                attribs.push({name: 'a_projected_position', size: 3, type: gl.FLOAT, normalized: false});
                attribs.push({name: 'a_projected_normal', size: 3, type: gl.FLOAT, normalized: false});
            }
            this.vertex_layouts[variant.key] = new VertexLayout(attribs);
        }
        return this.vertex_layouts[variant.key];
    },

    // Override
    meshVariantTypeForDraw (this: GeometryStyleRuntime, draw: Pick<GeometryDraw, 'variant'>) {
        return this.variants[draw.variant]; // return pre-calculated mesh variant
    },

    /**
     * A "template" that sets constant attibutes for each vertex, which is then modified per vertex or per feature.
     * A plain JS array matching the order of the vertex layout.
     */
    makeVertexTemplate(this: GeometryStyleRuntime, style: PolygonFeatureStyle, mesh: GeometryBuildMesh) {
        let i = 0;

        // a_position.xyz - vertex position
        // a_position.w - layer order
        this.vertex_template[i++] = 0;
        this.vertex_template[i++] = 0;
        this.vertex_template[i++] = style.z || 0;
        this.vertex_template[i++] = this.scaleOrder(style.order);

        // a_normal.xyz - surface normal
        // only stored per-vertex for extruded features (hardcoded to 'up' for others)
        if (mesh.variant.normal || this.shader_language === 'wgsl') {
            this.vertex_template[i++] = 0;
            this.vertex_template[i++] = 0;
            this.vertex_template[i++] = 1 * 127;
            if (this.shader_language === 'wgsl') {
                this.vertex_template[i++] = 0;
            }
        }

        // a_color.rgba - feature color
        this.vertex_template[i++] = style.color[0] * 255;
        this.vertex_template[i++] = style.color[1] * 255;
        this.vertex_template[i++] = style.color[2] * 255;
        this.vertex_template[i++] = (style.alpha != null ? style.alpha : style.color[3]) * 255;

        // a_selection_color.rgba - selection color
        if (mesh.variant.selection || this.shader_language === 'wgsl') {
            this.vertex_template[i++] = style.selection_color[0] * 255;
            this.vertex_template[i++] = style.selection_color[1] * 255;
            this.vertex_template[i++] = style.selection_color[2] * 255;
            this.vertex_template[i++] = style.selection_color[3] * 255;
        }

        // a_texcoord.uv - texture coordinates
        if (mesh.variant.texcoords) {
            this.vertex_template[i++] = 0;
            this.vertex_template[i++] = 0;
        }

        this.addCustomAttributesToVertexTemplate(style, i);
        if (this.cpu_projection) {
            const projectedIndex = mesh.vertex_data.vertex_layout.index.a_projected_position;
            this.vertex_template[projectedIndex] = 0;
            this.vertex_template[projectedIndex + 1] = 0;
            this.vertex_template[projectedIndex + 2] = 0;
            const normalIndex = mesh.vertex_data.vertex_layout.index.a_projected_normal;
            if (normalIndex !== undefined) {
                this.vertex_template[normalIndex] = 0;
                this.vertex_template[normalIndex + 1] = 0;
                this.vertex_template[normalIndex + 2] = 1;
            }
        }
        return this.vertex_template;
    },

    buildPolygons(this: GeometryStyleRuntime, polygons: GeometryPolygon[], style: PolygonFeatureStyle, context: GeometryContext) {
        let mesh = this.getTileMesh(context.tile, this.meshVariantTypeForDraw(style));
        let vertex_data = mesh.vertex_data;
        let vertex_layout = vertex_data.vertex_layout;
        let vertex_template = this.makeVertexTemplate(style, mesh);
        let options = {
            texcoord_index: vertex_layout.index.a_texcoord,
            texcoord_normalize: 65535, // scale UVs to unsigned shorts
            remove_tile_edges: !style.tile_edges,
            tile_edge_tolerance: Geo.tile_scale * context.tile.pad_scale * 4,
            winding: context.winding
        };

        // Extruded polygons (e.g. 3D buildings)
        if (style.extrude && style.height) {
            return buildExtrudedPolygons(
                polygons,
                style.z, style.height, style.min_height,
                vertex_data, vertex_template,
                vertex_layout.index.a_normal,
                127, // scale normals to signed bytes
                options
            );
        }
        // Regular polygons
        else {
            return buildPolygons(
                polygons,
                vertex_data, vertex_template,
                options
            );
        }
    }

} satisfies Partial<GeometryStyleRuntime>);
