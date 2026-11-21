// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Atmospheres and clouds of the bodies: single-scattering parameters per body, the scalar
// functions that the atmosphere shader repeats (scene/atmosphere-layer.ts), and a table of the
// sunlight on the Earth's clouds from math.gl `getCloudLighting`. All lengths in the shader are
// in body radii, so the parameters are given in metres and divided by the radius here.

import {getCloudLighting} from '@math.gl/earth';
import {PHYSICAL_CONSTANTS, type BodyId} from './constants';

/** Single-scattering atmosphere of a body, lengths in body radii, coefficients per body radius. */
export type Atmosphere = {
  readonly id: BodyId;
  /** Radius where the atmosphere starts (the surface, or an opaque cloud deck). */
  readonly baseRadius: number;
  /** Top of the atmosphere. */
  readonly topRadius: number;
  /** Scale heights of the gas (Rayleigh) and the aerosols (Mie). */
  readonly rayleighHeight: number;
  readonly mieHeight: number;
  /** Rayleigh scattering at the base, RGB (680, 550, 440 nm). */
  readonly rayleigh: readonly [number, number, number];
  /** Aerosol scattering and extinction at the base, RGB. */
  readonly mieScattering: readonly [number, number, number];
  readonly mieExtinction: readonly [number, number, number];
  /** Henyey-Greenstein asymmetry of the aerosols. */
  readonly mieAsymmetry: number;
  /** Opaque cloud deck at `baseRadius` (Venus): its albedo, RGB. */
  readonly deckAlbedo?: readonly [number, number, number];
  /** Where the numbers come from. */
  readonly source: string;
};

/** Parameters in SI units, before they are scaled to body radii. */
type AtmosphereSpec = {
  baseKm: number;
  topKm: number;
  rayleighHeightKm: number;
  mieHeightKm: number;
  /** m^-1 */
  rayleigh: [number, number, number];
  /** m^-1 */
  mieScattering: [number, number, number];
  /** m^-1 */
  mieExtinction: [number, number, number];
  mieAsymmetry: number;
  deckAlbedo?: [number, number, number];
  source: string;
};

// Mars and Venus Rayleigh coefficients: the Earth's sea-level values times the ratio of number
// densities (n = p / kT) and times 2.5 for the larger CO2 cross-section (Sneep & Ubachs 2005).
const EARTH_RAYLEIGH: [number, number, number] = [5.802e-6, 13.558e-6, 33.1e-6];
const scale3 = (v: readonly number[], k: number): [number, number, number] => [v[0] * k, v[1] * k, v[2] * k];
const BOLTZMANN = 1.380649e-23;
const EARTH_SEA_LEVEL_DENSITY = 101325 / (BOLTZMANN * 288.15);
const co2Rayleigh = (pascal: number, kelvin: number) =>
  scale3(EARTH_RAYLEIGH, (2.5 * pascal) / (BOLTZMANN * kelvin) / EARTH_SEA_LEVEL_DENSITY);

const SPECS: Partial<Record<BodyId, AtmosphereSpec>> = {
  earth: {
    baseKm: 0,
    topKm: 60,
    rayleighHeightKm: 8,
    mieHeightKm: 1.2,
    rayleigh: EARTH_RAYLEIGH,
    mieScattering: [3.996e-6, 3.996e-6, 3.996e-6],
    mieExtinction: [4.44e-6, 4.44e-6, 4.44e-6],
    mieAsymmetry: 0.8,
    source: 'Bruneton (2017), Precomputed Atmospheric Scattering, demo constants'
  },
  mars: {
    // Surface 610 Pa, 210 K; dust optical depth 0.5 (Lemmon et al. 2015), well mixed to the gas
    // scale height; dust single-scattering albedo 0.97 / 0.94 / 0.80 and g = 0.65 (Wolff et al. 2009).
    baseKm: 0,
    topKm: 80,
    rayleighHeightKm: 11.1,
    mieHeightKm: 11.1,
    rayleigh: co2Rayleigh(610, 210),
    mieScattering: scale3([0.97, 0.94, 0.8], 0.5 / 11100),
    mieExtinction: scale3([1, 1, 1], 0.5 / 11100),
    mieAsymmetry: 0.65,
    source:
      'NASA Mars Fact Sheet (pressure, scale height); Lemmon et al. 2015, Icarus 251 (dust optical depth); Wolff et al. 2009, JGR 114 E00D04 (dust albedo and asymmetry)'
  },
  venus: {
    // Above the cloud tops (about 70 km): 3.7 kPa, 230 K (VIRA, Seiff et al. 1985); gas scale
    // height RT/Mg = 4.9 km; upper haze optical depth about 0.3 with a 4 km scale height
    // (Wilquet et al. 2009); cloud-top albedo near the Bond albedo 0.76, yellow in the blue.
    baseKm: 70,
    topKm: 110,
    rayleighHeightKm: 4.9,
    mieHeightKm: 4,
    rayleigh: co2Rayleigh(3700, 230),
    mieScattering: scale3([0.995, 0.99, 0.97], 0.3 / 4000),
    mieExtinction: scale3([1, 1, 1], 0.3 / 4000),
    mieAsymmetry: 0.7,
    deckAlbedo: [0.86, 0.8, 0.6],
    source:
      'Seiff et al. 1985, Adv. Space Res. 5 (VIRA); Wilquet et al. 2009, JGR 114 E00B42 (upper haze); NASA Venus Fact Sheet (albedo)'
  }
};

