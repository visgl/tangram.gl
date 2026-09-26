// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {z} from 'zod';

/**
 * Values accepted by Tangram scene styles. Style values may be constants,
 * zoom-stop arrays, shader snippets, or renderer-specific objects.
 */
export const TangramStyleValueSchema = z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.unknown()),
    z.record(z.string(), z.unknown())
]);

/** Schema for a named Tangram source definition. */
export const TangramSourceSchema = z.object({
    type: z.string().optional(),
    url: z.string().optional(),
    urls: z.array(z.string()).optional(),
    decoder: z.string().optional(),
    tile_provider: z.string().optional(),
    parse_json: z.union([z.boolean(), z.array(z.string())]).optional(),
    tilejson: TangramStyleValueSchema.optional(),
    url_params: z.record(z.string(), TangramStyleValueSchema).optional(),
    min_zoom: z.number().finite().optional(),
    max_zoom: z.number().finite().optional(),
    tile_size: z.number().finite().positive().optional(),
    rasters: z.array(z.string()).optional(),
    scripts: TangramStyleValueSchema.optional(),
    transform: TangramStyleValueSchema.optional(),
    attribution: z.string().optional()
}).passthrough();

/** Schema for a named Tangram style definition. */
export const TangramStyleSchema = z.object({
    base: z.string().optional(),
    mix: z.union([z.string(), z.array(z.string())]).optional(),
    animated: z.boolean().optional(),
    lighting: z.union([z.boolean(), z.enum(['vertex', 'fragment'])]).optional(),
    blend: z.string().optional(),
    raster: z.union([z.boolean(), z.enum(['color', 'normal', 'custom'])]).optional(),
    texture: TangramStyleValueSchema.optional(),
    draw: z.record(z.string(), TangramStyleValueSchema).optional(),
    shaders: z.record(z.string(), TangramStyleValueSchema).optional()
}).passthrough();

/** Schema for a layer data reference. */
export const TangramLayerDataSchema = z.object({
    source: z.string().optional(),
    layer: z.string().optional(),
    geometry: z.string().optional()
}).passthrough();

/** Schema for a named Tangram layer definition. */
export const TangramLayerSchema = z.object({
    data: TangramLayerDataSchema.optional(),
    filter: TangramStyleValueSchema.optional(),
    draw: z.record(z.string(), TangramStyleValueSchema).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().finite().optional()
}).passthrough();

/** Schema for a Tangram scene style sheet. */
export const TangramStyleSheetSchema = z.object({
    import: z.union([
        z.string(),
        z.array(z.union([
            z.string(),
            z.record(z.string(), TangramStyleValueSchema)
        ])),
        z.record(z.string(), TangramStyleValueSchema)
    ]).optional(),
    global: z.record(z.string(), TangramStyleValueSchema).optional(),
    cameras: z.record(z.string(), z.record(z.string(), TangramStyleValueSchema)).optional(),
    scene: z.record(z.string(), TangramStyleValueSchema).optional(),
    lights: z.record(z.string(), z.record(z.string(), TangramStyleValueSchema)).optional(),
    fonts: z.record(z.string(), TangramStyleValueSchema).optional(),
    textures: z.record(z.string(), TangramStyleValueSchema).optional(),
    styles: z.record(z.string(), TangramStyleSchema).optional(),
    sources: z.record(z.string(), TangramSourceSchema).optional(),
    layers: z.record(z.string(), TangramLayerSchema).optional()
}).passthrough();
