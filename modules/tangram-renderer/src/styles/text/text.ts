// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// Text rendering style


import type {TextLabelRuntime} from './text_labels';
import type {TextTile, TextFeature, TextContext, TextLabelDraw, TextFeatureQueue, TextLabelCandidate, TextGeometry, TextRenderLabel, TextSprite} from './text-types';
import type {LabelLayout, LabelPointCoordinate} from '../../labels/label-types';
import Geo from '../../utils/geo';
import {Style} from '../style';
import {Points} from '../points/points';
import Collision from '../../labels/collision';
import LabelPoint from '../../labels/label_point';
import LabelLine from '../../labels/label_line';
import gl from '../../gl/constants'; // web workers don't have access to GL context, so import all GL constants
import VertexLayout from '../../gl/vertex_layout';
import {buildTextWGSL} from './text_wgsl';

/** Mesh variant controlling static attributes and point/text shader layout. */
interface TextMeshVariant {
    shader_point: boolean;
    selection: boolean;
}
/** Mutable feature styling consumed by the inherited point quad builder. */
interface TextFeatureStyle {
    label?: TextRenderLabel;
    size?: LabelPointCoordinate | {straight?: LabelPointCoordinate; curved?: LabelPointCoordinate[]};
    texcoords?: number[] | {straight?: TextSprite; curved?: TextSprite[]};
    texcoords_stroke?: number[][];
    label_texture?: string;
    label_textures?: string[];
    blend_order?: number;
}
/** Inherited mesh surface needed to populate a text vertex template. */
interface TextBuildMesh {
    vertex_data: {vertex_layout: VertexLayout};
}
/** Checked standalone-text style, extending only the point/style capabilities it consumes. */
export interface TextStyleRuntime extends TextLabelRuntime {
    /** Whether this is a built-in renderer style. */
    built_in: boolean;
    super: {makeVertexTemplate(this: TextStyleRuntime, style: TextFeatureStyle, mesh: TextBuildMesh, addCustom: boolean): number[]};
    generation: number;
    defines: Record<string, boolean | number | string>;
    queues: Record<string, TextFeatureQueue[]>;
    feature_style: TextFeatureStyle;
    vertex_template: number[];
    vertex_layouts: Record<string, VertexLayout>;
    texture_id: number;
    setupDefines(): void;
    reset(): void;
    queueFeature(feature: TextFeatureQueue, tile: TextTile): void;
    addCustomAttributesToVertexTemplate(style: TextFeatureStyle, index: number): void;
    addCustomAttributesToAttributeList(attributes: ConstructorParameters<typeof VertexLayout>[0]): void;
    getBlendOrderForDraw(draw: TextLabelDraw): number;
    buildLabels(size: LabelPointCoordinate | LabelPointCoordinate[], geometry: TextGeometry, layout: LabelLayout, totalSize?: LabelPointCoordinate): TextRenderLabel[];
    buildLineLabels(line: LabelPointCoordinate[], size: LabelPointCoordinate | LabelPointCoordinate[], layout: LabelLayout, totalSize?: LabelPointCoordinate): TextRenderLabel[];
    init(options?: {generation?: number; styles?: unknown; sources?: Record<string, unknown>}): void;
    getWGSLShaderSource(): string;
    makeVertexTemplate(style: TextFeatureStyle, mesh: TextBuildMesh): number[];
    addFeature(feature: TextFeature, draw: TextLabelDraw, context: TextContext): void;
    endData(tile: TextTile): Promise<TextTileData | undefined>;
    _preprocess(draw: TextLabelDraw): TextLabelDraw | undefined;
    vertexLayoutForMeshVariant(variant: TextMeshVariant): VertexLayout;
}
/** Completed text tile mesh and texture ownership records. */
interface TextTileData {
    textures: string[];
    meshes: Record<string, {uniforms: Record<string, unknown>}>;
}
/** Existing prototype/mixin factory: inherited methods remain implemented by Points. */
export let TextStyle: TextStyleRuntime = Object.create(Points);