/** The bodies with an atmosphere in this example. Titan is not in the scene. */
export const ATMOSPHERE_IDS = Object.freeze(Object.keys(SPECS) as BodyId[]);

/** The atmosphere of a body in body-radius units, or null. */
export function getAtmosphere(id: BodyId): Atmosphere | null {
  const spec = SPECS[id];
  if (!spec) return null;
  const radiusM = PHYSICAL_CONSTANTS[id].radiusKm * 1000;
  const km = (value: number) => (value * 1000) / radiusM;
  const perRadius = (v: readonly number[]) => scale3(v, radiusM);
  return Object.freeze({
    id,
    baseRadius: 1 + km(spec.baseKm),
    topRadius: 1 + km(spec.topKm),
    rayleighHeight: km(spec.rayleighHeightKm),
    mieHeight: km(spec.mieHeightKm),
    rayleigh: perRadius(spec.rayleigh),
    mieScattering: perRadius(spec.mieScattering),
    mieExtinction: perRadius(spec.mieExtinction),
    mieAsymmetry: spec.mieAsymmetry,
    ...(spec.deckAlbedo ? {deckAlbedo: spec.deckAlbedo} : {}),
    source: spec.source
  });
}

/** The Earth's cloud shell, km above the surface. */
export const EARTH_CLOUD_BASE_KM = 2;
export const EARTH_CLOUD_TOP_KM = 12;

/** Henyey-Greenstein phase function, per steradian. */
export function henyeyGreenstein(cosTheta: number, g: number): number {
  const d = 1 + g * g - 2 * g * cosTheta;
  return (1 - g * g) / (4 * Math.PI * d * Math.sqrt(d));
}

/** Rayleigh phase function, per steradian. */
export function rayleighPhase(cosTheta: number): number {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
}

/**
 * Scaled complementary error function exp(y^2) erfc(y), y >= 0: Ren & MacKenzie (2007),
 * "Closed-form approximations to the error and complementary error functions"; relative error
 * under 0.5 % (measured in the tests).
 */
export function erfcx(y: number): number {
  const a = 2.911;
  const sqrtPi = Math.sqrt(Math.PI);
  return a / ((a - 1) * sqrtPi * y + Math.sqrt(Math.PI * y * y + a * a));
}

/**
 * Column of an exponential atmosphere along a ray to infinity, in scale heights: the integral of
 * exp(-(r - R) / H) ds / H from a point `h` scale heights above radius R (= `x` scale heights)
 * with `cosZenith` between the ray and the local vertical. The Chapman function in its asymptotic
 * form Ch(r, z) = sqrt(pi r / 2) erfcx(sqrt(r / 2) cos z) (Chapman 1931; Schüler 2012, "An
 * approximation to the Chapman grazing-incidence function", GPU Pro 3), and for a ray below the
 * horizon twice the column from the tangent point less the column looking back. It counts the
 * column as if the planet were not there: the caller tests for the planet.
 */
export function chapmanColumn(x: number, h: number, cosZenith: number): number {
  const r = x + h;
  const ch = (radius: number, cosine: number) =>
    Math.sqrt((Math.PI / 2) * radius) * erfcx(Math.sqrt(radius / 2) * cosine);
  if (cosZenith >= 0) return ch(r, cosZenith) * Math.exp(-h);
  const x0 = Math.sqrt(1 - cosZenith * cosZenith) * r;
  return 2 * Math.sqrt((Math.PI / 2) * x0) * Math.exp(x - x0) - ch(r, -cosZenith) * Math.exp(-h);
}

