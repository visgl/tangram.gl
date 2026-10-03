// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TangramLightMapping} from './light-definitions';

/** Bounded portable scene-light capacity; oversized scenes fail instead of truncating. */
export const MAX_PORTABLE_LIGHTS = 16;

/** Fixed layout shared by all configured WGSL surface styles and every render eye. */
export const PORTABLE_LIGHT_UNIFORMS: Record<string, string> = {u_light_count: 'int'};
for (let index = 0; index < MAX_PORTABLE_LIGHTS; index++) {
    for (const field of ['ambient', 'diffuse', 'specular', 'position', 'direction', 'falloff', 'cone', 'coefficients']) {
        PORTABLE_LIGHT_UNIFORMS[`u_light_${index}_${field}`] = 'vec4';
    }
}

/** Fixed untextured material layout, stored separately for each surface style. */
export const PORTABLE_MATERIAL_UNIFORMS = {
    u_material_emission: 'vec4', u_material_ambient: 'vec4', u_material_diffuse: 'vec4',
    u_material_specular: 'vec4', u_material_flags: 'ivec4', u_material_shininess: 'float'
};

/** A resolved constant Material contribution; textures remain a separate WGSL migration. */
interface MaterialContribution {
    /** Resolved RGBA multiplier. */
    amount?: ArrayLike<number>;
    /** Texture presence is rejected rather than silently approximated. */
    texture?: unknown;
    /** Resolved specular exponent. */
    shininess?: number;
}

/** Minimal material surface consumed by the portable lighting adapter. */
export interface PortableMaterial {
    /** Constant emitted color. */
    emission?: MaterialContribution;
    /** Independent ambient response. */
    ambient?: MaterialContribution;
    /** Diffuse response, also the ambient fallback when ambient is absent. */
    diffuse?: MaterialContribution;
    /** Untinted specular response. */
    specular?: MaterialContribution;
    /** Tangent-space normal maps are not yet implemented. */
    normal?: unknown;
}

/** Pack detached, active-eye light snapshots without mixing legacy and native falloff. */
export function getPortableLightUniforms(lights: readonly TangramLightMapping[]): Record<string, number | number[]> {
    if (lights.length > MAX_PORTABLE_LIGHTS) throw new Error(`Portable lighting supports at most ${MAX_PORTABLE_LIGHTS} visible lights`);
    const uniforms: Record<string, number | number[]> = {u_light_count: lights.length};
    lights.forEach(({light, tangram}, index) => {
        const prefix = `u_light_${index}_`;
        const positional = light.type === 'point' || light.type === 'spot';
        uniforms[`${prefix}ambient`] = [...tangram.ambient, 0];
        uniforms[`${prefix}diffuse`] = [...tangram.diffuse, 0];
        uniforms[`${prefix}specular`] = [...tangram.specular, 0];
        uniforms[`${prefix}position`] = [...(tangram.position ?? [0, 0, 0]), light.type === 'ambient' ? 0 : light.type === 'directional' ? 1 : light.type === 'point' ? 2 : 3];
        uniforms[`${prefix}direction`] = [...(tangram.direction ?? [0, 0, -1]), 0];
        uniforms[`${prefix}falloff`] = [tangram.attenuation ?? 0, tangram.radius?.[0] ?? -1, tangram.radius?.[1] ?? -1, tangram.exponent ?? 0];
        // Standard descriptors from legacy mappings have no coefficients/cones;
        // only native descriptors carry them, keeping the two equations distinct.
        const native = positional && light.attenuation != null;
        uniforms[`${prefix}coefficients`] = positional ? [...(light.attenuation ?? [1, 0, 0]), native ? 1 : 0] : [1, 0, 0, 0];
        uniforms[`${prefix}cone`] = light.type === 'spot' ? [Math.cos(light.innerConeAngle ?? 0), Math.cos(light.outerConeAngle ?? Math.PI / 4), Math.cos((tangram.angle ?? 20) * 3.14159 / 180), 0] : [1, 0, 0, 0];
    });
    return uniforms;
}

/** Reject unsupported texture/normal mappings and pack Tangram's constant material semantics. */
export function getPortableMaterialUniforms(material: PortableMaterial): Record<string, number | number[]> {
    const fields = ['emission', 'ambient', 'diffuse', 'specular'] as const;
    if (material.normal || fields.some(field => material[field]?.texture != null)) {
        throw new Error('Configured WGSL lighting currently requires constant materials; material textures and normal maps are not supported');
    }
    const uniforms: Record<string, number | number[]> = {u_material_flags: fields.map(field => material[field] ? 1 : 0),
        u_material_shininess: material.specular?.shininess ?? 0.2};
    for (const field of fields) uniforms[`u_material_${field}`] = Array.from(material[field]?.amount ?? [0, 0, 0, 1]);
    return uniforms;
}
