// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Space volumes of the solar-system example: the look-volume blend, the comet's Kepler orbit and
// tails, the dust field under a floating-origin rebase, and the gas density models.

import {expect, test} from 'vitest';
import {
  DEFAULT_LOOK,
  blendLook,
  smoothstep,
  weightAt,
  type LookParams,
  type LookVolume
} from '../examples/layers/basemap-solar-system/scene/look-volumes';
import {
  GAUSS_K,
  NEOWISE,
  NEOWISE_PERIHELION,
  cometActivity,
  cometState,
  dustTail,
  ionTailDirection,
  julianTT,
  solveKepler
} from '../examples/layers/basemap-solar-system/celestial/comet';
import {baumbachDensity, kelsallDensity} from '../examples/layers/basemap-solar-system/celestial/gas';
import {dustFade, dustLevels, dustRelative, dustSeeds} from '../examples/layers/basemap-solar-system/scene/space-dust';
import type {V3} from '../examples/layers/basemap-solar-system/celestial/vector';

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const DEG = Math.PI / 180;

// ---------- Look volumes ----------

const sphere = (radius: number, edge: number, center: V3 = [0, 0, 0]) => ({kind: 'sphere' as const, center, radius, edge});

test('look weights: sphere, shell and box are 1 inside, 0 outside, smooth across the edge', () => {
  const s = sphere(10, 4);
  expect(weightAt(s, [0, 0, 0])).toBe(1);
  expect(weightAt(s, [6, 0, 0])).toBe(1);
  expect(weightAt(s, [8, 0, 0])).toBeCloseTo(0.5, 12);
  expect(weightAt(s, [10, 0, 0])).toBe(0);
  expect(weightAt(s, [0, 0, 20])).toBe(0);
  const shell = {kind: 'shell' as const, center: [0, 0, 0] as V3, inner: 10, outer: 30, edge: 5};
  expect(weightAt(shell, [5, 0, 0])).toBe(0);
  expect(weightAt(shell, [10, 0, 0])).toBe(0);
  expect(weightAt(shell, [12.5, 0, 0])).toBeCloseTo(0.5, 12);
  expect(weightAt(shell, [20, 0, 0])).toBe(1);
  expect(weightAt(shell, [27.5, 0, 0])).toBeCloseTo(0.5, 12);
  expect(weightAt(shell, [30, 0, 0])).toBe(0);
  const box = {kind: 'box' as const, min: [0, 0, 0] as V3, max: [10, 20, 2] as V3, edge: 1};
  expect(weightAt(box, [5, 10, 1])).toBe(1);
  expect(weightAt(box, [0.5, 10, 1])).toBeCloseTo(0.5, 12);
  expect(weightAt(box, [5, 10, 1.5])).toBeCloseTo(0.5, 12);
  expect(weightAt(box, [5, 10, 2.5])).toBe(0);
  expect(weightAt(box, [-1, 10, 1])).toBe(0);
  // Corner: the axes multiply.
  expect(weightAt(box, [0.5, 19.5, 1])).toBeCloseTo(0.25, 12);
});

test('look blend: weight 0 keeps the base, weight 1 takes the volume, partial weights interpolate', () => {
  const warm: LookVolume = {id: 'warm', priority: 0, shape: sphere(10, 4), params: {exposure: 1, tint: [1, 0.5, 0.25], stars: 0.2, fogDensity: 0.3, fogColor: [1, 0, 0]}};
  expect(blendLook([warm], [100, 0, 0]).params).toEqual(DEFAULT_LOOK);
  const inside = blendLook([warm], [0, 0, 0]).params;
  expect(inside.exposure).toBe(1);
  expect(inside.tint).toEqual([1, 0.5, 0.25]);
  expect(inside.stars).toBeCloseTo(0.2, 12);
  expect(inside.fogColor).toEqual([1, 0, 0]);
  const half = blendLook([warm], [8, 0, 0]).params;
  expect(half.exposure).toBeCloseTo(0.5, 12);
  expect(half.tint[1]).toBeCloseTo(0.75, 12);
  expect(half.stars).toBeCloseTo(0.6, 12);
  expect(half.fogDensity).toBeCloseTo(0.15, 12);
});

