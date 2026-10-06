// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {
    AmbientLight, DirectionalLight, PointLight, SpotLight
} from '@luma.gl/shadertools';

/** An RGB contribution or position, copied at the adapter boundary. */
type Triple = readonly [number, number, number];

/** Tangram's normalized RGB/RGBA, CSS color, or scalar lighting contribution. */
export type TangramLightColor = number | string | Triple | readonly [number, number, number, number];

/** Optional Tangram shading controls layered on native luma.gl light definitions. */
export interface TangramLightExtensions {
    /** Independent normalized ambient contribution; defaults to the native light contribution. */
    ambient?: TangramLightColor;
    /** Independent normalized diffuse contribution; defaults to the native light contribution. */
    diffuse?: TangramLightColor;
    /** Independent normalized specular contribution; defaults to the native light contribution. */
    specular?: TangramLightColor;
    /** Suppress this light without removing its authored definition. */
    visible?: boolean;
}

/** Optional positional falloff and coordinate controls; native coefficients remain `attenuation`. */
export interface TangramPositionalLightExtensions extends TangramLightExtensions {
    /** Legacy exponent falloff, multiplied by the native polynomial attenuation. */
    attenuationExponent?: number;
    /** Legacy outer radius, or [inner, outer] radii, accepting Tangram meter/pixel units. */
    radius?: number | string | readonly [number | string | null, number | string];
    /** Optional legacy position interpretation; omitted means projected common-space coordinates. */
    origin?: 'world' | 'ground' | 'camera';
    /** Interpret native position as longitude/latitude/altitude rather than projected common coordinates. */
    positionSpace?: 'common' | 'geographic';
    /** Geographic spotlight orientation; defaults to ENU when positionSpace is geographic. */
    directionSpace?: 'common' | 'enu';
}

/** Native ambient light with optional independent Tangram color contributions. */
export type TangramAmbientLight = AmbientLight & TangramLightExtensions;
/** Native directional light with optional independent Tangram color contributions. */
export type TangramDirectionalLight = DirectionalLight & TangramLightExtensions;
/** Native point light with optional Tangram color, falloff, and coordinate controls. */
export type TangramPointLight = PointLight & TangramPositionalLightExtensions;
/** Native spotlight with optional Tangram falloff inside its native radian cone. */
export type TangramSpotLight = SpotLight & TangramPositionalLightExtensions & {
    /** Legacy cosine falloff exponent, multiplied by the native cone transition; defaults to zero. */
    spotExponent?: number;
};
/** Every native luma.gl Light is assignable; all Tangram additions are optional. */
export type TangramLight = TangramAmbientLight | TangramDirectionalLight | TangramPointLight | TangramSpotLight;

/** Native descriptors after defaults, vectors, attenuation and spot cones have been validated. */
export type NormalizedTangramLight = (
    Omit<TangramAmbientLight, 'color' | 'intensity'> | Omit<TangramDirectionalLight, 'color' | 'intensity'> |
    (Omit<TangramPointLight, 'color' | 'intensity' | 'attenuation'> & {attenuation: Triple}) |
    (Omit<TangramSpotLight, 'color' | 'intensity' | 'attenuation' | 'innerConeAngle' | 'outerConeAngle'> & {
        attenuation: Triple; innerConeAngle: number; outerConeAngle: number
    })
) & {color: Triple; intensity: number};

/** Resolved Tangram light values, after color, unit and camera conversion. */
export interface ResolvedTangramLight {
    /** Tangram's spotlight discriminator differs from luma.gl's `spot`. */
    type: 'ambient' | 'directional' | 'point' | 'spotlight';
    /** Linear RGB ambient contribution. */
    ambient: Triple;
    /** Linear RGB diffuse contribution. */
    diffuse: Triple;
    /** Linear RGB specular contribution. */
    specular: Triple;
    /** Position in the same eye-relative lighting space as the rendered surface. */
    position?: Triple;
    /** Incoming direction in the surface normal's lighting space. */
    direction?: Triple;
    /** Tangram's distance exponent, not luma.gl's polynomial coefficients. */
    attenuation?: number;
    /** Tangram's resolved inner/outer radii, in lighting-space units. */
    radius?: readonly [number | null, number];
    /** Tangram spotlight cutoff in degrees. */
    angle?: number;
    /** Tangram spotlight falloff exponent. */
    exponent?: number;
}

