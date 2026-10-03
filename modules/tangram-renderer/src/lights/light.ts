// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// @ts-nocheck

import ShaderProgram from '../gl/shader_program';
import GLSL from '../gl/glsl';
import Geo from '../utils/geo';
import StyleParser from '../styles/style_parser';
import {Vector3} from '@math.gl/core';
import {convertLumaLight, mapTangramLight} from './light-definitions';

import ambient_source from './ambient_light.glsl';
import directional_source from './directional_light.glsl';
import point_source from './point_light.glsl';
import spot_source from './spot_light.glsl';

// Abstract light
export default class Light {

    constructor (view, config) {
        this.name = config.name;
        this.view = view;
        this.lumaLight = config.lumaLight;

        if (config.ambient == null || typeof config.ambient === 'number') {
            this.ambient = GLSL.expandVec3(config.ambient || 0);
        }
        else {
            this.ambient = StyleParser.parseColor(config.ambient).slice(0, 3);
        }

        if (config.diffuse == null || typeof config.diffuse === 'number') {
            this.diffuse = GLSL.expandVec3(config.diffuse != null ? config.diffuse : 1);
        }
        else {
            this.diffuse = StyleParser.parseColor(config.diffuse).slice(0, 3);
        }

        if (config.specular == null || typeof config.specular === 'number') {
            this.specular = GLSL.expandVec3(config.specular || 0);
        }
        else {
            this.specular = StyleParser.parseColor(config.specular).slice(0, 3);
        }
    }

    // Create a light by type name, factory-style
    // 'config' must include 'name' and 'type', along with any other type-specific properties
    static create (view, config) {
        if ('luma' in config) {
            config = {...config, ...convertLumaLight(config.luma)};
        }
        if (Light.types[config.type]) {
            return new Light.types[config.type](view, config);
        }
    }

    // Set light for a style: fragment lighting, vertex lighting, or none
    static setMode (mode, style) {
        if (mode === true) {
            mode = 'fragment';
        }
        mode = Light.enabled && ((mode != null) ? mode : 'fragment'); // default to fragment lighting
        style.defines['TANGRAM_LIGHTING_FRAGMENT'] = (mode === 'fragment');
        style.defines['TANGRAM_LIGHTING_VERTEX'] = (mode === 'vertex');
    }

    // Inject all provided light definitions, and calculate cumulative light function
    static inject (lights) {
        // Clear previous injections
        ShaderProgram.removeBlock(Light.block);

        // If lighting is globally disabled, nothing is injected (mostly for debugging or live editing)
        if (!Light.enabled) {
            return;
        }

        // Construct code to calculate each light instance
        let calculateLights = '';
        if (lights && Object.keys(lights).length > 0) {
            // Collect uniques types of lights
            let types = {};
            for (let light_name in lights) {
                types[lights[light_name].type] = true;
            }

            // Inject each type of light
            for (let type in types) {
                Light.types[type].inject();
            }

            // Inject per-instance blocks and construct the list of functions to calculate each light
            for (let light_name in lights) {
                // Define instance
                lights[light_name].inject();

                // Add the calculation function to the list
                calculateLights += `calculateLight(${light_name}, _eyeToPoint, _normal);\n`;
            }
            // Keep aggregate defines for custom blocks; built-in falloff is selected per light.
            const points = Object.values(lights).filter(light => light.type === 'point' || light.type === 'spotlight');
            ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_EXPONENT'] = points.some(light => light.attenuation !== 0);
            ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_INNER_RADIUS'] = points.some(light => light.radius?.[0] != null);
            ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_OUTER_RADIUS'] = points.some(light => light.radius != null);
        }

        // Glue together the final lighting function that sums all the lights
        let calculateFunction = `
            vec4 calculateLighting(in vec3 _eyeToPoint, in vec3 _normal, in vec4 _color) {

                // Do initial material calculations over normal, emission, ambient, diffuse and specular values
                calculateMaterial(_eyeToPoint,_normal);

                // Un roll the loop of individual ligths to calculate
                ${calculateLights}

                //  Final light intensity calculation
                vec4 color = vec4(vec3(0.), _color.a); // start with vertex color alpha

                #ifdef TANGRAM_MATERIAL_EMISSION
                    color.rgb = material.emission.rgb;
                    color.a *= material.emission.a;
                #endif

                #ifdef TANGRAM_MATERIAL_AMBIENT
                    color.rgb += light_accumulator_ambient.rgb * _color.rgb * material.ambient.rgb;
                    color.a *= material.ambient.a;
                #else
                    #ifdef TANGRAM_MATERIAL_DIFFUSE
                        color.rgb += light_accumulator_ambient.rgb * _color.rgb * material.diffuse.rgb;
                    #endif
                #endif

                #ifdef TANGRAM_MATERIAL_DIFFUSE
                    color.rgb += light_accumulator_diffuse.rgb * _color.rgb * material.diffuse.rgb;
                    color.a *= material.diffuse.a;
                #endif

                #ifdef TANGRAM_MATERIAL_SPECULAR
                    color.rgb += light_accumulator_specular.rgb * material.specular.rgb;
                    color.a *= material.specular.a;
                #endif

                // Clamp final color
                color = clamp(color, 0.0, 1.0);

                return color;
            }`;

        ShaderProgram.addBlock(Light.block, calculateFunction);
    }