test('look blend priority: a higher priority at full weight overrides; equal priorities mix by weight', () => {
  const low: LookVolume = {id: 'low', priority: 0, shape: sphere(100, 10), params: {exposure: -1, stars: 2}};
  const high: LookVolume = {id: 'high', priority: 5, shape: sphere(10, 4), params: {exposure: 1}};
  // Inside both: the high volume wins exposure; it leaves stars out, so stars come from below.
  const both = blendLook([low, high], [0, 0, 0]);
  expect(both.params.exposure).toBe(1);
  expect(both.params.stars).toBe(2);
  expect(both.weights.find(w => w.id === 'high')?.share).toBe(1);
  expect(both.weights.find(w => w.id === 'low')?.share).toBe(0);
  // Order of the list does not matter.
  expect(blendLook([high, low], [0, 0, 0]).params).toEqual(both.params);
  // Half weight of the high volume: half of what the low volume gives.
  const edge = blendLook([low, high], [8, 0, 0]).params;
  expect(edge.exposure).toBeCloseTo(0.5 * 1 + 0.5 * -1, 12);
  // Equal priority: weighted average inside the group; the group covers max(weight).
  const a: LookVolume = {id: 'a', priority: 1, shape: sphere(10, 4), params: {exposure: 2}};
  const b: LookVolume = {id: 'b', priority: 1, shape: sphere(10, 4, [8, 0, 0]), params: {exposure: -2}};
  const mid = blendLook([a, b], [4, 0, 0]);
  expect(mid.params.exposure).toBeCloseTo(0, 12);
  const nearA = blendLook([a, b], [2, 0, 0]);
  // 2 from a and 6 from b: both weights are 1.
  expect(nearA.params.exposure).toBeCloseTo(0, 12);
  const offset = blendLook([a, b], [0, 0, 0]);
  // w_a = 1, w_b = smoothstep(10, 6, 8) = 0.5: average (2 * 1 - 2 * 0.5) / 1.5.
  expect(offset.params.exposure).toBeCloseTo(2 / 3, 12);
  expect(offset.weights.reduce((s, w) => s + w.share, 0)).toBeCloseTo(1, 12);
});

/** Overlapping volumes of every shape and three priorities, for path tests. */
const PATH_VOLUMES: LookVolume[] = [
  {id: 'sun', priority: 2, shape: sphere(40, 20), params: {exposure: 0.6, tint: [1, 0.85, 0.7], stars: 0.2, fogDensity: 0.07, fogColor: [1, 0.6, 0.3]}},
  {id: 'shell', priority: 3, shape: {kind: 'shell', center: [60, 0, 0], inner: 4, outer: 16, edge: 8}, params: {fogDensity: 0.15, fogColor: [0.3, 0.5, 1]}},
  {id: 'deep', priority: 1, shape: {kind: 'shell', center: [0, 0, 0], inner: 80, outer: 200, edge: 30}, params: {exposure: -0.7, stars: 1.9, tint: [0.8, 0.9, 1]}},
  {id: 'disc', priority: 0, shape: {kind: 'box', min: [-50, -50, -3], max: [50, 50, 3], edge: 3}, params: {fogDensity: 0.04, fogColor: [0.9, 0.8, 0.6]}}
];
const PATH = (t: number): V3 => [-10 + 230 * t, 3 * Math.sin(9 * t), 4 - 6 * t];
const KEYS: (keyof LookParams)[] = ['exposure', 'stars', 'fogDensity', 'fogColor', 'tint'];
const flat = (p: LookParams) => KEYS.flatMap(k => (Array.isArray(p[k]) ? (p[k] as number[]) : [p[k] as number]));

