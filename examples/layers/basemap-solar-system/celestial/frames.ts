// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Frames. The scene frame is heliocentric ecliptic J2000 (x = vernal equinox, z = ecliptic
// north). math.gl and Astronomy Engine give equatorial J2000 (EQJ) vectors; eqjToEcliptic turns
// them into the scene frame: a rotation about +x by the J2000 mean obliquity,
// x' = x, y' = y cos e + z sin e, z' = -y sin e + z cos e, e = 23.4392911 deg (IAU 1976).

import {Body, RotationAxis} from 'astronomy-engine';
import type {BodyId} from './constants';
import {DEG, type V3} from './vector';

const OBLIQUITY_J2000 = 23.4392911 * DEG;
const CE = Math.cos(OBLIQUITY_J2000);
const SE = Math.sin(OBLIQUITY_J2000);

/** Equatorial J2000 to ecliptic J2000. */
export function eqjToEcliptic(v: readonly number[]): V3 {
  return [v[0], CE * v[1] + SE * v[2], -SE * v[1] + CE * v[2]];
}

/** Ecliptic J2000 to equatorial J2000. */
export function eclipticToEqj(v: readonly number[]): V3 {
  return [v[0], CE * v[1] - SE * v[2], SE * v[1] + CE * v[2]];
}

const ASTRONOMY_BODY: Readonly<Record<BodyId, Body>> = Object.freeze({
  sun: Body.Sun, mercury: Body.Mercury, venus: Body.Venus, earth: Body.Earth, moon: Body.Moon,
  mars: Body.Mars, jupiter: Body.Jupiter, saturn: Body.Saturn, uranus: Body.Uranus, neptune: Body.Neptune
});

/**
 * Body-fixed axes in the ecliptic J2000 frame, as the columns x, y, z (x = prime meridian,
 * z = north pole): Astronomy Engine RotationAxis (IAU WGCCRE 2015 pole and prime meridian).
 */
export function getBodyAxes(id: BodyId, date: Date): [V3, V3, V3] {
  const axis = RotationAxis(ASTRONOMY_BODY[id], date);
  const ra = axis.ra * 15 * DEG;
  const dec = axis.dec * DEG;
  const w = axis.spin * DEG;
  const x0 = [-Math.sin(ra), Math.cos(ra), 0];
  const y0 = [-Math.sin(dec) * Math.cos(ra), -Math.sin(dec) * Math.sin(ra), Math.cos(dec)];
  const x = x0.map((v, i) => v * Math.cos(w) + y0[i] * Math.sin(w));
  const y = x0.map((v, i) => -v * Math.sin(w) + y0[i] * Math.cos(w));
  return [eqjToEcliptic(x), eqjToEcliptic(y), eqjToEcliptic([axis.north.x, axis.north.y, axis.north.z])];
}

/** The north pole of a body: right ascension and declination (EQJ), degrees. */
export function getPole(id: BodyId, date: Date): {ra: number; dec: number} {
  const axis = RotationAxis(ASTRONOMY_BODY[id], date);
  return {ra: axis.ra * 15, dec: axis.dec};
}

export {ASTRONOMY_BODY};
