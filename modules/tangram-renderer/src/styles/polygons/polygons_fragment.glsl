// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

uniform vec2 u_resolution;
uniform float u_time;
uniform vec3 u_map_position;
uniform vec4 u_tile_origin;
uniform float u_meters_per_pixel;
uniform float u_device_pixel_ratio;
uniform mat3 u_normalMatrix;
uniform mat3 u_inverseNormalMatrix;
#ifndef TANGRAM_UNIFORM_BLOCK_TANGRAMVIEW
uniform highp int u_projection_mode;
#endif

varying vec4 v_position;
varying vec3 v_normal;
varying vec4 v_color;
varying vec4 v_world_position;
varying vec2 v_tile_position;
uniform vec4 u_tile_clip_bounds;

#ifdef TANGRAM_EXTRUDE_LINES
    uniform bool u_has_line_texture;
    uniform sampler2D u_texture;
    uniform float u_texture_ratio;
    uniform vec4 u_dash_background_color;
    uniform float u_has_dash;
#endif

#define TANGRAM_NORMAL v_normal

#if defined(TANGRAM_TEXTURE_COORDS) || defined(TANGRAM_EXTRUDE_LINES)
    varying vec2 v_texcoord;
#endif

#ifdef TANGRAM_MODEL_POSITION_BASE_ZOOM_VARYING
    varying vec4 v_modelpos_base_zoom;
#endif

#if defined(TANGRAM_LIGHTING_VERTEX)
    varying vec4 v_lighting;
#endif

#pragma tangram: attributes
#pragma tangram: camera
#pragma tangram: material
#pragma tangram: lighting
#pragma tangram: raster
#pragma tangram: global

void main (void) {
    if (u_tile_clip_bounds.z > u_tile_clip_bounds.x &&
        (any(lessThan(v_tile_position, u_tile_clip_bounds.xy)) ||
         any(greaterThanEqual(v_tile_position, u_tile_clip_bounds.zw)))) discard;
    // Initialize globals
    #pragma tangram: setup

    vec4 color = v_color;
    // Interpolated radial/tangent normals are not unit length between vertices.
    vec3 normal = u_projection_mode == 1 ? normalize(TANGRAM_NORMAL) : TANGRAM_NORMAL;

    // Apply raster to vertex color
    #ifdef TANGRAM_RASTER_TEXTURE_COLOR
        vec4 _raster_color = sampleRaster(0);

        #if defined(TANGRAM_BLEND_OPAQUE) || defined(TANGRAM_BLEND_TRANSLUCENT) || defined(TANGRAM_BLEND_MULTIPLY)
            // Raster sources can optionally mask by the alpha channel, which will render with only full or no alpha.
            // This is used for handling transparency outside the raster image in some blend modes,
            // which either don't support alpha, or would cause transparent pixels to write to the depth buffer,
            // obscuring geometry underneath.
            #ifdef TANGRAM_HAS_MASKED_RASTERS   // skip masking logic if no masked raster sources
            #ifndef TANGRAM_ALL_MASKED_RASTERS  // skip source check for masking if *all* raster sources are masked
            if (u_raster_mask_alpha) {
            #else
            {
            #endif
                #if defined(TANGRAM_BLEND_TRANSLUCENT) || defined(TANGRAM_BLEND_MULTIPLY)
                if (_raster_color.a < TANGRAM_EPSILON) {
                    discard;
                }
                #else // TANGRAM_BLEND_OPAQUE
                if (_raster_color.a < 1. - TANGRAM_EPSILON) {
                    discard;
                }
                // only allow full alpha in opaque blend mode (avoids artifacts blending w/canvas tile background)
                _raster_color.a = 1.;
                #endif
            }
            #endif
        #endif

        color *= _raster_color; // multiplied to tint texture color
    #endif

    // Apply line texture
    #ifdef TANGRAM_EXTRUDE_LINES
    { // enclose in scope to avoid leakage of internal variables
        if (u_has_line_texture) {
            vec2 _line_st = vec2(v_texcoord.x, fract(v_texcoord.y / u_texture_ratio));
            vec4 _line_color = texture2D(u_texture, _line_st);

            // If the line has a dash pattern, the line texture indicates if the current fragment should be
            // the dash foreground or background color. If the line doesn't have a dash pattern,
            // the line texture color is used directly (but also tinted by the vertex color).
            color = mix(
                color * _line_color, // no dash: tint the line texture with the vertex color
                mix(u_dash_background_color, color, _line_color.a), // choose dash foreground or background color
                u_has_dash // 0 if no dash, 1 if has dash
            );

            // Use alpha discard test as a lower-quality substitute for blending
            #if defined(TANGRAM_BLEND_OPAQUE)
                if (color.a < TANGRAM_ALPHA_TEST) {
                    discard;
                }
            #endif
        }
    }
    #endif

    #ifdef TANGRAM_PROJECTED_TRAFFIC
        float direction = v_texcoord.x < .5 ? 1. : -1.;
        float phase = direction > 0. ? 2.75 : 0.;
        float coordinate = v_texcoord.y * .125 - u_time * 1.8 * direction + phase;
        float vehicle_position = fract(coordinate / 6.);
        float derivative = max(fwidth(vehicle_position), .001);
        float half_length = max(.022, derivative * 1.35);
        float distance = abs(vehicle_position - .5);
        float body = 1. - smoothstep(half_length, half_length + derivative, distance);
        float halo = 1. - smoothstep(half_length + derivative, half_length + derivative * 2.5, distance);
        float lane_center = direction > 0. ? .28 : .72;
        float lane_derivative = max(fwidth(v_texcoord.x), .01);
        float half_width = clamp(lane_derivative * .45, .10, .22);
        float lane_edge = clamp(lane_derivative * .35, .02, .18);
        float lane = 1. - smoothstep(half_width, half_width + lane_edge, abs(v_texcoord.x - lane_center));
        color.rgb = mix(color.rgb, vec3(.62, 1., .98), max(body, halo * .35) * lane * .98);
    #endif

    // First, get normal from raster tile (if applicable)
    #ifdef TANGRAM_RASTER_TEXTURE_NORMAL
        normal = normalize(sampleRaster(0).rgb * 2. - 1.);
    #endif

    // Second, alter normal with normal map texture (if applicable)
    #if defined(TANGRAM_LIGHTING_FRAGMENT) && defined(TANGRAM_MATERIAL_NORMAL_TEXTURE)
        calculateNormal(normal);
    #endif

    // Normal modification applied here for fragment lighting or no lighting,
    // and in vertex shader for vertex lighting
    #if !defined(TANGRAM_LIGHTING_VERTEX)
        #pragma tangram: normal
    #endif

    // Color modification before lighting is applied
    #pragma tangram: color

    #if defined(TANGRAM_LIGHTING_FRAGMENT)
        // Calculate per-fragment lighting
        color = calculateLighting(v_position.xyz - u_eye, normal, color);
    #elif defined(TANGRAM_LIGHTING_VERTEX)
        // Apply lighting intensity interpolated from vertex shader
        color *= v_lighting;
    #endif

    // Post-processing effects (modify color after lighting)
    #pragma tangram: filter

    gl_FragColor = color;
}