test('look blend is continuous along a camera path: the largest step shrinks with the sample spacing', () => {
  const maxStep = (n: number) => {
    let worst = 0;
    let prev = flat(blendLook(PATH_VOLUMES, PATH(0)).params);
    for (let k = 1; k <= n; k++) {
      const next = flat(blendLook(PATH_VOLUMES, PATH(k / n)).params);
      for (let i = 0; i < next.length; i++) worst = Math.max(worst, Math.abs(next[i] - prev[i]));
      prev = next;
    }
    return worst;
  };
  const coarse = maxStep(4000);
  const fine = maxStep(16000);
  // Lipschitz: 4x more samples gives a step about 4x smaller (a jump would not shrink).
  expect(fine).toBeLessThan(coarse / 3);
  expect(fine).toBeLessThan(5e-3);
  // The path does visit the volumes: the parameters change by much more than one step.
  const values = [0, 0.1, 0.3, 0.5, 0.9].map(t => blendLook(PATH_VOLUMES, PATH(t)).params.exposure);
  expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(0.5);
});

test('look blend: no jump across any volume edge', () => {
  const eps = 1e-7;
  const radial = (r: number): V3 => [r, 0, 0.5];
  // The radii of every inner and outer limit of the path volumes along +x.
  for (const r of [20, 40, 64, 72, 76, 80, 110, 170, 200, 47, 50]) {
    const a = flat(blendLook(PATH_VOLUMES, radial(r - eps)).params);
    const b = flat(blendLook(PATH_VOLUMES, radial(r + eps)).params);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-5);
  }
  expect(smoothstep(0, 1, 0)).toBe(0);
  expect(smoothstep(0, 1, 1)).toBe(1);
  expect(smoothstep(1, 0, 0.25)).toBeCloseTo(1 - smoothstep(0, 1, 0.25), 12);
  // Zero slope at both ends of an edge (C1), so the camera feels no kink at entry: 2.5% into a
  // 4-unit edge the weight is below 0.2%.
  expect(weightAt(sphere(10, 4), [9.9, 0, 0])).toBeLessThan(0.002);
  expect(weightAt(sphere(10, 4), [6.1, 0, 0])).toBeGreaterThan(0.998);
});

// ---------- Comet ----------

test('Kepler solver: residual below 1e-12 for e up to 0.9999 and any mean anomaly', () => {
  for (const e of [0, 0.1, 0.5, 0.9, 0.99, 0.999178, 0.9999]) {
    for (let k = -40; k <= 40; k++) {
      const M = k * 0.37 + 1e-4 * k * k;
      const E = solveKepler(M, e);
      const Mr = M - 2 * Math.PI * Math.round(M / (2 * Math.PI));
      expect(Math.abs(E - e * Math.sin(E) - Mr)).toBeLessThan(1e-12);
    }
  }
});

test('NEOWISE: perihelion distance and date from the solver match the JPL elements and the published perihelion', () => {
  // At tp the distance is q exactly.
  expect(Math.abs(cometState(NEOWISE, NEOWISE.tp).r - NEOWISE.q)).toBeLessThan(1e-12);
  // Search the minimum distance over 2020-06-15..07-20 at one-minute steps.
  let best = {jd: 0, r: Infinity};
  for (let jd = 2459015.5; jd < 2459050.5; jd += 1 / 1440) {
    const {r} = cometState(NEOWISE, jd);
    if (r < best.r) best = {jd, r};
  }
  expect(Math.abs(best.jd - NEOWISE.tp)).toBeLessThan(1 / 1440);
  expect(Math.abs(best.r - NEOWISE.q)).toBeLessThan(1e-9);
  // The published perihelion: 2020 July 3.68 TT, q 0.2947 AU. Tolerance 0.01 day and 1e-4 AU.
  expect(Math.abs(best.jd - julianTT(NEOWISE_PERIHELION.date))).toBeLessThan(0.01);
  expect(Math.abs(best.r - NEOWISE_PERIHELION.q)).toBeLessThan(1e-4);
  // Elements: e < 1, q, and a from q / (1 - e) as JPL lists it (358.468 AU).
  expect(NEOWISE.q / (1 - NEOWISE.e)).toBeCloseTo(358.468, 2);
});

