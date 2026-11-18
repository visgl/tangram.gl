// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The noise of a seeded terrain generator: mulberry32, a Perlin gradient noise, fBm, a ridge
// fold and a domain warp. The permutation table is shuffled by the seed, and each octave wraps
// in x with an integer period, so the world is seamless around the antimeridian.

/** A seeded random number generator (mulberry32). Returns numbers in [0, 1). */
export function mulberry32(a: number): () => number {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit hash of integers, for seeds of sub-generators. */
export function hashInts(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const value of values) {
    h = Math.imul(h ^ (value | 0), 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

const GRAD3 = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [0, 1],
  [0, -1]
];
const GX = new Float64Array(GRAD3.map(g => g[0]));
const GY = new Float64Array(GRAD3.map(g => g[1]));

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t: number, a: number, b: number) => a + t * (b - a);

/** Seeded 2D gradient noise, with an optional period in x. */
export class GradientNoise {
  private readonly perm = new Uint8Array(512);

  constructor(seed: number) {
    const rng = mulberry32(seed >>> 0);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Noise in about [-1, 1]. With `periodX`, noise(x + periodX, y) = noise(x, y). */
  noise2D(x: number, y: number, periodX = 0): number {
    const perm = this.perm;
    const fx0 = Math.floor(x);
    const fy0 = Math.floor(y);
    const fx = x - fx0;
    const fy = y - fy0;
    let x0 = fx0;
    let x1 = fx0 + 1;
    if (periodX > 0) {
      x0 = ((x0 % periodX) + periodX) % periodX;
      x1 = ((x1 % periodX) + periodX) % periodX;
    }
    const a0 = perm[x0 & 255];
    const a1 = perm[x1 & 255];
    const g00 = perm[(a0 + fy0) & 255] % 12;
    const g10 = perm[(a1 + fy0) & 255] % 12;
    const g01 = perm[(a0 + fy0 + 1) & 255] % 12;
    const g11 = perm[(a1 + fy0 + 1) & 255] % 12;
    const n0 = GX[g00] * fx + GY[g00] * fy;
    const n1 = GX[g10] * (fx - 1) + GY[g10] * fy;
    const n2 = GX[g01] * fx + GY[g01] * (fy - 1);
    const n3 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);
    const u = fade(fx);
    const v = fade(fy);
    return lerp(v, lerp(u, n0, n1), lerp(u, n2, n3));
  }

  /**
   * Fractal Brownian motion, with lacunarity 2 so that each octave keeps an integer period.
   * `freq` is the frequency of the first octave; `period` is the period in x of the input, so
   * octave i wraps at `period * freq * 2^i`. `firstOctave` skips the lower octaves (for detail
   * noise on top of a coarse grid), without changing the normalization.
   */
  fbm(
    x: number,
    y: number,
    octaves: number,
    gain: number,
    freq: number,
    period: number,
    firstOctave = 0
  ): number {
    let amp = 1;
    let f = freq;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      if (i >= firstOctave) {
        sum += amp * this.noise2D(x * f, y * f, period * f);
      }
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return sum / norm;
  }
}

/** The "ridge" fold, which makes mountain chains. */
export function ridge(n: number): number {
  return 1 - Math.abs(n);
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * A domain warp: three fBm layers move the input point. The frequency factors are integers (2
 * and 1), so that the warp keeps the period in x.
 */
export function domainWarp(
  noise: GradientNoise,
  x: number,
  y: number,
  freq: number,
  strength: number,
  period: number
): [number, number] {
  const warp1 = noise.fbm(x + 37.2, y - 91.7, 3, 0.5, freq, period);
  const warp2 = noise.fbm(x - 12.5, y + 44.4, 3, 0.5, freq * 2, period);
  const warp3 = noise.fbm(x + 123.4, y + 56.7, 2, 0.6, freq, period);
  const wx = (warp1 + warp2 * 0.5 + warp3 * 0.25) * strength;
  const wy = (warp2 + warp1 * 0.5 + warp3 * 0.25) * strength;
  return [x + wx, y + wy];
}