Object.assign(TextStyle, {
    name: 'text',
    super: Points,
    built_in: true,

    getWGSLShaderSource(this: TextStyleRuntime) {
        return buildTextWGSL();
    },

    init(this: TextStyleRuntime, options = {}) {
        Style.init.call(this, options);

        // Shader defines
        this.setupDefines();

        // Omit some code for SDF-drawn shader points
        this.defines.TANGRAM_HAS_SHADER_POINTS = false;

        // Indicate vertex shader should apply zoom-interpolated offsets and angles for curved labels
        this.defines.TANGRAM_CURVED_LABEL = true;

        this.reset();
    },

    /**
     * A "template" that sets constant attibutes for each vertex, which is then modified per vertex or per feature.
     * A plain JS array matching the order of the vertex layout.
     */
    makeVertexTemplate(this: TextStyleRuntime, style: TextFeatureStyle, mesh: TextBuildMesh) {
        this.super.makeVertexTemplate.call(this, style, mesh, /* add_custom_attribs */ false);
        let vertex_layout = mesh.vertex_data.vertex_layout;
        let i = vertex_layout.index.a_pre_angles;

        // a_pre_angles.xyzw - rotation of entire curved label
        // a_angles.xyzw - angle of each curved label segment
        // a_offsets.xyzw - offset of each curved label segment
        for (let j=0; j < 12; j++) {
            this.vertex_template[i++] = 0;
        }

        this.addCustomAttributesToVertexTemplate(style, i);
        return this.vertex_template;
    },

    reset(this: TextStyleRuntime) {
        this.queues = {};
        this.resetText();
    },

    // Override to queue features instead of processing immediately
    addFeature (this: TextStyleRuntime, feature: TextFeature, draw: TextLabelDraw, context: TextContext) {
        let tile = context.tile;
        if (tile.generation !== this.generation) {
            return;
        }

        let type = feature.geometry.type;
        draw.can_articulate = (type === 'LineString' || type === 'MultiLineString');

        // supersample text rendering for angled labels, to improve clarity
        draw.supersample_text = (type === 'LineString' || type === 'MultiLineString');

        let q = this.parseTextFeature(feature, draw, context, tile);
        if (!q) {
            return;
        }

        // text can be an array if a `left` or `right` orientation key is defined for the text source
        // in which case, push both text sources to the queue
        if (q instanceof Array){
            q.forEach(q => {
                q.feature = feature;
                q.context = context;
                q.layout.vertex = false; // vertex placement option not applicable to standalone labels
                this.queueFeature(q as TextFeatureQueue, tile); // queue the feature for later processing
            });
        }
        else {
            q.feature = feature;
            q.context = context;
            q.layout.vertex = false; // vertex placement option not applicable to standalone labels
            this.queueFeature(q as TextFeatureQueue, tile); // queue the feature for later processing
        }

        // Register with collision manager
        Collision.addStyle(this.name, tile.id);
    },

    // Override
    async endData (this: TextStyleRuntime, tile: TextTile) {
        let queue = this.queues[tile.id];
        delete this.queues[tile.id];

        const { labels, texts, textures } = await this.collideAndRenderTextLabels(tile, this.name, queue);

        if (labels && texts) {
            this.texts[tile.id] = texts;

            // Build queued features
            labels.forEach(q => {
                let text_settings_key = q.text_settings_key;
                let text_info =
                    this.texts[tile.id][text_settings_key] &&
                    this.texts[tile.id][text_settings_key][q.text];

                // setup styling object expected by Style class
                let style = this.feature_style;
                style.label = q.label;

                if (text_info.text_settings.can_articulate){
                    // unpack logical sizes of each segment into an array for the style
                    style.size = {};
                    style.texcoords = {};

                    if (q.label.type === 'straight'){
                        style.size.straight = text_info.size!.logical_size;
                        style.texcoords.straight = text_info.texcoords!.straight!;
                        style.label_texture = textures![text_info.texcoords!.straight!.texture_id];
                    }
                    else{
                        style.size.curved = text_info.segment_sizes!.map(function(size){ return size.logical_size; });
                        style.texcoords_stroke = text_info.texcoords_stroke;
                        style.texcoords.curved = text_info.texcoords!.curved!;
                        style.label_textures = text_info.texcoords!.curved!.map(t => textures![t.texture_id]);
                    }
                }
                else {
                    style.size = text_info.size!.logical_size;
                    style.texcoords = text_info.align![q.label.align!].texcoords;
                    style.label_texture = textures![text_info.align![q.label.align!].texture_id!];
                }

                style.blend_order = q.draw.blend_order; // copy pre-computed blend order
                Style.addFeature.call(this, q.feature, q.draw, q.context);
            });
        }
        this.freeText(tile);

        // Finish tile mesh
        const tile_data = await Style.endData.call(this, tile);
        if (tile_data) {
            // Attach tile-specific label atlas to mesh as a texture uniform
            if (textures && textures.length) {
                tile_data.textures.push(...textures); // assign texture ownership to tile
            }

            // Always apply shader blocks to standalone text
            for (let m in tile_data.meshes) {
                tile_data.meshes[m].uniforms.u_apply_color_blocks = true;
            }
        }

        return tile_data;
    },

    // Sets up caching for draw properties
    _preprocess (this: TextStyleRuntime, draw: TextLabelDraw) {
        draw.blend_order = this.getBlendOrderForDraw(draw); // from draw block, or fall back on default style blend order
        return this.preprocessText(draw);
    },

    // Implements label building for TextLabels mixin
    buildTextLabels (this: TextStyleRuntime, tile: TextTile, feature_queue: TextFeatureQueue[]): TextLabelCandidate[] {
        let labels: TextLabelCandidate[] = [];
        for (let f=0; f < feature_queue.length; f++) {
            let fq = feature_queue[f];
            let text_info = this.texts[tile.id][fq.text_settings_key][fq.text];
            let feature_labels;

            fq.layout.vertical_buffer = text_info.vertical_buffer!;

            if (text_info.text_settings.can_articulate){
                var sizes = text_info.segment_sizes!.map(size => size.collision_size);
                fq.layout.no_curving = text_info.no_curving;
                feature_labels = this.buildLabels(sizes, fq.feature.geometry, fq.layout, text_info.size!.collision_size);
            }
            else {
                feature_labels = this.buildLabels(text_info.size!.collision_size, fq.feature.geometry, fq.layout);
            }
            for (let i = 0; i < feature_labels.length; i++) {
                let fql: TextLabelCandidate = Object.create(fq);
                fql.label = feature_labels[i];
                labels.push(fql);
            }
        }
        return labels;
    },

    // Builds one or more labels for a geometry
    buildLabels (this: TextStyleRuntime, size: LabelPointCoordinate | LabelPointCoordinate[], geometry: TextGeometry, layout: LabelLayout, total_size?: LabelPointCoordinate): TextRenderLabel[] {
        let labels: TextRenderLabel[] = [];

        if (geometry.type === 'LineString') {
            Array.prototype.push.apply(labels, this.buildLineLabels(geometry.coordinates, size, layout, total_size));
        } else if (geometry.type === 'MultiLineString') {
            let lines = geometry.coordinates;
            for (let i = 0; i < lines.length; ++i) {
                Array.prototype.push.apply(labels, this.buildLineLabels(lines[i], size, layout, total_size));
            }
        } else if (geometry.type === 'Point') {
            labels.push(new LabelPoint(geometry.coordinates, size as LabelPointCoordinate, layout));
        } else if (geometry.type === 'MultiPoint') {
            let points = geometry.coordinates;
            for (let i = 0; i < points.length; ++i) {
                labels.push(new LabelPoint(points[i], size as LabelPointCoordinate, layout));
            }
        } else if (geometry.type === 'Polygon') {
            let centroid = Geo.centroid(geometry.coordinates);
            if (centroid) { // skip degenerate polygons
                labels.push(new LabelPoint(centroid as LabelPointCoordinate, size as LabelPointCoordinate, layout));
            }
        } else if (geometry.type === 'MultiPolygon') {
            let centroid = Geo.multiCentroid(geometry.coordinates);
            if (centroid) { // skip degenerate polygons
                labels.push(new LabelPoint(centroid as LabelPointCoordinate, size as LabelPointCoordinate, layout));
            }
        }

        return labels;
    },

    // Build one or more labels for a line geometry
    buildLineLabels (this: TextStyleRuntime, line: LabelPointCoordinate[], size: LabelPointCoordinate | LabelPointCoordinate[], layout: LabelLayout, total_size?: LabelPointCoordinate): TextRenderLabel[] {
        let labels: TextRenderLabel[] = [];
        let subdiv = Math.min(layout.subdiv, line.length - 1);
        if (subdiv > 1) {
            // Create multiple labels for line, with each allotted a range of segments
            // in which it will attempt to place
            let seg_per_div = (line.length - 1) / subdiv;
            for (let i = 0; i < subdiv; i++) {
                let start = Math.floor(i * seg_per_div);
                let end = Math.floor((i + 1) * seg_per_div) + 1;
                let line_segment = line.slice(start, end);

                let label = LabelLine.create(size, total_size, line_segment, layout);
                if (label){
                    labels.push(label);
                }
            }
        }

        // Consider full line for label placement if no subdivisions requested, or as last resort if not enough
        // labels placed (e.g. fewer than requested subdivisions)
        // TODO: refactor multiple label placements per line / move into label placement class for better effectiveness
        if (labels.length < subdiv) {
            let label = LabelLine.create(size, total_size, line, layout);
            if (label){
                labels.push(label);
            }
        }
        return labels;
    },

    // Override
    // Create or return vertex layout
    vertexLayoutForMeshVariant(this: TextStyleRuntime, variant: TextMeshVariant): VertexLayout {
        // Vertex layout only depends on shader point flag, so using it as layout key to avoid duplicate layouts
        if (this.vertex_layouts[variant.shader_point as unknown as string] == null) {
            // TODO: could make selection, offset, and curved label attribs optional, but may not be worth it
            // since text points generally don't consume much memory anyway
            const attribs: ConstructorParameters<typeof VertexLayout>[0] = [
                { name: 'a_position', size: 4, type: gl.SHORT, normalized: false },
                { name: 'a_shape', size: 4, type: gl.SHORT, normalized: false },
                { name: 'a_texcoord', size: 2, type: gl.UNSIGNED_SHORT, normalized: true },
                { name: 'a_offset', size: 2, type: gl.SHORT, normalized: false },
                { name: 'a_color', size: 4, type: gl.UNSIGNED_BYTE, normalized: true },
                { name: 'a_selection_color', size: 4, type: gl.UNSIGNED_BYTE, normalized: true, static: (variant.selection ? null! : [0, 0, 0, 0]) },
                { name: 'a_pre_angles', size: 4, type: gl.BYTE, normalized: false },
                { name: 'a_angles', size: 4, type: gl.SHORT, normalized: false },
                { name: 'a_offsets', size: 4, type: gl.UNSIGNED_SHORT, normalized: false },
            ];

            this.addCustomAttributesToAttributeList(attribs);
            this.vertex_layouts[variant.shader_point as unknown as string] = new VertexLayout(attribs);
        }
        return this.vertex_layouts[variant.shader_point as unknown as string];
    },
} satisfies Pick<TextStyleRuntime,
    'name' | 'super' | 'built_in' | 'getWGSLShaderSource' | 'init' | 'makeVertexTemplate' |
    'reset' | 'addFeature' | 'endData' | '_preprocess' | 'buildTextLabels' | 'buildLabels' |
    'buildLineLabels' | 'vertexLayoutForMeshVariant'>);

TextStyle.texture_id = 0; // namespaces per-tile label textures
