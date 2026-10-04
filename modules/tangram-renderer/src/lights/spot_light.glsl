// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

/*

Expected globals:
material
light_accumulator_*

*/

struct SpotLight {
    vec3 ambient;
    vec3 diffuse;
    vec3 specular;
    vec4 position;
    float useLumaAttenuation;
    vec3 attenuationCoefficients;

    float attenuationExponent;
    float innerRadius;
    float outerRadius;

    vec3 direction;
    float spotCosCutoff;
    float spotExponent;
    vec2 lumaConeCos;
};

void calculateLight(in SpotLight _light, in vec3 _eyeToPoint, in vec3 _normal) {

    float dist = length(_light.position.xyz - _eyeToPoint);

    // Compute vector from surface to light position
    vec3 VP = (_light.position.xyz - _eyeToPoint) / dist;

    // normal . light direction
    float nDotVP = clamp(dot(_normal, VP), 0.0, 1.0);

    // Attenuation defaults
    float attenuation = 1.0;
    if (_light.attenuationExponent != 0.0) {
        float Rin = _light.innerRadius >= 0.0 ? _light.innerRadius : 1.0;
        float e = _light.attenuationExponent;
        if (_light.outerRadius >= 0.0) {
            float Rdiff = _light.outerRadius-Rin;
            float d = clamp(max(0.0,dist-Rin)/Rdiff, 0.0, 1.0);
            attenuation = 1.0-(pow(d,e));
        } else {
            // If no outer is provide behaves like:
            // https://imdoingitwrong.wordpress.com/2011/01/31/light-attenuation/
            float d = max(0.0,dist-Rin)/Rin+1.0;
            attenuation = clamp(1.0/(pow(d,e)), 0.0, 1.0);
        }
    } else {
        float Rin = max(_light.innerRadius, 0.0);
        if (_light.innerRadius >= 0.0) {
            if (_light.outerRadius >= 0.0) {
                float Rdiff = _light.outerRadius-Rin;
                float d = clamp(max(0.0,dist-Rin)/Rdiff, 0.0, 1.0);
                attenuation = 1.0-d*d;
            } else {
                // If no outer is provide behaves like:
                // https://imdoingitwrong.wordpress.com/2011/01/31/light-attenuation/
                float d = max(0.0,dist-Rin)/Rin+1.0;
                attenuation = clamp(1.0/d, 0.0, 1.0);
            }
        } else {
            if (_light.outerRadius >= 0.0) {
                float d = clamp(dist/_light.outerRadius, 0.0, 1.0);
                attenuation = 1.0-d*d;
            } else {
                attenuation = 1.0;
            }
        }
    }

    // spotlight attenuation factor
    float spotAttenuation = 0.0;

    // See if point on surface is inside cone of illumination
    float spotDot = clamp(dot(-VP, _light.direction), 0.0, 1.0);

    if (spotDot >= _light.spotCosCutoff) {
        spotAttenuation = pow(spotDot, _light.spotExponent);
    }
    if (_light.useLumaAttenuation > 0.5) {
        // Match luma.gl's minimum cone factor, including its small outside-cone contribution.
        attenuation /= tangramNativeDistanceDenominator(_light.attenuationCoefficients, dist);
        spotAttenuation = tangramNativeConeFactor(_light.lumaConeCos, spotDot) * pow(spotDot, _light.spotExponent);
    }

    light_accumulator_ambient.rgb += _light.ambient * attenuation * spotAttenuation;

    #ifdef TANGRAM_MATERIAL_DIFFUSE
        light_accumulator_diffuse.rgb += _light.diffuse * nDotVP * attenuation * spotAttenuation;
    #endif

    #ifdef TANGRAM_MATERIAL_SPECULAR
        // Power factor for shiny speculars
        float pf = 0.0;
        if (nDotVP > 0.0) {
            vec3 reflectVector = reflect(-VP, _normal);
            float eyeDotR = max(dot(-normalize(_eyeToPoint), reflectVector), 0.0);
            pf = pow(eyeDotR, material.shininess);
        }
        light_accumulator_specular.rgb += _light.specular * pf * attenuation * spotAttenuation;
    #endif
}
