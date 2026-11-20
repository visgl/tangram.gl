// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Bakes the density volume of the artistic gas cloud, offline: `node bake-cloud.mjs [size]`.
// Writes `cloud-<size>.r8`: size^3 bytes, x fastest, then y, then z (R8, 0-255).
//
// The look imitates a fluid simulation without one: an ellipsoidal blob of fractal value noise
// is advected backward for a few steps through a curl-noise velocity field (divergence free, so
// the gas swirls and makes filaments instead of blurring). Seeded: the output is deterministic.

import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const SIZE = Number(process.argv[2] ?? 96);
const SEED = 1729;

function hash(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + SEED * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
/** Value noise in 0-1, C2 interpolation. */
function noise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash(xi + dx, yi + dy, zi + dz);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w
  );
}
function fbm(x, y, z, octaves = 5) {
  let sum = 0, amp = 0.5, f = 1;
  for (let k = 0; k < octaves; k++) {
    sum += amp * noise(x * f, y * f, z * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
/** Curl of a vector potential made of three offset noise fields. */
function curl(x, y, z) {
  const e = 0.05;
  const P = (k, a, b, c) => noise(a + 31.4 * k, b - 17.1 * k, c + 9.7 * k);
  const d = (k, axis) => {
    const o = [0, 0, 0];
    o[axis] = e;
    return (P(k, x + o[0], y + o[1], z + o[2]) - P(k, x - o[0], y - o[1], z - o[2])) / (2 * e);
  };
  return [d(2, 1) - d(1, 2), d(0, 2) - d(2, 0), d(1, 0) - d(0, 1)];
}

const ADVECT_STEPS = 6;
const DT = 0.09;
const data = new Uint8Array(SIZE ** 3);
for (let k = 0; k < SIZE; k++) {
  for (let j = 0; j < SIZE; j++) {
    for (let i = 0; i < SIZE; i++) {
      // -1..1 in the volume.
      let x = ((i + 0.5) / SIZE) * 2 - 1, y = ((j + 0.5) / SIZE) * 2 - 1, z = ((k + 0.5) / SIZE) * 2 - 1;
      // Backward advection: where did the gas at this voxel come from?
      for (let s = 0; s < ADVECT_STEPS; s++) {
        const v = curl(x * 1.6 + 3, y * 1.6, z * 1.6);
        x -= v[0] * DT;
        y -= v[1] * DT;
        z -= v[2] * DT;
      }
      // An ellipsoidal envelope, flattened in z, with a lumpy edge.
      const r = Math.hypot(x, y * 1.15, z * 1.7);
      const envelope = Math.max(0, 1 - r ** 2) ** 1.5;
      const n = fbm(x * 2.6 + 11, y * 2.6, z * 2.6);
      // Billowy ridges: dense cores with clear gaps.
      const d = Math.max(0, n * 1.6 - 0.55) * envelope * 2.4;
      data[i + SIZE * (j + SIZE * k)] = Math.min(255, Math.round(255 * Math.min(1, d) ** 1.2));
    }
  }
}
const out = fileURLToPath(new URL(`./cloud-${SIZE}.r8`, import.meta.url));
writeFileSync(out, data);
let filled = 0;
for (const v of data) if (v > 8) filled++;
console.log(`${out}: ${data.length} bytes, ${((100 * filled) / data.length).toFixed(1)}% of voxels above 8/255`);
