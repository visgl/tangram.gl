// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import ShaderProgram from '../gl/shader_program';
import GLSL from '../gl/glsl';
import Geo from '../utils/geo';
import StyleParser from '../styles/style_parser';
import {Vector3} from '@math.gl/core';
import {convertLumaLight, mapTangramLight} from './light-definitions';
import type {TangramLight, TangramLightColor, TangramLightMapping, ResolvedTangramLight, NormalizedTangramLight} from './light-definitions';
import {projectGeographicLight, projectGeographicDirection} from './geographic-lights';

import ambient_source from './ambient_light.glsl';
import directional_source from './directional_light.glsl';
import point_source from './point_light.glsl';
import spot_source from './spot_light.glsl';
import {buildNativeFalloff} from './native-falloff';

/** Legacy distance scalar, interpreted in meters unless explicitly suffixed with px. */
type LightDistance = number | string;
/** Position authored with legacy meter/pixel components. */
type LightPosition = readonly [LightDistance, LightDistance, LightDistance];
/** Radius pair after the constructor has expanded a scalar outer radius. */
type LightRadius = readonly [LightDistance | null, LightDistance];
/** Native optional fields, absent rather than fabricated for non-positional lights. */
type NativeLightFields = {
    /** Optional coordinate interpretation on positional descriptors. */
    positionSpace?: 'common' | 'geographic';
    /** Optional orientation frame on geographic spots. */
    directionSpace?: 'common' | 'enu';
};
/** Minimum per-eye view data consumed by lighting, independent of scene/deck classes. */
export interface LightView {
    /** Style zoom used by legacy pixel-distance conversion. */
    zoom: number;
    /** Active projection, if the host supplies one. */
    projection?: {type: string};
    /** Longitude used to select the nearest planar world copy. */
    center?: {lng: number};
    /** Active camera transform and eye origin. */
    camera: {
        /** Hosted cameras bind the full eye origin rather than only altitude. */
        type?: string;
        /** Column-major common-to-eye transform. */
        view_matrix: ArrayLike<number>;
        /** Eye origin in Tangram lighting coordinates. */
        position_meters: ArrayLike<number>;
        /** Optional projection-aware transform for incoming directions. */
        transformVector?: (vector: number[]) => number[];
    };
}
/** Authored legacy light or the normalized configuration of a native luma light. */
export interface LightConfig {
    /** Shader-safe instance name provided by scene normalization. */
    name: string;
    /** Legacy type discriminator; native inputs obtain it during conversion. */
    type?: string;
    /** Native luma descriptor before conversion. */
    luma?: TangramLight;
    /** Detached descriptor after conversion. */
    lumaLight?: NormalizedTangramLight & NativeLightFields;
    /** Independent ambient contribution. */
    ambient?: TangramLightColor;
    /** Independent diffuse contribution. */
    diffuse?: TangramLightColor;
    /** Independent specular contribution. */
    specular?: TangramLightColor;
    /** Legacy world/ground/camera interpretation or native projected coordinates. */
    origin?: 'world' | 'ground' | 'camera' | 'luma';
    /** Legacy unit-bearing or native numeric position. */
    position?: LightPosition;
    /** Incoming direction; legacy numeric strings are accepted. */
    direction?: readonly (number | string)[];
    /** Legacy falloff exponent, not native polynomial coefficients. */
    attenuation?: number | string;
    /** Optional inner/outer radius controls. */
    radius?: LightDistance | LightRadius;
    /** Legacy cutoff in degrees. */
    angle?: number | string;
    /** Legacy cosine falloff exponent. */
    exponent?: number | string;
}
/** Structural shader program boundary used by both GPU backends. */
export interface LightUniformProgram {
    /** Set a named scalar or vector uniform, preserving legacy GL setter names. */
    uniform(method: string, name: string, value: number | readonly number[] | undefined): void;
}
/** Optional subclass data inspected by the shared descriptor mapper. */
type LightShadingFields = {
    direction?: readonly number[];
    position_eye?: number[];
    attenuation?: number;
    radius?: LightRadius | null;
    angle?: number;
    exponent?: number | string;
};
/** Constructor/GLSL composer registry, retaining custom registered light types. */
type LightConstructor = {new(view: LightView, config: LightConfig): Light; inject(): void};
// parseFloat already coerces numeric inputs at runtime; describe that existing JS boundary.
type LightFloatParser = (value: number | string | undefined) => number;