/** A luma.gl light plus the Tangram-only data required for lossless shading. */
export interface TangramLightMapping {
    /** Luma.gl-compatible byte RGB and resolved coordinates, with optional Tangram controls. */
    light: TangramLight;
    /** Positions are resolved lighting coordinates, not geographic longitude/latitude. */
    coordinateSpace: 'tangram-lighting';
    /** Exact legacy contributions and falloff; consumers must not silently discard them. */
    tangram: ResolvedTangramLight;
}

/** Configuration produced for Tangram's existing shader composer from a native luma.gl light. */
export interface LumaLightConfig {
    /** Tangram shader discriminator. */
    type: ResolvedTangramLight['type'];
    /** Linear ambient RGB. */
    ambient: TangramLightColor;
    /** Linear diffuse RGB. */
    diffuse: TangramLightColor;
    /** Linear specular RGB. */
    specular: TangramLightColor;
    /** Independent copy of the native light, used for native falloff and coordinates. */
    lumaLight: NormalizedTangramLight;
    /** Native common space by default, or an explicitly selected legacy position interpretation. */
    origin: 'luma' | 'world' | 'ground' | 'camera';
    /** Native projected position. */
    position?: Triple;
    /** Native incoming direction. */
    direction?: Triple;
    /** Tangram exponent, kept separate from the native polynomial coefficient vector. */
    attenuation?: number;
    /** Copied legacy radius configuration for the existing unit resolver. */
    radius?: TangramPositionalLightExtensions['radius'];
    /** Tangram spotlight exponent. */
    exponent?: number;
}

/** Convert resolved Tangram data without pretending legacy falloff or separate colors are equivalent. */
export function mapTangramLight(resolved: Omit<ResolvedTangramLight, 'ambient' | 'diffuse' | 'specular'> & {
    ambient: readonly number[];
    diffuse: readonly number[];
    specular: readonly number[];
}): TangramLightMapping {
    const tangram: ResolvedTangramLight = {
        ...resolved,
        ambient: copyTriple(resolved.ambient),
        diffuse: copyTriple(resolved.diffuse),
        specular: copyTriple(resolved.specular),
        ...(resolved.position ? {position: copyTriple(resolved.position)} : {}),
        ...(resolved.direction ? {direction: copyTriple(resolved.direction)} : {}),
        ...(resolved.radius ? {radius: [resolved.radius[0], resolved.radius[1]]} : {})
    };
    const color = (resolved.type === 'ambient' ? resolved.ambient : resolved.diffuse)
        .map(component => component * 255);
    const common = {color: copyTriple(color), intensity: 1,
        ambient: copyTriple(resolved.ambient), diffuse: copyTriple(resolved.diffuse),
        specular: copyTriple(resolved.specular)};
    const positional = {
        ...(resolved.attenuation != null ? {attenuationExponent: resolved.attenuation} : {}),
        ...(resolved.radius ? {radius: [resolved.radius[0], resolved.radius[1]] as const} : {})
    };
    let light: TangramLight;
    switch (resolved.type) {
        case 'ambient':
            light = {type: 'ambient', ...common};
            break;
        case 'directional':
            light = {type: 'directional', ...common, direction: copyTriple(requireVector(resolved.direction, 'direction'))};
            break;
        case 'point':
            light = {type: 'point', ...common, ...positional, position: copyTriple(requireVector(resolved.position, 'position'))};
            break;
        case 'spotlight': {
            const angle = (resolved.angle ?? 20) * Math.PI / 180;
            light = {type: 'spot', ...common, ...positional, position: copyTriple(requireVector(resolved.position, 'position')),
                direction: copyTriple(requireVector(resolved.direction, 'direction')),
                innerConeAngle: angle, outerConeAngle: angle,
                ...(resolved.exponent != null ? {spotExponent: resolved.exponent} : {})};
            break;
        }
        default:
            throw new Error(`Unsupported Tangram light type: ${resolved.type}`);
    }
    return {light, coordinateSpace: 'tangram-lighting', tangram};
}

