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

/** Finite RGB, direction, position, or attenuation triples. */
const lightVectorSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const lightContributionSchema = z.union([z.number().finite(), z.string(), lightVectorSchema,
    z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])]);
const lightDistanceSchema = z.union([z.number().finite().nonnegative(), z.string()]);
const lumaLightCommon = {
    color: lightVectorSchema.optional().describe('Byte RGB light color (0–255); omitted means black'),
    intensity: z.number().finite().nonnegative().optional(),
    ambient: lightContributionSchema.optional().describe('Optional normalized Tangram ambient contribution'),
    diffuse: lightContributionSchema.optional().describe('Optional normalized Tangram diffuse contribution'),
    specular: lightContributionSchema.optional().describe('Optional normalized Tangram specular contribution'),
    visible: z.boolean().optional()
};
const lumaPositionalLight = {
    position: lightVectorSchema.describe('Projected world position, not longitude/latitude'),
    attenuation: lightVectorSchema.optional().describe('Constant, linear, quadratic distance coefficients'),
    attenuationExponent: z.number().finite().nonnegative().optional().describe('Additional Tangram exponent falloff'),
    radius: z.union([lightDistanceSchema, z.tuple([lightDistanceSchema.nullable(), lightDistanceSchema])]).optional(),
    origin: z.enum(['world', 'ground', 'camera']).optional().describe('Optional legacy position interpretation')
};

/** Native luma.gl light definitions accepted by the scene's light array. */
export const LumaLightSchema = z.discriminatedUnion('type', [
    z.object({type: z.literal('ambient'), ...lumaLightCommon}),
    z.object({type: z.literal('directional'), ...lumaLightCommon, direction: lightVectorSchema}),
    z.object({type: z.literal('point'), ...lumaLightCommon, ...lumaPositionalLight}),
    z.object({type: z.literal('spot'), ...lumaLightCommon, ...lumaPositionalLight, direction: lightVectorSchema,
        innerConeAngle: z.number().finite().min(0).max(Math.PI / 2).optional().describe('Radians'),
        outerConeAngle: z.number().finite().min(0).max(Math.PI / 2).optional().describe('Radians'),
        spotExponent: z.number().finite().nonnegative().optional().describe('Additional Tangram cone falloff')})
]);

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
    lights: z.union([
        z.record(z.string(), z.record(z.string(), TangramStyleValueSchema)),
        z.array(LumaLightSchema)
    ]).optional(),
    fonts: z.record(z.string(), TangramStyleValueSchema).optional(),
    textures: z.record(z.string(), TangramStyleValueSchema).optional(),
    styles: z.record(z.string(), TangramStyleSchema).optional(),
    sources: z.record(z.string(), TangramSourceSchema).optional(),
    layers: z.record(z.string(), TangramLayerSchema).optional()
}).passthrough();