test('NEOWISE: the orbit keeps vis-viva energy, the inclination and the node of the JPL elements', () => {
  const a = NEOWISE.q / (1 - NEOWISE.e);
  const mu = GAUSS_K * GAUSS_K;
  let h0: V3 | null = null;
  for (const dt of [-400, -30, -1, 0, 2, 60, 900]) {
    const s = cometState(NEOWISE, NEOWISE.tp + dt);
    const v2 = dot(s.velocity, s.velocity);
    expect(Math.abs(v2 - mu * (2 / s.r - 1 / a)) / v2).toBeLessThan(1e-10);
    expect(norm(s.position)).toBeCloseTo(s.r, 12);
    const h = cross(s.position, s.velocity);
    if (h0) for (let k = 0; k < 3; k++) expect(h[k]).toBeCloseTo(h0[k], 10);
    h0 = h;
  }
  const h = h0 as V3;
  const inclination = Math.acos(h[2] / norm(h)) / DEG;
  expect(inclination).toBeCloseTo(NEOWISE.i, 9);
  const node = (Math.atan2(h[0], -h[1]) / DEG + 360) % 360;
  expect(node).toBeCloseTo(NEOWISE.node, 9);
  // Perihelion direction from the argument of perihelion: the position at tp.
  const p = cometState(NEOWISE, NEOWISE.tp).position;
  const nodeVector: V3 = [Math.cos(NEOWISE.node * DEG), Math.sin(NEOWISE.node * DEG), 0];
  const argPeri = Math.acos(dot(p, nodeVector) / norm(p)) / DEG;
  expect(argPeri).toBeCloseTo(NEOWISE.peri, 8);
});

test('comet tails: the ion tail points straight away from the Sun; the dust tail curves behind, in the orbit plane', () => {
  for (const dt of [-20, 0, 15]) {
    const jd = NEOWISE.tp + dt;
    const s = cometState(NEOWISE, jd);
    const ion = ionTailDirection(s.position);
    expect(dot(ion, s.position) / s.r).toBeCloseTo(1, 12);
    expect(norm(ion)).toBeCloseTo(1, 12);
    const ages = [0, 2, 4, 6, 8, 10, 12];
    const dust = dustTail(NEOWISE, jd, ages, 0.6);
    expect(norm(sub(dust[0], s.position))).toBeLessThan(1e-12);
    const h = cross(s.position, s.velocity);
    const hn = norm(h);
    for (let k = 1; k < dust.length; k++) {
      const d = sub(dust[k], s.position);
      // In the orbit plane (a radial force keeps the grains there).
      expect(Math.abs(dot(d, h)) / hn / norm(d)).toBeLessThan(1e-9);
      // Away from the Sun, and behind the comet: against the transverse direction of motion
      // (the velocity also has a radial part, so the test uses h x r, not v).
      expect(dot(d, ion)).toBeGreaterThan(0);
      expect(dot(d, cross(h, ion))).toBeLessThan(0);
      // Older grains lie farther from the nucleus.
      expect(norm(d)).toBeGreaterThan(norm(sub(dust[k - 1], s.position)));
    }
    // The tail curves away from the anti-solar line, most at perihelion where the comet is fastest.
    const end = sub(dust[dust.length - 1], s.position);
    const bend = Math.acos(dot(end, ion) / norm(end)) / DEG;
    const first = sub(dust[1], s.position);
    expect(bend).toBeGreaterThan(Math.acos(dot(first, ion) / norm(first)) / DEG);
    if (dt === 0) {
      expect(bend).toBeGreaterThan(30);
      expect(bend).toBeLessThan(70);
    }
  }
  // No radiation pressure: the grains stay with the nucleus (checks the integrator). RK4 with 24
  // steps over 10 days through perihelion: under 1e-7 AU (15 km), against tails of 0.1 AU.
  const still = dustTail(NEOWISE, NEOWISE.tp, [5, 10], 0);
  for (const p of still) expect(norm(sub(p, cometState(NEOWISE, NEOWISE.tp).position))).toBeLessThan(1e-7);
});

test('comet activity: 1 at perihelion, falling as r^-4', () => {
  expect(cometActivity(NEOWISE, NEOWISE.q)).toBe(1);
  expect(cometActivity(NEOWISE, 2 * NEOWISE.q)).toBeCloseTo(1 / 16, 12);
  const at = (days: number) => cometActivity(NEOWISE, cometState(NEOWISE, NEOWISE.tp + days).r);
  expect(at(0)).toBeGreaterThan(at(10));
  expect(at(10)).toBeGreaterThan(at(40));
  expect(at(10)).toBeCloseTo(at(-10), 2);
});