    // Common instance definition
    inject () {
        let instance =  `
            uniform ${this.struct_name} u_${this.name};
            ${this.struct_name} ${this.name};
            `;
        let assign = `
            ${this.name} = u_${this.name};\n
        `;

        ShaderProgram.addBlock(Light.block, instance);
        ShaderProgram.addBlock('setup', assign);
    }

    // Update method called once per frame
    update () {
    }

    /** Return a detached luma.gl descriptor and the exact resolved Tangram shading extensions. */
    toLumaLight() {
        this.update();
        const direction = this.direction && (this.type === 'directional' || this.lumaLight) && this.view.camera &&
            typeof this.view.camera.transformVector === 'function' ?
            this.view.camera.transformVector(this.direction) : this.direction;
        const mapping = mapTangramLight({
            type: this.type,
            ambient: this.ambient, diffuse: this.diffuse, specular: this.specular,
            ...(this.position_eye ? {position: this.position_eye.slice(0, 3)} : {}),
            ...(direction ? {direction} : {}),
            ...(this.attenuation != null ? {attenuation: this.attenuation} : {}),
            ...(this.radius ? {radius: this.radius.map(value => value == null ? null :
                StyleParser.convertUnits(value, {zoom: this.view.zoom, meters_per_pixel: Geo.metersPerPixel(this.view.zoom)}))} : {}),
            ...(this.angle != null ? {angle: this.angle, exponent: this.exponent} : {})
        });
        if (this.lumaLight) {
            mapping.light = {...this.lumaLight,
                color: [...this.lumaLight.color],
                ambient: [...mapping.tangram.ambient], diffuse: [...mapping.tangram.diffuse],
                specular: [...mapping.tangram.specular],
                ...('position' in this.lumaLight ? {position: [...mapping.light.position],
                    attenuation: [...this.lumaLight.attenuation],
                    ...(mapping.tangram.radius ? {radius: [...mapping.tangram.radius]} : {})} : {}),
                ...('direction' in this.lumaLight ? {direction: [...direction]} : {})};
        }
        return mapping;
    }

    // Called once per frame per program (e.g. for main render pass, then for each additional
    // pass for feature selection, etc.)
    setupProgram (_program) {
        //  Three common light properties
        _program.uniform('3fv', `u_${this.name}.ambient`, this.ambient);
        _program.uniform('3fv', `u_${this.name}.diffuse`, this.diffuse);
        _program.uniform('3fv', `u_${this.name}.specular`, this.specular);
    }

}

Light.types = {}; // references to subclasses by short name
Light.block = 'lighting'; // shader block name
Light.enabled = true; // lighting can be globally enabled/disabled