/** Shared contribution parsing and shader composition for registered light kinds. */
export default class Light {

    /** Short-name constructor registry populated below. */
    declare static types: Record<string, LightConstructor>;
    /** Lighting shader block name. */
    declare static block: string;
    /** Global lighting switch used by live editing. */
    declare static enabled: boolean;
    /** Instance uniform name. */
    declare name: string;
    /** Active per-eye camera and style zoom. */
    declare view: LightView;
    /** Native source descriptor, absent for legacy lights. */
    declare lumaLight: (NormalizedTangramLight & NativeLightFields) | undefined;
    /** Parsed ambient contribution vector. */
    declare ambient: number[];
    /** Parsed diffuse contribution vector. */
    declare diffuse: number[];
    /** Parsed specular contribution vector. */
    declare specular: number[];
    /** Subclass shader discriminator. */
    declare type: ResolvedTangramLight['type'];
    /** Corresponding GLSL struct name. */
    declare struct_name: string;

    /** Resolve contribution colors without allocating scene or GPU resources. */
    constructor (view: LightView, config: LightConfig) {
        this.name = config.name;
        this.view = view;
        this.lumaLight = config.lumaLight;

        if (config.ambient == null || typeof config.ambient === 'number') {
            this.ambient = GLSL.expandVec3(config.ambient || 0)!;
        }
        else {
            this.ambient = StyleParser.parseColor(config.ambient).slice(0, 3);
        }

        if (config.diffuse == null || typeof config.diffuse === 'number') {
            this.diffuse = GLSL.expandVec3(config.diffuse != null ? config.diffuse : 1)!;
        }
        else {
            this.diffuse = StyleParser.parseColor(config.diffuse).slice(0, 3);
        }

        if (config.specular == null || typeof config.specular === 'number') {
            this.specular = GLSL.expandVec3(config.specular || 0)!;
        }
        else {
            this.specular = StyleParser.parseColor(config.specular).slice(0, 3);
        }
    }

    // Create a light by type name, factory-style
    // 'config' must include 'name' and 'type', along with any other type-specific properties
    /** Known built-in definitions create a light; unknown registered names remain optional. */
    static create(view: LightView, config: LightConfig & ({type: ResolvedTangramLight['type']} | {luma: TangramLight})): Light & LightShadingFields;
    static create(view: LightView, config: LightConfig): Light | undefined;
    static create (view: LightView, config: LightConfig) {
        if ('luma' in config) {
            config = {...config, ...convertLumaLight(config.luma)};
        }
        if (Light.types[config.type!]) {
            return new Light.types[config.type!](view, config);
        }
    }

    // Set light for a style: fragment lighting, vertex lighting, or none
    /** Select vertex/fragment lighting, retaining the global disable override. */
    static setMode (mode: boolean | string | null | undefined, style: {defines: Record<string, unknown>}) {
        if (mode === true) {
            mode = 'fragment';
        }
        mode = Light.enabled && ((mode != null) ? mode : 'fragment'); // default to fragment lighting
        style.defines['TANGRAM_LIGHTING_FRAGMENT'] = (mode === 'fragment');
        style.defines['TANGRAM_LIGHTING_VERTEX'] = (mode === 'vertex');
    }

