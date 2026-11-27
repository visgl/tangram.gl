// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// A comet on a two-body (Kepler) orbit, with its two tails.
//
// Elements: comet C/2020 F3 (NEOWISE), JPL Small-Body Database (ssd.jpl.nasa.gov/tools/sbdb_lookup),
// orbit solution JPL 31 (solution date 2024-07-30, 1225 observations 2020-03-27 to 2021-06-08),
// osculating at epoch JD 2459036.5 TDB (2020-07-06.0). Heliocentric ecliptic J2000. Copied into
// the code; the example does not call the API.
//
// The orbit is two-body only (no planetary perturbations, no non-gravitational forces). The epoch
// is three days after perihelion, so near perihelion the error is small; decades away it grows.

import {getDaysTT} from './time';
import type {V3} from './vector';

/** Gaussian gravitational constant, rad/day: GM of the Sun = k^2 AU^3/day^2. */
export const GAUSS_K = 0.01720209895;
const MU = GAUSS_K * GAUSS_K;
const DEG = Math.PI / 180;
/** Julian date (TT) of J2000.0. */
const JD_J2000 = 2451545.0;

export type CometElements = {
  readonly name: string;
  /** Eccentricity (elliptic only: e < 1). */
  readonly e: number;
  /** Perihelion distance, AU. */
  readonly q: number;
  /** Inclination, ascending node and argument of perihelion, deg, ecliptic J2000. */
  readonly i: number;
  readonly node: number;
  readonly peri: number;
  /** Time of perihelion passage, Julian date TDB. */
  readonly tp: number;
  /** Osculating epoch, Julian date TDB. */
  readonly epoch: number;
  readonly source: string;
};

export const NEOWISE: CometElements = Object.freeze({
  name: 'C/2020 F3 (NEOWISE)',
  e: 0.9991780262531292,
  q: 0.2946512493809196,
  i: 128.9375027594809,
  node: 61.01042818536988,
  peri: 37.2786584481257,
  tp: 2459034.178898044365,
  epoch: 2459036.5,
  source: 'JPL Small-Body Database, C/2020 F3 (NEOWISE), solution JPL 31, epoch JD 2459036.5 TDB'
});

/**
 * The published perihelion of C/2020 F3, as the orbit catalogues round it: 2020 July 3.68 TT
 * (16:16 UTC) at q = 0.2947 AU. The tests compare the solver with it.
 */
export const NEOWISE_PERIHELION = Object.freeze({date: new Date(Date.UTC(2020, 6, 3, 16, 18) - 69184), q: 0.2947});

/** Julian date (TT, used as TDB: they differ by under 2 ms) of a date. */
export const julianTT = (date: Date) => JD_J2000 + getDaysTT(date);

/** Solves Kepler's equation M = E - e sin E for the eccentric anomaly E (elliptic, e < 1). */
export function solveKepler(meanAnomaly: number, e: number): number {
  // Reduce M to [-pi, pi]: the solution is odd and 2 pi-periodic.
  const M = meanAnomaly - 2 * Math.PI * Math.round(meanAnomaly / (2 * Math.PI));
  // Start of Danby (1987): converges for every e < 1.
  let E = M + 0.85 * e * Math.sign(Math.sin(M) || 1);
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - M;
    const step = f / (1 - e * Math.cos(E));
    E -= step;
    if (Math.abs(step) < 1e-15) break;
  }
  return E;
}

export type OrbitState = {position: V3; velocity: V3; r: number};