// Light subclasses
class AmbientLight extends Light {

    constructor(view, config) {
        super(view, config);
        this.type = 'ambient';
        this.struct_name = 'AmbientLight';
    }

    // Inject struct and calculate function
    static inject() {
        ShaderProgram.addBlock(Light.block, ambient_source);
    }

    setupProgram (_program) {
        _program.uniform('3fv', `u_${this.name}.ambient`, this.ambient);
    }

}
Light.types['ambient'] = AmbientLight;

class DirectionalLight extends Light {

    constructor(view, config) {
        super(view, config);
        this.type = 'directional';
        this.struct_name = 'DirectionalLight';

        if (config.direction) {
            this._direction = config.direction;
        }
        else {
            // Default directional light maintains full intensity on ground, with basic extrusion shading
            let theta = 135; // angle of light in xy plane (rotated around z axis)
            let scale = Math.sin(Math.PI*60/180); // scaling factor to keep total directional intensity to 0.5
            this._direction = [
                Math.cos(Math.PI*theta/180) * scale,
                Math.sin(Math.PI*theta/180) * scale,
                -0.5
            ];

            if (config.ambient == null) {
                this.ambient = GLSL.expandVec3(0.5);
            }
        }
        this.direction = this._direction.map(parseFloat);
    }

    get direction () {
        return this._direction;
    }

    set direction (v) {
        this._direction = new Vector3(v).normalize().toArray();
    }

    // Inject struct and calculate function
    static inject() {
        ShaderProgram.addBlock(Light.block, directional_source);
    }

    setupProgram (_program) {
        super.setupProgram(_program);
        const camera = this.view.camera;
        const direction = camera && typeof camera.transformVector === 'function' ?
            camera.transformVector(this.direction) : this.direction;
        _program.uniform('3fv', `u_${this.name}.direction`, direction);
    }

}
Light.types['directional'] = DirectionalLight;


class PointLight extends Light {

    constructor (view, config) {
        super(view, config);
        this.type = 'point';
        this.struct_name = 'PointLight';

        this.position = config.position || [0, 0, '100px'];
        this.position_eye = []; // position in eyespace
        this.origin = config.origin || 'ground';
        this.attenuation = !isNaN(parseFloat(config.attenuation)) ? parseFloat(config.attenuation) : 0;

        if (config.radius) {
            if (Array.isArray(config.radius) && config.radius.length === 2) {
                this.radius = config.radius;
            }
            else {
                this.radius = [null, config.radius];
            }
        }
        else {
            this.radius = null;
        }
    }

    // Inject struct and calculate function
    static inject () {
        ShaderProgram.addBlock(Light.block, point_source);
    }

    // Inject isntance-specific settings
    inject() {
        super.inject();

        ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_EXPONENT'] = (this.attenuation !== 0);
        ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_INNER_RADIUS'] = (this.radius != null && this.radius[0] != null);
        ShaderProgram.defines['TANGRAM_POINTLIGHT_ATTENUATION_OUTER_RADIUS'] = (this.radius != null);
    }

    update () {
        this.updateEyePosition();
    }

