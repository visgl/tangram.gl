// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Sun, Moon and sky from math.gl `@math.gl/earth/sun`: stars, the Earth's terminator, the Moon
// phase and Saturn's ring radii. Astronomy Engine (MIT) gives an independent sub-solar point to
// check the terminator.

import {getMoonIllumination, getSkySnapshot, getStarLayerData, getStarPositions, getSunTerminator} from '@math.gl/earth/sun';
import {STAR_CATALOG_INFO} from '@math.gl/earth/sun/stars';
import {Body, Equator, MakeTime, Observer, SiderealTime} from 'astronomy-engine';
import {eqjToEcliptic} from './frames';
import {DEG, angleDeg, type V3} from './vector';

export type StarPoint = {position: V3; color: [number, number, number, number]; radius: number};

/** All 7000 catalogue stars on a sphere of `radius`, in the overview frame. */
export function getStarPoints(epochYear: number, radius: number): StarPoint[] {
  const positions = getStarPositions(epochYear);
  // 'equatorial' ignores the `rotation` option, so the frame change is done here.
  const data = getStarLayerData(positions, {
    coordinates: 'equatorial',
    distance: 1,
    radiusScale: 4.5,
    minimumRadiusPixels: 0.8,
    maximumRadiusPixels: 6
  });
  return data.map(d => {
    const p = eqjToEcliptic(d.position);
    return {position: [p[0] * radius, p[1] * radius, p[2] * radius], color: d.color, radius: d.radiusPixels};
  });
}

export const STAR_SOURCE: string = STAR_CATALOG_INFO.source;

/** Sub-solar direction, Earth-fixed (+x Greenwich, +y 90 E, +z north), from getSunTerminator. */
export function getTerminator(date: Date) {
  const t = getSunTerminator(date, {resolution: 360});
  const [x, y, z] = t.sunDirection;
  return {
    sunDirection: t.sunDirection as V3,
    lines: t.geometry.coordinates,
    subSolar: {lat: Math.asin(z) / DEG, lon: Math.atan2(y, x) / DEG}
  };
}

/**
 * Independent check of the terminator: the sub-solar point from Astronomy Engine (apparent
 * equator-of-date Sun, Greenwich apparent sidereal time). Returns the angle between the two
 * sub-solar points, and the largest departure of math.gl's terminator line from 90 deg
 * of the independent sub-solar point.
 */
export function checkTerminator(date: Date) {
  const time = MakeTime(date);
  const sun = Equator(Body.Sun, time, new Observer(0, 0, 0), true, true);
  const lon = (sun.ra - SiderealTime(time)) * 15 * DEG;
  const lat = sun.dec * DEG;
  const reference: V3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const t = getTerminator(date);
  let maxLineError = 0;
  for (const line of t.lines) {
    for (const [lo, la] of line) {
      const p: V3 = [Math.cos(la * DEG) * Math.cos(lo * DEG), Math.cos(la * DEG) * Math.sin(lo * DEG), Math.sin(la * DEG)];
      maxLineError = Math.max(maxLineError, Math.abs(angleDeg(p, reference) - 90));
    }
  }
  return {
    mathgl: t.subSolar,
    astronomyEngine: {lat: lat / DEG, lon: ((lon / DEG + 540) % 360) - 180},
    subSolarErrorDeg: angleDeg(t.sunDirection, reference),
    maxLineErrorDeg: maxLineError
  };
}

const PHASE_NAMES = [
  'New Moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
  'Full Moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'
];
export function getMoonPhase(date: Date) {
  const m = getMoonIllumination(date);
  return {...m, name: PHASE_NAMES[Math.floor(m.phase * 8 + 0.5) % 8]};
}

/**
 * Saturn's ring radii in km. math.gl has the values only inside getSkySnapshot's `rings`
 * (NSSDC Saturnian Rings Fact Sheet: inner edge of the C ring, outer edge of the A ring), so the
 * example reads them from one snapshot.
 */
export const SATURN_RINGS: Readonly<{innerKm: number; outerKm: number}> = (() => {
  const snapshot = getSkySnapshot(Date.UTC(2000, 0, 1), {latitude: 0, longitude: 0, elevation: 0}, {galileanMoons: false});
  const rings = snapshot.planets.find(p => p.name === 'Saturn')?.rings;
  if (!rings) throw new Error('math.gl getSkySnapshot returned no Saturn rings');
  return Object.freeze({innerKm: rings.innerRadius, outerKm: rings.outerRadius});
})();

