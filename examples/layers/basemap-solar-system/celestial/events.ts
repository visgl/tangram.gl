// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Events on the time line: solar and lunar eclipses, and the perihelion of the comet. An eclipse
// can occur only at a new or a full moon, so the search finds each one (the Moon's ecliptic
// longitude from the Sun crosses 0 or 180 deg), takes the time of the best alignment near it, and
// asks the shadow geometry of the scene (./shadows) whether a shadow reaches the body then. The
// marks therefore agree with what the scene draws.

import {NEOWISE} from './comet';
import {SATURN_RINGS} from './sun';
import {moonGeocentric, planetPosition} from './ephemeris';
import {getShadowGeometry, sphereVisibility, visibleFractionAt, type ShadowGeometry} from './shadows';
import {dot, norm, unit, type V3} from './vector';

export type SkyEventKind = 'solar-eclipse' | 'lunar-eclipse' | 'comet-perihelion';
export type SkyEvent = {
  kind: SkyEventKind;
  date: Date;
  label: string;
  /** A total or annular solar eclipse, a total lunar eclipse, or the perihelion. */
  major: boolean;
};

/** Perihelion of the comet: its elements give a Julian date in TDB, 69.184 s ahead of UTC. */
export const COMET_PERIHELION_DATE = new Date(Date.UTC(2000, 0, 1, 12) + (NEOWISE.tp - 2451545) * 86400000 - 69184);

const HOUR_MS = 3600000;
/** Search step: the Moon moves about 3 deg in 6 h, so no new or full moon is missed. */
const STEP_MS = 6 * HOUR_MS;
/** The best alignment is within a few hours of the new or full moon. */
const ALIGN_WINDOW_MS = 4 * HOUR_MS;
/** Fraction of the solar disc below which a point is in the umbra. */
const UMBRA = 1e-3;

/** Sine and cosine of the Moon's ecliptic longitude from the Sun, seen from the Earth. */
function elongation(time: number): {sin: number; cos: number} {
  const date = new Date(time);
  const earth = planetPosition('earth', date);
  const moon = moonGeocentric(date);
  const sx = -earth[0], sy = -earth[1];
  return {sin: sx * moon[1] - sy * moon[0], cos: sx * moon[0] + sy * moon[1]};
}

/** Angle, rad, between the Moon and the Sun (new moon) or the anti-solar point (full moon). */
function misalignment(time: number, full: boolean): number {
  const date = new Date(time);
  const earth = planetPosition('earth', date);
  const k = full ? 1 : -1;
  const axis = unit([k * earth[0], k * earth[1], k * earth[2]]);
  return Math.acos(Math.max(-1, Math.min(1, dot(axis, unit(moonGeocentric(date))))));
}

/** Time of the smallest misalignment near a new or full moon (ternary search, to about 1 min). */
function bestAlignment(time: number, full: boolean): number {
  let lo = time - ALIGN_WINDOW_MS, hi = time + ALIGN_WINDOW_MS;
  while (hi - lo > 60000) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (misalignment(a, full) < misalignment(b, full)) hi = b;
    else lo = a;
  }
  return (lo + hi) / 2;
}

/** Solar eclipse type: the axis of the Moon's shadow meets the Earth (total, annular) or not (partial). */
function solarType(geometry: ShadowGeometry): 'Total' | 'Annular' | 'Partial' {
  const moon = geometry.occluders[0].center;
  const u = unit([moon[0] - geometry.sun[0], moon[1] - geometry.sun[1], moon[2] - geometry.sun[2]]);
  // The axis m + t u against the unit sphere (the flattening moves the limit by under 0.4 %).
  const b = dot(moon, u);
  const disc = b * b - (dot(moon, moon) - 1);
  if (disc <= 0) return 'Partial';
  const t = -b - Math.sqrt(disc);
  const hit: V3 = [moon[0] + t * u[0], moon[1] + t * u[1], moon[2] + t * u[2]];
  return visibleFractionAt(geometry, hit) < UMBRA ? 'Total' : 'Annular';
}

/** Lunar eclipse type: the umbra of the Earth covers the Moon (total), touches it (partial) or not (penumbral). */
function lunarType(geometry: ShadowGeometry): 'Total' | 'Partial' | 'Penumbral' {
  const earth = geometry.occluders[0];
  const u = unit([earth.center[0] - geometry.sun[0], earth.center[1] - geometry.sun[1], earth.center[2] - geometry.sun[2]]);
  // From the shadow axis to the Moon's centre (the origin), in Moon radii.
  const along = -dot(earth.center, u);
  const off: V3 = [-earth.center[0] - along * u[0], -earth.center[1] - along * u[1], -earth.center[2] - along * u[2]];
  const n: V3 = norm(off) > 1e-9 ? unit(off) : unit([u[1], -u[0], 0]);
  const light = (p: V3) => sphereVisibility(p, geometry.sun, geometry.sunRadius, earth);
  // The limb points farthest from the axis and nearest to it.
  if (light(n) < UMBRA) return 'Total';
  return light([-n[0], -n[1], -n[2]]) < UMBRA ? 'Partial' : 'Penumbral';
}

/** The eclipse at a new or full moon, if the shadow geometry of the scene has one then. */
function eclipseAt(time: number, full: boolean): SkyEvent | null {
  const date = new Date(bestAlignment(time, full));
  const geometry = getShadowGeometry(full ? 'moon' : 'earth', date, SATURN_RINGS);
  if (!geometry?.occluders.length) return null;
  if (full) {
    const type = lunarType(geometry);
    return {kind: 'lunar-eclipse', date, label: `${type} lunar eclipse`, major: type === 'Total'};
  }
  const type = solarType(geometry);
  return {kind: 'solar-eclipse', date, label: `${type} solar eclipse`, major: type !== 'Partial'};
}

/** Solar and lunar eclipses between two dates, in time order. */
export function findEclipses(from: Date, to: Date): SkyEvent[] {
  const events: SkyEvent[] = [];
  let t0 = from.getTime() - STEP_MS;
  let e0 = elongation(t0);
  for (let t1 = t0 + STEP_MS; t1 <= to.getTime() + STEP_MS; t1 += STEP_MS) {
    const e1 = elongation(t1);
    // sin crosses zero at a new moon (cos > 0) and at a full moon (cos < 0).
    if (e0.sin * e1.sin <= 0 && e0.cos * e1.cos > 0) {
      let lo = t0, hi = t1, sinLo = e0.sin;
      while (hi - lo > 60000) {
        const mid = (lo + hi) / 2;
        const sinMid = elongation(mid).sin;
        if (sinLo * sinMid <= 0) hi = mid;
        else {
          lo = mid;
          sinLo = sinMid;
        }
      }
      const event = eclipseAt((lo + hi) / 2, e0.cos < 0);
      if (event && event.date >= from && event.date <= to) events.push(event);
    }
    t0 = t1;
    e0 = e1;
  }
  return events;
}

/** The eclipses and the comet's perihelion between two dates, in time order. */
export function findSkyEvents(from: Date, to: Date): SkyEvent[] {
  const events = findEclipses(from, to);
  const perihelion = COMET_PERIHELION_DATE;
  if (perihelion >= from && perihelion <= to) {
    events.push({kind: 'comet-perihelion', date: perihelion, label: `${NEOWISE.name} at perihelion`, major: true});
  }
  return events.sort((a, b) => a.date.getTime() - b.date.getTime());
}