/** Translate a native luma.gl light while retaining its polynomial attenuation and radian cones. */
export function convertLumaLight(input: TangramLight | undefined): LumaLightConfig {
    if (!input || !['ambient', 'directional', 'point', 'spot'].includes(input.type)) {
        throw new Error('Expected a luma.gl ambient, directional, point or spot light');
    }
    const color = copyTriple(input.color ?? [0, 0, 0]);
    const intensity = input.intensity ?? 1;
    if (!Number.isFinite(intensity) || intensity < 0 || color.some(component => component < 0)) {
        throw new Error('Luma light color and intensity must be finite and non-negative');
    }
    const contribution = copyTriple(color.map(component => component / 255 * intensity));
    const lumaLight: TangramLight = {...input, color, intensity};
    for (const property of ['ambient', 'diffuse', 'specular'] as const) {
        if (input[property] != null) lumaLight[property] = copyContribution(input[property]);
    }
    if (input.visible != null && typeof input.visible !== 'boolean') {
        throw new Error('Tangram light visibility must be a boolean');
    }
    if (lumaLight.type === 'directional' || lumaLight.type === 'spot') {
        lumaLight.direction = copyTriple(requireVector(lumaLight.direction, 'direction'));
        if (Math.hypot(...lumaLight.direction) === 0) {
            throw new Error('Luma light direction must be non-zero');
        }
    }
    if (lumaLight.type === 'point' || lumaLight.type === 'spot') {
        lumaLight.position = copyTriple(requireVector(lumaLight.position, 'position'));
        lumaLight.attenuation = copyTriple(lumaLight.attenuation ?? [1, 0, 0]);
        if (lumaLight.attenuation.some(component => component < 0) || Math.max(...lumaLight.attenuation) === 0) {
            throw new Error('Luma light attenuation must be non-negative and not all zero');
        }
        if (lumaLight.origin != null && !['world', 'ground', 'camera'].includes(lumaLight.origin)) {
            throw new Error('Tangram light origin must be world, ground or camera');
        }
        if (lumaLight.positionSpace != null && !['common', 'geographic'].includes(lumaLight.positionSpace)) throw new Error('Light positionSpace must be common or geographic');
        if (lumaLight.directionSpace != null && !['common', 'enu'].includes(lumaLight.directionSpace)) throw new Error('Light directionSpace must be common or enu');
        if (lumaLight.positionSpace === 'geographic') {
            if (lumaLight.origin != null) throw new Error('Geographic light positions cannot also specify a legacy origin');
            if (Math.abs(lumaLight.position[1]) > 90) throw new Error('Geographic light latitude must be within +/-90 degrees');
        } else if (lumaLight.directionSpace === 'enu') throw new Error('ENU light directions require geographic positions');
        if (lumaLight.attenuationExponent != null) validateExponent(lumaLight.attenuationExponent);
        if (lumaLight.radius != null) lumaLight.radius = copyRadius(lumaLight.radius);
    }
    if (lumaLight.type === 'spot') {
        lumaLight.innerConeAngle = lumaLight.innerConeAngle ?? 0;
        lumaLight.outerConeAngle = lumaLight.outerConeAngle ?? Math.PI / 4;
        if (!Number.isFinite(lumaLight.innerConeAngle) || !Number.isFinite(lumaLight.outerConeAngle) ||
            lumaLight.innerConeAngle < 0 || lumaLight.innerConeAngle > lumaLight.outerConeAngle ||
            lumaLight.outerConeAngle > Math.PI / 2) {
            throw new Error('Luma spot cones require 0 <= inner <= outer <= PI/2 radians');
        }
        if (lumaLight.spotExponent != null) validateExponent(lumaLight.spotExponent);
    }
    return {
        type: lumaLight.type === 'spot' ? 'spotlight' : lumaLight.type,
        ambient: lumaLight.ambient ?? (lumaLight.type === 'ambient' ? contribution : [0, 0, 0]),
        diffuse: lumaLight.diffuse ?? (lumaLight.type === 'ambient' ? [0, 0, 0] : contribution),
        specular: lumaLight.specular ?? (lumaLight.type === 'ambient' ? [0, 0, 0] : contribution),
        // All required defaults and vector validation above have completed for this discriminator.
        origin: 'origin' in lumaLight ? lumaLight.origin ?? 'luma' : 'luma', lumaLight: lumaLight as NormalizedTangramLight,
        ...('position' in lumaLight ? {position: copyTriple(lumaLight.position)} : {}),
        ...('direction' in lumaLight ? {direction: copyTriple(lumaLight.direction)} : {}),
        ...('attenuationExponent' in lumaLight ? {attenuation: lumaLight.attenuationExponent} : {}),
        ...('radius' in lumaLight ? {radius: lumaLight.radius} : {}),
        ...(lumaLight.type === 'spot' ? {exponent: lumaLight.spotExponent ?? 0} : {})
    };
}

