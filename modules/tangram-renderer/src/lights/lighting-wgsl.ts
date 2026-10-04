// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {MAX_PORTABLE_LIGHTS} from './lighting-uniforms';

/** Specialize Tangram's constant-material equations to the bounded active scene light count. */
export function buildLightingWGSL(lightCount = MAX_PORTABLE_LIGHTS): string {
    if (!Number.isInteger(lightCount) || lightCount < 0 || lightCount > MAX_PORTABLE_LIGHTS) {
        throw new Error(`Portable lighting supports 0 to ${MAX_PORTABLE_LIGHTS} visible lights`);
    }
    return `
struct TangramSurfaceLight {
    ambient: vec4<f32>, diffuse: vec4<f32>, specular: vec4<f32>,
    position: vec4<f32>, direction: vec4<f32>, falloff: vec4<f32>,
    cone: vec4<f32>, coefficients: vec4<f32>,
};
fn tangramSurfaceLight(index: i32) -> TangramSurfaceLight {
    switch index {
${Array.from({length: lightCount}, (_, index) => `
        case ${index}: { return TangramSurfaceLight(${['ambient', 'diffuse', 'specular', 'position', 'direction', 'falloff', 'cone', 'coefficients'].map(field => `TangramLighting.u_light_${index}_${field}`).join(', ')}); }`).join('')}
        default: { return TangramSurfaceLight(vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0), vec4<f32>(0.0)); }
    }
}
fn tangramDistanceFalloff(distance: f32, light: TangramSurfaceLight) -> f32 {
    let exponent = light.falloff.x;
    let inner = light.falloff.y;
    let outer = light.falloff.z;
    var attenuation = 1.0;
    if (exponent != 0.0) {
        let radius = select(1.0, inner, inner >= 0.0);
        if (outer >= 0.0) {
            let d = clamp(max(0.0, distance - radius) / max(outer - radius, 0.0001), 0.0, 1.0);
            attenuation = 1.0 - pow(d, exponent);
        } else {
            let d = max(0.0, distance - radius) / max(radius, 0.0001) + 1.0;
            attenuation = clamp(1.0 / pow(d, exponent), 0.0, 1.0);
        }
    } else if (inner >= 0.0) {
        if (outer >= 0.0) {
            let d = clamp(max(0.0, distance - inner) / max(outer - inner, 0.0001), 0.0, 1.0);
            attenuation = 1.0 - d * d;
        } else {
            let d = max(0.0, distance - inner) / max(inner, 0.0001) + 1.0;
            attenuation = clamp(1.0 / d, 0.0, 1.0);
        }
    } else if (outer >= 0.0) {
        let d = clamp(distance / max(outer, 0.0001), 0.0, 1.0);
        attenuation = 1.0 - d * d;
    }
    if (light.coefficients.w > 0.5) {
        attenuation /= max(light.coefficients.x + light.coefficients.y * distance + light.coefficients.z * distance * distance, 0.0001);
    }
    return attenuation;
}
fn tangramCalculateLighting(eye_to_point: vec3<f32>, normal: vec3<f32>, base_color: vec4<f32>) -> vec4<f32> {
    var ambient = vec3<f32>(0.0);
    var diffuse = vec3<f32>(0.0);
    var specular = vec3<f32>(0.0);
    let eye_direction = eye_to_point / max(length(eye_to_point), 0.0001);
    for (var index = 0; index < ${lightCount}; index++) {
        if (index >= TangramLighting.u_light_count) { break; }
        let light = tangramSurfaceLight(index);
        let kind = i32(light.position.w);
        var direction = -light.direction.xyz;
        var attenuation = 1.0;
        if (kind >= 2) {
            let offset = light.position.xyz - eye_to_point;
            let distance = length(offset);
            direction = offset / max(distance, 0.0001);
            attenuation = tangramDistanceFalloff(distance, light);
            if (kind == 3) {
                let cosine = clamp(dot(-direction, light.direction.xyz), 0.0, 1.0);
                var cone_factor = select(0.0, pow(cosine, light.falloff.w), cosine >= light.cone.z);
                if (light.coefficients.w > 0.5) {
                    if (light.cone.x == light.cone.y) {
                        cone_factor = step(light.cone.y, cosine);
                    } else {
                        cone_factor = smoothstep(light.cone.y, light.cone.x, cosine);
                    }
                    cone_factor = max(cone_factor, 0.0001) * pow(cosine, light.falloff.w);
                }
                attenuation *= cone_factor;
            }
        }
        ambient += light.ambient.rgb * attenuation;
        if (kind > 0) {
            let lambert = clamp(dot(normal, direction), 0.0, 1.0);
            diffuse += light.diffuse.rgb * lambert * attenuation;
            if (lambert > 0.0 && TangramMaterial.u_material_flags.w != 0) {
                let reflected = reflect(-direction, normal);
                // Preserve Tangram's directional versus positional eye-vector convention.
                let eye = select(-eye_direction, eye_direction, kind == 1);
                let power = pow(max(dot(eye, reflected), 0.0), TangramMaterial.u_material_shininess);
                specular += light.specular.rgb * power * attenuation;
            }
        }
    }
    var color = vec4<f32>(0.0, 0.0, 0.0, base_color.a);
    let flags = TangramMaterial.u_material_flags;
    if (flags.x != 0) {
        color = vec4<f32>(TangramMaterial.u_material_emission.rgb, color.a * TangramMaterial.u_material_emission.a);
    }
    if (flags.y != 0) {
        color = vec4<f32>(color.rgb + ambient * base_color.rgb * TangramMaterial.u_material_ambient.rgb, color.a * TangramMaterial.u_material_ambient.a);
    } else if (flags.z != 0) {
        color = vec4<f32>(color.rgb + ambient * base_color.rgb * TangramMaterial.u_material_diffuse.rgb, color.a);
    }
    if (flags.z != 0) {
        color = vec4<f32>(color.rgb + diffuse * base_color.rgb * TangramMaterial.u_material_diffuse.rgb, color.a * TangramMaterial.u_material_diffuse.a);
    }
    if (flags.w != 0) {
        color = vec4<f32>(color.rgb + specular * TangramMaterial.u_material_specular.rgb, color.a * TangramMaterial.u_material_specular.a);
    }
    return clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));
}
`;
}