    updateEyePosition () {
        if (this.origin === 'luma') {
            // Native luma positions share the projected common space of geometry.
            const camera = this.view.camera;
            const position = this.position;
            const matrix = camera.view_matrix;
            const globe = this.view.projection?.type === 'globe';
            const projected = globe ? position : [
                matrix[0] * position[0] + matrix[4] * position[1] + matrix[8] * position[2] + matrix[12],
                matrix[1] * position[0] + matrix[5] * position[1] + matrix[9] * position[2] + matrix[13],
                matrix[2] * position[0] + matrix[6] * position[1] + matrix[10] * position[2] + matrix[14]
            ];
            // Standalone cameras bind only their height as u_eye; hosted cameras bind all components.
            const eye = camera.type === 'external' || globe ? camera.position_meters : [0, 0, camera.position_meters[2]];
            this.position_eye = projected.map((value, index) => value - eye[index]);
        }
        else if (this.origin === 'world') {
            // For world origin, format is: [longitude, latitude, meters (default) or pixels w/px units]

            // Move light's world position into camera space
            const m = Geo.latLngToMeters([...this.position]);
            this.position_eye[0] = m[0] - this.view.camera.position_meters[0];
            this.position_eye[1] = m[1] - this.view.camera.position_meters[1];

            this.position_eye[2] = StyleParser.convertUnits(this.position[2],
                { zoom: this.view.zoom, meters_per_pixel: Geo.metersPerPixel(this.view.zoom) });
            this.position_eye[2] = this.position_eye[2] - this.view.camera.position_meters[2];
        }
        else if (this.origin === 'ground' || this.origin === 'camera') {
            // For camera or ground origin, format is: [x, y, z] in meters (default) or pixels w/px units

            // Light is in camera space by default
            this.position_eye = StyleParser.convertUnits(this.position,
                { zoom: this.view.zoom, meters_per_pixel: Geo.metersPerPixel(this.view.zoom) });

            if (this.origin === 'ground') {
                // Leave light's xy in camera space, but z needs to be moved relative to ground plane
                this.position_eye[2] = this.position_eye[2] - this.view.camera.position_meters[2];
            }
        }
        this.position_eye[3] = 1;
    }

    setupProgram (_program) {
        super.setupProgram(_program);

        _program.uniform('4fv', `u_${this.name}.position`, this.position_eye);
        _program.uniform('1f', `u_${this.name}.useLumaAttenuation`, this.lumaLight ? 1 : 0);
        _program.uniform('3fv', `u_${this.name}.attenuationCoefficients`, this.lumaLight?.attenuation || [1, 0, 0]);

        _program.uniform('1f', `u_${this.name}.attenuationExponent`, this.attenuation);
        _program.uniform('1f', `u_${this.name}.innerRadius`, this.radius?.[0] == null ? -1 :
            StyleParser.convertUnits(this.radius[0], {zoom: this.view.zoom, meters_per_pixel: Geo.metersPerPixel(this.view.zoom)}));
        _program.uniform('1f', `u_${this.name}.outerRadius`, this.radius == null ? -1 :
            StyleParser.convertUnits(this.radius[1], {zoom: this.view.zoom, meters_per_pixel: Geo.metersPerPixel(this.view.zoom)}));
    }
}
Light.types['point'] = PointLight;


class SpotLight extends PointLight {

    constructor (view, config) {
        super(view, config);
        this.type = 'spotlight';
        this.struct_name = 'SpotLight';

        this.direction = this._direction = (config.direction || [0, 0, -1]).map(parseFloat); // [x, y, z]
        this.exponent = this.lumaLight ? config.exponent ?? 0 : config.exponent ? parseFloat(config.exponent) : 0.2;
        this.angle = config.angle ? parseFloat(config.angle) : 20;
    }

    get direction () {
        return this._direction;
    }

    set direction (v) {
        this._direction = new Vector3(v).normalize().toArray();
    }

    // Inject struct and calculate function
    static inject () {
        ShaderProgram.addBlock(Light.block, spot_source);
    }

    setupProgram (_program) {
        super.setupProgram(_program);

        const direction = this.lumaLight && typeof this.view.camera.transformVector === 'function' ?
            this.view.camera.transformVector(this.direction) : this.direction;
        _program.uniform('3fv', `u_${this.name}.direction`, direction);
        _program.uniform('1f', `u_${this.name}.spotCosCutoff`, Math.cos(this.angle * 3.14159 / 180));
        _program.uniform('1f', `u_${this.name}.spotExponent`, this.exponent);
        _program.uniform('2fv', `u_${this.name}.lumaConeCos`, this.lumaLight ?
            [Math.cos(this.lumaLight.innerConeAngle), Math.cos(this.lumaLight.outerConeAngle)] : [1, 0]);
    }

}
Light.types['spotlight'] = SpotLight;