/** Heliocentric position (AU) and velocity (AU/day), ecliptic J2000, at a Julian date TDB. */
export function cometState(el: CometElements, jd: number): OrbitState {
  const a = el.q / (1 - el.e);
  const n = GAUSS_K / Math.sqrt(a * a * a);
  const E = solveKepler(n * (jd - el.tp), el.e);
  const b = a * Math.sqrt(1 - el.e * el.e);
  // In the orbit plane: x toward perihelion.
  const x = a * (Math.cos(E) - el.e);
  const y = b * Math.sin(E);
  const r = a * (1 - el.e * Math.cos(E));
  const vx = (-a * n * a * Math.sin(E)) / r;
  const vy = (b * n * a * Math.cos(E)) / r;
  const [O, w, i] = [el.node * DEG, el.peri * DEG, el.i * DEG];
  const [cO, sO, cw, sw, ci, si] = [Math.cos(O), Math.sin(O), Math.cos(w), Math.sin(w), Math.cos(i), Math.sin(i)];
  const P: V3 = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q: V3 = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  const comb = (u: number, v: number): V3 => [P[0] * u + Q[0] * v, P[1] * u + Q[1] * v, P[2] * u + Q[2] * v];
  return {position: comb(x, y), velocity: comb(vx, vy), r};
}

/**
 * Activity of the comet, 0-1: 1 at perihelion, falling as r^-4 (a common exponent of the total
 * magnitude law m = H + 5 log D + 2.5 n log r, with n = 4). Below 1e-3 the tails are not drawn.
 */
export const cometActivity = (el: CometElements, r: number) => Math.min(1, (el.q / r) ** 4);

/**
 * The ion (plasma) tail points straight away from the Sun: the solar wind carries the ions at
 * some 400 km/s, much faster than the comet moves, so the tail follows the anti-solar direction.
 */
export const ionTailDirection = (position: readonly number[]): V3 => {
  const r = Math.hypot(position[0], position[1], position[2]);
  return [position[0] / r, position[1] / r, position[2] / r];
};

/**
 * The dust tail as a syndyne: grains of one radiation-pressure ratio `beta` that left the nucleus
 * `age` days ago and moved under the reduced solar gravity (1 - beta) GM since. Each point is
 * integrated (RK4) from the comet's state at its release time, so the tail curves behind the
 * comet in the orbit plane. Returns heliocentric AU, one point per age.
 */
export function dustTail(el: CometElements, jd: number, ages: readonly number[], beta = 0.6, stepsPerPoint = 24): V3[] {
  const mu = MU * (1 - beta);
  const accel = (p: readonly number[]): V3 => {
    const r = Math.hypot(p[0], p[1], p[2]);
    const k = -mu / (r * r * r);
    return [p[0] * k, p[1] * k, p[2] * k];
  };
  return ages.map(age => {
    if (age <= 0) return cometState(el, jd).position;
    const s0 = cometState(el, jd - age);
    let p = [...s0.position];
    let v = [...s0.velocity];
    const h = age / stepsPerPoint;
    for (let k = 0; k < stepsPerPoint; k++) {
      const a1 = accel(p);
      const p2 = p.map((x, j) => x + (h / 2) * v[j]), v2 = v.map((x, j) => x + (h / 2) * a1[j]);
      const a2 = accel(p2);
      const p3 = p.map((x, j) => x + (h / 2) * v2[j]), v3 = v.map((x, j) => x + (h / 2) * a2[j]);
      const a3 = accel(p3);
      const p4 = p.map((x, j) => x + h * v3[j]), v4 = v.map((x, j) => x + h * a3[j]);
      const a4 = accel(p4);
      p = p.map((x, j) => x + (h / 6) * (v[j] + 2 * v2[j] + 2 * v3[j] + v4[j]));
      v = v.map((x, j) => x + (h / 6) * (a1[j] + 2 * a2[j] + 2 * a3[j] + a4[j]));
    }
    return p as V3;
  });
}

/** Points of the orbit (AU) over one revolution centred on perihelion, `n + 1` of them, by eccentric anomaly. */
export function cometOrbit(el: CometElements, n = 256, maxE = Math.PI * 0.995): V3[] {
  const a = el.q / (1 - el.e);
  const nMotion = GAUSS_K / Math.sqrt(a * a * a);
  const points: V3[] = [];
  for (let k = 0; k <= n; k++) {
    const E = -maxE + (2 * maxE * k) / n;
    const M = E - el.e * Math.sin(E);
    points.push(cometState(el, el.tp + M / nMotion).position);
  }
  return points;
}