    // Inject all provided light definitions, and calculate cumulative light function
    /** Recompose the shader block in authored instance order. */
    static inject (lights?: Record<string, Light & LightShadingFields> | null) {
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
            let types: Record<string, boolean> = {};
            for (let light_name in lights) {
                types[lights[light_name].type] = true;
            }

            // Native falloff is shared across point/spot structs without replacing Tangram materials.
            if (types.point || types.spotlight) ShaderProgram.addBlock(Light.block, buildNativeFalloff('glsl'));

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
    /** Inject this instance's uniforms and setup assignment. */
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
    /** Refresh eye-relative state; ambient/directional lights have no position to refresh. */
    update () {
    }

    /** Return a detached luma.gl descriptor and the exact resolved Tangram shading extensions. */
    toLumaLight(this: Light & LightShadingFields): TangramLightMapping {
        this.update();
        const direction = this.getLightingDirection();
        const mapping = mapTangramLight({
            type: this.type,
            ambient: this.ambient, diffuse: this.diffuse, specular: this.specular,
            ...(this.position_eye ? {position: this.position_eye.slice(0, 3) as [number, number, number]} : {}),
            ...(direction ? {direction: direction as [number, number, number]} : {}),
            ...(this.attenuation != null ? {attenuation: this.attenuation} : {}),
            ...(this.radius ? {radius: this.radius.map(value => value == null ? null :
                StyleParser.convertUnits(value, {zoom: this.view.zoom, meters_per_pixel: Geo.metersPerPixel(this.view.zoom)})) as [number | null, number]} : {}),
            ...(this.angle != null ? {angle: this.angle, exponent: this.exponent as number} : {})
        });
        if (this.lumaLight) {
            mapping.light = {...this.lumaLight,
                color: [...this.lumaLight.color] satisfies [number, number, number],
                ambient: [...mapping.tangram.ambient] satisfies [number, number, number],
                diffuse: [...mapping.tangram.diffuse] satisfies [number, number, number],
                specular: [...mapping.tangram.specular] satisfies [number, number, number],
                ...('position' in this.lumaLight ? {position: [...(mapping.light as {position: readonly [number, number, number]}).position] as [number, number, number],
                    attenuation: [...this.lumaLight.attenuation] satisfies [number, number, number],
                    ...(mapping.tangram.radius ? {radius: [...mapping.tangram.radius] satisfies [number | null, number]} : {})} : {}),
                ...('direction' in this.lumaLight ? {direction: [...direction!] as [number, number, number]} : {})};
        }
        return mapping;
    }

    /** Resolve native geographic spot orientation before applying the active eye's camera. */
    getLightingDirection(this: Light & LightShadingFields): readonly number[] | undefined {
        let direction = this.direction;
        if (this.lumaLight?.positionSpace === 'geographic' && this.lumaLight.directionSpace !== 'common' && direction) {
            direction = projectGeographicDirection((this.lumaLight as Extract<NormalizedTangramLight, {type: 'point' | 'spot'}>).position, direction as [number, number, number], this.view.projection?.type === 'globe');
        }
        return direction && (this.type === 'directional' || this.lumaLight) && typeof this.view.camera?.transformVector === 'function'
            ? this.view.camera.transformVector(direction as number[]) : direction;
    }

    // Called once per frame per program (e.g. for main render pass, then for each additional
    // pass for feature selection, etc.)
    /** Bind resolved contribution vectors to the active program. */
    setupProgram (_program: LightUniformProgram) {
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

    constructor(view: LightView, config: LightConfig) {
        super(view, config);
        this.type = 'ambient';
        this.struct_name = 'AmbientLight';
    }

    // Inject struct and calculate function
    static inject() {
        ShaderProgram.addBlock(Light.block, ambient_source);
    }

    setupProgram (_program: LightUniformProgram) {
        _program.uniform('3fv', `u_${this.name}.ambient`, this.ambient);
    }

}
Light.types['ambient'] = AmbientLight;

class DirectionalLight extends Light {
    /** Normalized incoming direction, retaining legacy string coercion during construction. */
    declare _direction: readonly (number | string)[];

    constructor(view: LightView, config: LightConfig) {
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
                this.ambient = GLSL.expandVec3(0.5)!;
            }
        }
        this.direction = this._direction.map(parseFloat as LightFloatParser);
    }

    get direction (): readonly number[] {
        return this._direction as readonly number[];
    }

    set direction (v: readonly number[]) {
        this._direction = new Vector3(v).normalize().toArray() as number[];
    }

