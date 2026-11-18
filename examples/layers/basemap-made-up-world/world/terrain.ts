// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The world fields as functions of world coordinates: the elevation, moisture and temperature
// of a seeded terrain generator, and its biome rules mapped to OpenMapTiles classes.

import {GradientNoise, domainWarp, ridge, smoothstep} from './noise';

/** The terrain constants and the world grid. */
export const TERRAIN = {
  /** Noise cells around the world at the first octave; an integer, so x wraps. */
  BASE_PERIOD: 6,
  WARP_STRENGTH: 0.35,
  RIDGE_WEIGHT_BASE: 0.55,
  RIDGE_WEIGHT_RANGE: 0.4,
  ELEVATION_CURVE_BASE: 1.5,
  ELEVATION_CURVE_RANGE: 2.5,
  TEMPERATURE_LAPSE_RATE: -0.6,
  /** Large enough for ice at the poles of a whole world. */
  LATITUDINAL_GRADIENT: 1.1,
  /** The coarse whole-world grid, plate carree. */
  GRID_W: 512,
  GRID_H: 256,
  /** The octaves of the coarse grid; the detail octaves follow them up to DETAIL_OCTAVES. */
  COARSE_OCTAVES: 5,
  DETAIL_OCTAVES: 14,
  DETAIL_AMPLITUDE: 6,
  HILLINESS: 0.35,
  TEMPERATURE: 0.5
} as const;

/** The noise coordinates of a longitude and latitude: x in [0, BASE_PERIOD), y in [0, BASE_PERIOD / 2]. */
export function toNoise(lon: number, lat: number): [number, number] {
  const u = (((lon + 180) / 360) % 1 + 1) % 1;
  const v = (90 - lat) / 180;
  return [u * TERRAIN.BASE_PERIOD, (v * TERRAIN.BASE_PERIOD) / 2];
}

/** The noise sources of one seed. */
export type WorldNoise = {elevation: GradientNoise; detail: GradientNoise; climate: GradientNoise};

export function createWorldNoise(seed: number): WorldNoise {
  return {
    elevation: new GradientNoise(seed),
    detail: new GradientNoise(seed ^ 0x9e3779b9),
    climate: new GradientNoise(seed ^ 0x51ed270b)
  };
}

const P = TERRAIN.BASE_PERIOD;

/** The elevation: domain-warped fBm, blended with ridge noise, then a tanh curve. In [-1, 1]. */
export function coarseElevation(noise: WorldNoise, x: number, y: number): number {
  const n = noise.elevation;
  const [wx, wy] = domainWarp(n, x, y, 1, TERRAIN.WARP_STRENGTH, P);
  const eBase = n.fbm(wx, wy, TERRAIN.COARSE_OCTAVES, 0.5, 1, P);
  const eRidge = ridge(n.fbm(wx + 1000, wy - 1000, 4, 0.5, 1, P));
  const ridgeWeight = TERRAIN.RIDGE_WEIGHT_BASE + TERRAIN.RIDGE_WEIGHT_RANGE * TERRAIN.HILLINESS;
  // A plain blend `(1 - w) * eBase + w * ridge` gives a net of thin ridge continents on a whole
  // world. Here eBase makes the continents and the ridge noise adds mountain chains only where
  // eBase is high.
  const e = eBase + 0.45 * ridgeWeight * (eRidge * 2 - 1) * smoothstep(-0.05, 0.3, eBase);
  return Math.tanh(
    e * (TERRAIN.ELEVATION_CURVE_BASE + TERRAIN.HILLINESS * TERRAIN.ELEVATION_CURVE_RANGE)
  );
}

/** The detail octaves above the coarse grid: the coastline detail of the tiles. */
export function detailElevation(noise: WorldNoise, x: number, y: number): number {
  return (
    TERRAIN.DETAIL_AMPLITUDE *
    noise.detail.fbm(x, y, TERRAIN.DETAIL_OCTAVES, 0.55, 1, P, TERRAIN.COARSE_OCTAVES)
  );
}

/** The moisture (not warped), in about [-1, 1]. */
export function coarseMoisture(noise: WorldNoise, x: number, y: number): number {
  return noise.climate.fbm(x + 500, y - 500, 4, 0.55, 1, P);
}

/** Detail octaves of moisture for the tiles, so that landcover edges are not the coarse grid. */
export function detailMoisture(noise: WorldNoise, x: number, y: number): number {
  return 0.9 * noise.climate.fbm(x + 500, y - 500, 9, 0.6, 1, P, 4);
}

/** The noise part of the temperature. */
export function coarseTemperatureNoise(noise: WorldNoise, x: number, y: number): number {
  return noise.climate.fbm(x - 2000, y + 2000, 3, 0.5, 1, P) * 0.2;
}

/** The temperature: base, minus a latitude gradient, plus the lapse rate of the land height. */
export function temperatureAt(lat: number, landHeight: number, tNoise: number): number {
  return (
    TERRAIN.TEMPERATURE -
    TERRAIN.LATITUDINAL_GRADIENT * Math.abs(lat / 90) +
    TERRAIN.TEMPERATURE_LAPSE_RATE * Math.max(0, landHeight) +
    tNoise
  );
}

/** OpenMapTiles landcover classes, by index (0 is none). */
export const LANDCOVER_CLASSES = ['', 'wood', 'grass', 'farmland', 'sand', 'ice', 'rock', 'wetland'] as const;
export type LandcoverClass = (typeof LANDCOVER_CLASSES)[number];
const LC = Object.fromEntries(LANDCOVER_CLASSES.map((name, index) => [name, index])) as Record<
  LandcoverClass,
  number
>;

/**
 * The biome rules of a temperate climate, mapped to OpenMapTiles classes. `e` is the
 * elevation, `m` moisture in [0, 1], `t` temperature in [-1, 1].
 */
export function classifyLandcover(e: number, m: number, t: number): number {
  if (e < -0.15 && m > 0.6) return LC.wetland; // marsh
  if (t < -0.4) return e > 0.2 ? LC.ice : LC.rock; // ice, snow; rough stone
  if (m < 0.25 && t > 0.2) {
    if (e > 0.55) return LC.rock; // stone
    return LC.sand; // sand, gravel
  }
  if (m > 0.55 && t > 0) {
    if (m > 0.7 && e > -0.1) return LC.wood; // soil_rich
    if (m > 0.45) return LC.grass;
    return LC.farmland; // dirt
  }
  if (e > 0.55) return LC.rock; // stone
  if (m > 0.55) return LC.wood; // soil_rich
  if (m > 0.35) return LC.grass;
  if (m < 0.2) return LC.sand;
  return LC.farmland; // dirt
}