/** Wrap native arrays without validation so scene globals resolve before Light.create converts them. */
export function normalizeSceneLights(lights: unknown): unknown {
    if (!Array.isArray(lights)) return lights;
    return Object.fromEntries(lights.map((light, index) => [`luma_light_${index}`, {luma: light}]));
}

/** Keep legacy color syntax independent of luma.gl's byte RGB field. */
function copyContribution(color: TangramLightColor): TangramLightColor {
    if (typeof color === 'string') return color;
    if (typeof color === 'number' && Number.isFinite(color)) return color;
    if (Array.isArray(color) && (color.length === 3 || color.length === 4) && color.every(Number.isFinite)) {
        return color.length === 3 ? [color[0], color[1], color[2]] : [color[0], color[1], color[2], color[3]];
    }
    throw new Error('Tangram light contributions require a finite scalar, RGB/RGBA tuple or CSS color');
}

/** Copy radii without sharing caller arrays; the legacy resolver handles unit strings. */
function copyRadius(radius: NonNullable<TangramPositionalLightExtensions['radius']>): NonNullable<TangramPositionalLightExtensions['radius']> {
    const validate = (value: unknown) => typeof value === 'number' ? Number.isFinite(value) && value >= 0 :
        typeof value === 'string' && /^\d+(?:\.\d+)?(?:px|m)?$/.test(value);
    if (typeof radius === 'number' || typeof radius === 'string') {
        if (validate(radius)) return radius;
    } else if (radius.length === 2 && (radius[0] == null || validate(radius[0])) && validate(radius[1])) {
        return [radius[0], radius[1]];
    }
    throw new Error('Tangram light radii require non-negative meter/pixel distances');
}

/** Falloff exponents must not introduce non-finite shader operations. */
function validateExponent(exponent: number): void {
    if (!Number.isFinite(exponent) || exponent < 0) throw new Error('Tangram light exponents must be finite and non-negative');
}

/** Copy and validate vectors without sharing caller-owned arrays. */
function copyTriple(vector: ArrayLike<number>): [number, number, number] {
    if (vector.length !== 3 || !Array.from(vector).every(Number.isFinite)) {
        throw new Error('Light vectors must contain three finite numbers');
    }
    return [vector[0], vector[1], vector[2]];
}

/** Report missing required vectors instead of supplying an arbitrary position/direction. */
function requireVector(vector: ArrayLike<number> | undefined, name: string): ArrayLike<number> {
    if (!vector) throw new Error(`Light requires a ${name}`);
    return vector;
}
