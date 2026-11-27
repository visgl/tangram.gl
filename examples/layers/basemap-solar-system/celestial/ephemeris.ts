// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Positions of the planets, the Moon and the Galilean moons from Astronomy Engine (MIT):
// HelioVector (truncated VSOP87 for the planets), GeoMoon and JupiterMoons. All in AU, ecliptic
// J2000. Astronomy Engine states an accuracy of about 1 arcminute.

import {GeoMoon, HelioVector, JupiterMoons, PlanetOrbitalPeriod} from 'astronomy-engine';
import type {PlanetId} from './constants';
import {ASTRONOMY_BODY, eqjToEcliptic} from './frames';
import type {V3} from './vector';

export const KM_PER_AU = 149597870.7;

/** Heliocentric position of a planet, AU, ecliptic J2000. */
export function planetPosition(id: PlanetId, date: Date): V3 {
  const v = HelioVector(ASTRONOMY_BODY[id], date);
  return eqjToEcliptic([v.x, v.y, v.z]);
}

/**
 * The orbit of a planet as `n + 1` positions, AU: one orbital period centred on `date`. The
 * first and last points meet up to the perturbations of one period.
 */
export function planetOrbit(id: PlanetId, date: Date, n = 128): V3[] {
  const periodMs = PlanetOrbitalPeriod(ASTRONOMY_BODY[id]) * 86400000;
  const start = date.getTime() - periodMs / 2;
  const points: V3[] = [];
  for (let k = 0; k <= n; k++) points.push(planetPosition(id, new Date(start + (periodMs * k) / n)));
  return points;
}

/** Geocentric position of the Moon, AU, ecliptic J2000. */
export function moonGeocentric(date: Date): V3 {
  const v = GeoMoon(date);
  return eqjToEcliptic([v.x, v.y, v.z]);
}

export const GALILEAN = Object.freeze([
  Object.freeze({id: 'io', label: 'Io', radiusKm: 1821.6, orbitKm: 421800}),
  Object.freeze({id: 'europa', label: 'Europa', radiusKm: 1560.8, orbitKm: 671100}),
  Object.freeze({id: 'ganymede', label: 'Ganymede', radiusKm: 2634.1, orbitKm: 1070400}),
  Object.freeze({id: 'callisto', label: 'Callisto', radiusKm: 2410.3, orbitKm: 1882700})
] as const);

/** Jovicentric offsets of the Galilean moons, AU, ecliptic J2000. */
export function getGalileanOffsets(date: Date): V3[] {
  const moons = JupiterMoons(date);
  return GALILEAN.map(({id}) => {
    const s = moons[id];
    return eqjToEcliptic([s.x, s.y, s.z]);
  });
}