    // Inject struct and calculate function
    static inject() {
        ShaderProgram.addBlock(Light.block, directional_source);
    }

    setupProgram (_program: LightUniformProgram) {
        super.setupProgram(_program);
        const direction = this.getLightingDirection();
        _program.uniform('3fv', `u_${this.name}.direction`, direction);
    }

}
Light.types['directional'] = DirectionalLight;


class PointLight extends Light {
    /** Positional native descriptors are validated before reaching this constructor. */
    declare lumaLight: Extract<NormalizedTangramLight, {type: 'point' | 'spot'}> | undefined;
    /** Authored unit-bearing position. */
    declare position: LightPosition;
    /** Eye-relative homogeneous position, updated before binding. */
    declare position_eye: number[];
    /** Coordinate interpretation retained from the scene. */
    declare origin: NonNullable<LightConfig['origin']>;
    /** Legacy falloff exponent. */
    declare attenuation: number;
    /** Optional inner/outer unit-bearing radii. */
    declare radius: LightRadius | null;

    constructor (view: LightView, config: LightConfig) {
        super(view, config);
        this.type = 'point';
        this.struct_name = 'PointLight';

        this.position = config.position || [0, 0, '100px'];
        this.position_eye = []; // position in eyespace
        this.origin = config.origin || 'ground';
        this.attenuation = !isNaN((parseFloat as LightFloatParser)(config.attenuation)) ? (parseFloat as LightFloatParser)(config.attenuation) : 0;

        if (config.radius) {
            if (Array.isArray(config.radius) && config.radius.length === 2) {
                this.radius = config.radius as LightRadius;
            }
            else {
                this.radius = [null, config.radius as LightDistance];
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
            const position = this.lumaLight?.positionSpace === 'geographic'
                ? projectGeographicLight(this.position as [number, number, number], this.view.projection?.type === 'globe', this.view.center?.lng)
                : this.position as [number, number, number];
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
            const m = Geo.latLngToMeters([...this.position] as number[]);
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

    setupProgram (_program: LightUniformProgram) {
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
    /** Only native spot definitions can reach this registered constructor. */
    declare lumaLight: Extract<NormalizedTangramLight, {type: 'spot'}> | undefined;
    /** Parsed and normalized incoming direction. */
    declare _direction: number[];
    /** Legacy cosine falloff exponent. */
    declare exponent: number | string;
    /** Legacy cutoff in degrees. */
    declare angle: number;

    constructor (view: LightView, config: LightConfig) {
        super(view, config);
        this.type = 'spotlight';
        this.struct_name = 'SpotLight';

        this.direction = this._direction = (config.direction || [0, 0, -1]).map(parseFloat as LightFloatParser); // [x, y, z]
        this.exponent = this.lumaLight ? config.exponent ?? 0 : config.exponent ? (parseFloat as LightFloatParser)(config.exponent) : 0.2;
        this.angle = config.angle ? (parseFloat as LightFloatParser)(config.angle) : 20;
    }

    get direction () {
        return this._direction;
    }

    set direction (v: readonly number[]) {
        this._direction = new Vector3(v).normalize().toArray() as number[];
    }

    // Inject struct and calculate function
    static inject () {
        ShaderProgram.addBlock(Light.block, spot_source);
    }

    setupProgram (_program: LightUniformProgram) {
        super.setupProgram(_program);

        const direction = this.getLightingDirection();
        _program.uniform('3fv', `u_${this.name}.direction`, direction);
        _program.uniform('1f', `u_${this.name}.spotCosCutoff`, Math.cos(this.angle * 3.14159 / 180));
        _program.uniform('1f', `u_${this.name}.spotExponent`, this.exponent as number);
        _program.uniform('2fv', `u_${this.name}.lumaConeCos`, this.lumaLight ?
            [Math.cos(this.lumaLight.innerConeAngle), Math.cos(this.lumaLight.outerConeAngle)] : [1, 0]);
    }

}
Light.types['spotlight'] = SpotLight;