// ---------- Dust ----------

test('dust: a floating-origin rebase does not move the dust; a camera move moves it the other way', () => {
  const seeds = dustSeeds(200);
  const eyeAbs: V3 = [1234.5678, -987.25, 42.125];
  const distance = 37;
  const origins: V3[] = [[0, 0, 0], [1200, -1000, 40], [1234.5, -987.25, 42]];
  const reference = dustLevels(eyeAbs, distance);
  for (const origin of origins) {
    // The app hands the absolute eye: relative eye + origin.
    const eyeRel = sub(eyeAbs, origin);
    const levels = dustLevels([eyeRel[0] + origin[0], eyeRel[1] + origin[1], eyeRel[2] + origin[2]], distance);
    for (let l = 0; l < 2; l++) {
      for (let k = 0; k < 200; k++) {
        const a = dustRelative(seeds, k, levels[l]);
        const b = dustRelative(seeds, k, reference[l]);
        expect(norm(sub(a, b))).toBeLessThan(1e-9 * levels[l].cell);
      }
    }
  }
  // Move the camera by a small step: each point moves by minus the step (unless it wraps, where it is faded out).
  const step: V3 = [0.01, -0.02, 0.005];
  const moved = dustLevels([eyeAbs[0] + step[0], eyeAbs[1] + step[1], eyeAbs[2] + step[2]], distance);
  let checked = 0;
  for (let k = 0; k < 200; k++) {
    const a = dustRelative(seeds, k, reference[0]);
    const b = dustRelative(seeds, k, moved[0]);
    if (dustFade(norm(a), reference[0].cell) === 0) continue;
    expect(norm(sub(sub(a, b), step))).toBeLessThan(1e-9);
    checked++;
  }
  expect(checked).toBeGreaterThan(20);
});

test('dust levels: weights add to 1 and change continuously with the camera distance; wraps happen faded out', () => {
  let prev = dustLevels([0, 0, 0], 1);
  for (let d = 1; d < 5000; d *= 1.001) {
    const levels = dustLevels([0, 0, 0], d);
    expect(levels[0].weight + levels[1].weight).toBeCloseTo(1, 12);
    // Weight per cell size: continuous across a level change.
    const byCell = (ls: typeof levels, cell: number) => ls.find(l => Math.abs(l.cell / cell - 1) < 1e-9)?.weight ?? 0;
    for (const l of [...levels, ...prev]) expect(Math.abs(byCell(levels, l.cell) - byCell(prev, l.cell))).toBeLessThan(2e-3);
    prev = levels;
  }
  // A point wraps where one coordinate reaches half a cell: the fade is 0 from there on.
  expect(dustFade(0.5, 1)).toBe(0);
  expect(dustFade(0.3, 1)).toBeGreaterThan(0.5);
  expect(dustFade(0, 1)).toBe(0);
});

// ---------- Gas ----------

test('gas models: Baumbach corona density and the Kelsall zodiacal fan', () => {
  expect(baumbachDensity(1)).toBeCloseTo(1e8 * (0.036 + 1.55 + 2.99), -2);
  expect(baumbachDensity(2)).toBeCloseTo(1e8 * (0.036 / 2 ** 1.5 + 1.55 / 64 + 2.99 / 65536), -2);
  for (let r = 1; r < 10; r += 0.1) expect(baumbachDensity(r + 0.1)).toBeLessThan(baumbachDensity(r));
  expect(kelsallDensity(1, 0)).toBe(1);
  expect(kelsallDensity(2, 0)).toBeCloseTo(2 ** -1.34, 12);
  // Continuous where the fan changes form (zeta = mu).
  expect(Math.abs(kelsallDensity(1, 0.189 - 1e-9) - kelsallDensity(1, 0.189 + 1e-9))).toBeLessThan(1e-7);
  expect(kelsallDensity(1, 0.3)).toBeLessThan(kelsallDensity(1, 0.1));
});
