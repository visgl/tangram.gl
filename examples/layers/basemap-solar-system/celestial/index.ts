// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// celestial: the physics of the solar system. Pure functions and frozen data; no deck.gl,
// tangram.gl or DOM imports. Later home: math.gl, beside `@math.gl/earth/sun`.

export type {V3} from './vector';
export {DEG, angleDeg, dot, norm, unit} from './vector';
export type {BodyId, PhysicalConstants, PlanetId} from './constants';
export {BODY_IDS, PHYSICAL_CONSTANTS, PLANET_IDS} from './constants';
export {getCenturiesTT, getDaysTT} from './time';
export {eclipticToEqj, eqjToEcliptic, getBodyAxes, getPole} from './frames';
export {GALILEAN, KM_PER_AU, getGalileanOffsets, moonGeocentric, planetOrbit, planetPosition} from './ephemeris';
export type {StarPoint} from './sun';
export {SATURN_RINGS, STAR_SOURCE, checkTerminator, getMoonPhase, getStarPoints, getTerminator} from './sun';
export type {NormalGravity} from './gravity';
export {getNormalGravity} from './gravity';
export type {Occluder, RingShadow, ShadowGeometry} from './shadows';
export {
  RING_OPTICAL_DEPTH, SHADOWED_BODIES, discVisibleFraction, geodeticNormal, getShadowGeometry, lightAt,
  ringTransmission, sphereVisibility, surfacePoint, visibleFractionAt
} from './shadows';
export type {Atmosphere} from './atmosphere';
export {
  ATMOSPHERE_IDS,
  CLOUD_LUT_DIFFUSE_SCALE,
  CLOUD_LUT_MAX_ALTITUDE,
  CLOUD_LUT_MIN_ALTITUDE,
  CLOUD_LUT_SIZE,
  CLOUD_MAP_FLOOR,
  EARTH_CLOUD_BASE_KM,
  EARTH_CLOUD_TOP_KM,
  chapmanColumn,
  cloudAlbedoFromMap,
  cloudLutAltitude,
  cloudLutCoordinate,
  cloudOpticalDepth,
  erfcx,
  getAtmosphere,
  getCloudLightTable,
  henyeyGreenstein,
  rayleighPhase,
  raySphere
} from './atmosphere';
export type {CometElements, OrbitState} from './comet';
export {
  GAUSS_K, NEOWISE, NEOWISE_PERIHELION, cometActivity, cometOrbit, cometState, dustTail, ionTailDirection,
  julianTT, solveKepler
} from './comet';
export {baumbachDensity, kelsallDensity} from './gas';
export type {SkyEvent, SkyEventKind} from './events';
export {COMET_PERIHELION_DATE, findEclipses, findSkyEvents} from './events';