/** Distances along a ray (unit direction) to its entry and exit of a sphere at the origin, or null. */
export function raySphere(
  origin: readonly number[],
  direction: readonly number[],
  radius: number
): [number, number] | null {
  const b = origin[0] * direction[0] + origin[1] * direction[1] + origin[2] * direction[2];
  const c = origin[0] ** 2 + origin[1] ** 2 + origin[2] ** 2 - radius * radius;
  const d = b * b - c;
  if (d < 0) return null;
  const s = Math.sqrt(d);
  return [-b - s, -b + s];
}

/** Brightness of the cloud map under which the sky is clear (the dark ocean of the map). */
export const CLOUD_MAP_FLOOR = 0.1;
/** Cloud albedo from a cloud map value (0..1): its brightness above the clear-sky floor. */
export function cloudAlbedoFromMap(value: number): number {
  return Math.min(0.999, Math.max(0, (value - CLOUD_MAP_FLOOR) / (1 - CLOUD_MAP_FLOOR)));
}

/**
 * Vertical optical depth of a cloud from its albedo: two-stream conservative scattering,
 * A = (1 - g) tau / (2 + (1 - g) tau) with g = 0.85, solved for tau and limited to `maxDepth`.
 */
export function cloudOpticalDepth(albedo: number, g = 0.85, maxDepth = 60): number {
  const a = Math.min(Math.max(albedo, 0), 0.999);
  return Math.min(maxDepth, (2 * a) / ((1 - g) * (1 - a)));
}

/** Sun altitudes of the cloud light table, radians: dense near the horizon. */
export const CLOUD_LUT_SIZE = 128;
export const CLOUD_LUT_MIN_ALTITUDE = -4 * (Math.PI / 180);
export const CLOUD_LUT_MAX_ALTITUDE = Math.PI / 2;
/** Table coordinate (0..1) of a Sun altitude; the shader uses the same mapping. */
export function cloudLutCoordinate(altitude: number): number {
  const span = CLOUD_LUT_MAX_ALTITUDE - CLOUD_LUT_MIN_ALTITUDE;
  return Math.sqrt(Math.min(1, Math.max(0, (altitude - CLOUD_LUT_MIN_ALTITUDE) / span)));
}
/** Sun altitude of a table coordinate. */
export function cloudLutAltitude(s: number): number {
  return CLOUD_LUT_MIN_ALTITUDE + (CLOUD_LUT_MAX_ALTITUDE - CLOUD_LUT_MIN_ALTITUDE) * s * s;
}

/**
 * Sunlight on the Earth's clouds, by local Sun altitude: math.gl `getCloudLighting` at the
 * middle of the cloud shell. Row 0 is the direct beam (reddened and cut off by the Earth's
 * horizon from the cloud altitude), row 1 the sky light, both white-balanced to the Sun above
 * the atmosphere, RGB as linear 0..1 and stored as RGBA8. `CLOUD_LUT_DIFFUSE_SCALE` undoes the
 * row 1 scale.
 */
export const CLOUD_LUT_DIFFUSE_SCALE = 4;
export function getCloudLightTable(size = CLOUD_LUT_SIZE): Uint8Array {
  const altitude = ((EARTH_CLOUD_BASE_KM + EARTH_CLOUD_TOP_KM) / 2) * 1000;
  const white = getCloudLighting(Math.PI / 2, {cloudAltitude: 50000, aerosolOpticalDepth: 0, pressure: 0});
  const top = white.direct.color.map(c => c * white.direct.intensity);
  const data = new Uint8Array(size * 2 * 4);
  const byte = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)));
  for (let i = 0; i < size; i++) {
    const light = getCloudLighting(cloudLutAltitude(i / (size - 1)), {cloudAltitude: altitude});
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = byte((light.direct.color[c] * light.direct.intensity) / top[c]);
      data[(size + i) * 4 + c] = byte((CLOUD_LUT_DIFFUSE_SCALE * light.diffuse.color[c] * light.diffuse.intensity) / top[c]);
    }
    data[i * 4 + 3] = 255;
    data[(size + i) * 4 + 3] = 255;
  }
  return data;
}
