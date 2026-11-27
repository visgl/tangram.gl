// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Seeded dust near the camera, for a sense of speed in flights. After the seeded particle fills
// of the Carbon engine (github.com/carbonengine, MIT): one deterministic fill from a seed, a
// global count, and a fade with distance. No Carbon code is used.
//
// The dust is a periodic field: a cube of `cell` scene units holds `count` seeded points and
// repeats in all directions. The renderer draws the copy of each point nearest the camera, so
// there is always dust around the camera, at fixed positions in the absolute scene frame. The
// cell size follows the camera distance in steps of 4x, with a cross-fade between two sizes, so
// the dust works from the system view down to a globe. Pure functions only.

import type {V3} from '../celestial';

/** Mulberry32: a small seeded PRNG, 0-1. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` points in the unit cube, xyz interleaved, from a seed. */
export function dustSeeds(count: number, seed = 20201): Float32Array {
  const random = mulberry32(seed);
  const out = new Float32Array(count * 3);
  for (let k = 0; k < out.length; k++) out[k] = random();
  return out;
}

export type DustLevel = {
  /** Size of the repeating cube, scene units. */
  cell: number;
  /** The camera's absolute position modulo `cell`, 0..cell per axis (double precision on the CPU). */
  offset: V3;
  /** Cross-fade weight, 0-1; the weights of the levels add up to 1. */
  weight: number;
};

/** Cell size per camera distance: the dust spans about 1.5x the distance to the target. */
const CELL_PER_DISTANCE = 1.5;

/**
 * The two dust levels for a camera at `eyeAbsolute` (scene units, absolute: relative position +
 * floating origin) that is `distance` from what it looks at.
 */
export function dustLevels(eyeAbsolute: readonly number[], distance: number): DustLevel[] {
  const L = Math.log(Math.max(1e-9, distance * CELL_PER_DISTANCE)) / Math.log(4);
  const l0 = Math.floor(L);
  const f = L - l0;
  return [
    {level: l0, weight: 1 - f},
    {level: l0 + 1, weight: f}
  ].map(({level, weight}) => {
    const cell = 4 ** level;
    const offset = eyeAbsolute.map(v => v - cell * Math.floor(v / cell)) as V3;
    return {cell, offset, weight};
  });
}

/** Position of seed point `k` relative to the camera, in the copy nearest the camera (as the shader does). */
export function dustRelative(seeds: Float32Array, k: number, level: DustLevel): V3 {
  const {cell, offset} = level;
  return [0, 1, 2].map(axis => {
    const v = seeds[3 * k + axis] * cell - offset[axis] + cell / 2;
    return v - cell * Math.floor(v / cell) - cell / 2;
  }) as V3;
}

/** Opacity of a dust point at a distance, 0-1: fades in near the camera and out at half a cell. */
export function dustFade(distance: number, cell: number): number {
  const near = Math.min(1, distance / (0.02 * cell));
  const far = Math.max(0, Math.min(1, (0.5 * cell - distance) / (0.25 * cell)));
  return near * near * far;
}
