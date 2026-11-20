// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The eclipse-shadow math of the solar-system example, against geometry with a known answer and
// against Astronomy Engine's eclipse searches.

import {Body, GeoVector, SearchGlobalSolarEclipse, SearchLunarEclipse} from 'astronomy-engine';
import {expect, test} from 'vitest';
import {
  SPEED_OF_LIGHT_KM_S,
  LUNAR_UMBRA_TINT,
  discVisibleFraction,
  geodeticNormal,
  lightAt,
  surfacePoint,
  getShadowGeometry,
  ringTransmission,
  sphereVisibility,
  visibleFractionAt,
  type ShadowGeometry
} from '../examples/layers/basemap-solar-system/celestial/shadows';
import {KM_PER_AU} from '../examples/layers/basemap-solar-system/celestial/ephemeris';
import {PHYSICAL_CONSTANTS} from '../examples/layers/basemap-solar-system/celestial/constants';
import type {V3} from '../examples/layers/basemap-solar-system/celestial/vector';

/** Saturn's ring radii as math.gl gives them (NSSDC: C ring inner edge, A ring outer edge). */
const RINGS = {innerKm: 74500, outerKm: 136780};
const DEG = Math.PI / 180;
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const unitV = (a: readonly number[]): V3 => [a[0] / len(a), a[1] / len(a), a[2] / len(a)];
const minutes = (ms: number) => ms / 60000;

/** Monte Carlo reference: the fraction of a unit disc outside a disc of radius ro at distance d. */
function sampledFraction(ro: number, d: number, n = 400) {
  let inside = 0, visible = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = -1 + (2 * (i + 0.5)) / n, y = -1 + (2 * (j + 0.5)) / n;
      if (x * x + y * y > 1) continue;
      inside++;
      if ((x - d) ** 2 + y * y > ro * ro) visible++;
    }
  }
  return visible / inside;
}

test('visible disc fraction: 0 in the umbra, 1 outside the penumbra, monotonic between', () => {
  // Umbra: the occluder disc covers the light disc.
  expect(discVisibleFraction(1.05, 0)).toBe(0);
  expect(discVisibleFraction(1.05, 0.04)).toBe(0);
  // Antumbra: an annulus stays.
  expect(discVisibleFraction(0.9, 0.05)).toBeCloseTo(1 - 0.81, 12);
  // Outside the penumbra.
  expect(discVisibleFraction(1.05, 2.05)).toBe(1);
  expect(discVisibleFraction(0.3, 1.31)).toBe(1);
  for (const ro of [0.3, 0.97, 1.03, 3.6]) {
    let last = -1;
    for (let k = 0; k <= 400; k++) {
      const d = (k / 400) * (1 + ro + 0.2);
      const v = discVisibleFraction(ro, d);
      expect(v).toBeGreaterThanOrEqual(last - 1e-12);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      last = v;
    }
    // Strictly inside the penumbra the fraction is strictly between the two limits.
    const mid = discVisibleFraction(ro, (Math.abs(1 - ro) + 1 + ro) / 2);
    expect(mid).toBeGreaterThan(ro >= 1 ? 0 : 1 - ro * ro);
    expect(mid).toBeLessThan(1);
  }
  // The lens area against a sampled overlap.
  for (const [ro, d] of [[1.03, 0.6], [0.27, 0.9], [3.6, 3.1], [0.97, 1.5]]) {
    expect(Math.abs(discVisibleFraction(ro, d) - sampledFraction(ro, d))).toBeLessThan(2e-3);
  }
});

test('sphere occluder: a point on the axis behind the Moon is in the umbra, a far point is lit', () => {
  // Units: Earth radii, Sun on +x at 1 AU, Moon at 56 radii on the same line (inside the Moon's
  // umbra, which is about 58.6 Earth radii long; at 60 radii the point is in the antumbra).
  const re = PHYSICAL_CONSTANTS.earth.radiusKm;
  const sun: V3 = [KM_PER_AU / re, 0, 0];
  const moon = {id: 'moon', center: [56, 0, 0] as V3, radius: 1737.4 / re, zScale: 1, tint: [0, 0, 0] as V3};
  const rs = PHYSICAL_CONSTANTS.sun.radiusKm / re;
  expect(sphereVisibility([1, 0, 0], sun, rs, moon)).toBe(0);
  expect(sphereVisibility([0, 1, 0], sun, rs, moon)).toBe(1);
  const annular = {...moon, center: [61, 0, 0] as V3};
  expect(sphereVisibility([1, 0, 0], sun, rs, annular)).toBeGreaterThan(0);
  expect(sphereVisibility([1, 0, 0], sun, rs, annular)).toBeLessThan(0.1);
  // Through the penumbra the light rises with the distance from the axis.
  let last = -1;
  for (let y = 0; y <= 0.8; y += 0.01) {
    const v = sphereVisibility([1, y, 0], sun, rs, moon);
    expect(v).toBeGreaterThanOrEqual(last - 1e-9);
    last = v;
  }
  expect(last).toBe(1);
  // An occluder beyond the Sun casts nothing, even when its disc is centred on the Sun's.
  const beyond = {...moon, center: [2 * sun[0], 0, 0] as V3, radius: 11};
  expect(sphereVisibility([1, 0, 0], sun, rs, beyond)).toBe(1);
});

test('surface point at a geodetic direction lies on the ellipsoid, with that normal', () => {
  const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
  for (const lat of [-80, -33, 0, 25.3, 61, 89]) {
    const n = geodeticNormal(lat, 40);
    const p = surfacePoint(n, e2);
    expect(p[0] ** 2 + p[1] ** 2 + p[2] ** 2 / (1 - e2)).toBeCloseTo(1, 12);
    // The ellipsoid normal (gradient) is parallel to n.
    const g = unitV([p[0], p[1], p[2] / (1 - e2)]);
    expect(dot(g, n)).toBeCloseTo(1, 12);
  }
});

/**
 * Where the shadow axis (the line from the Sun's centre through the occluder's centre) meets the
 * receiver's ellipsoid, as geodetic latitude and longitude: z is scaled so that the ellipsoid is
 * the unit sphere (as Astronomy Engine's GeoidIntersect does).
 */
function axisPoint(g: ShadowGeometry) {
  const occ = g.occluders[0];
  const k = Math.sqrt(1 - g.e2);
  const q = (v: readonly number[]): V3 => [v[0], v[1], v[2] / k];
  const o = q(occ.center), dir = unitV(sub(o, q(g.sun)));
  const b = dot(o, dir), c = dot(o, o) - 1;
  const t = -b - Math.sqrt(b * b - c);
  const p: V3 = [o[0] + t * dir[0], o[1] + t * dir[1], (o[2] + t * dir[2]) * k];
  const lat = Math.atan(p[2] / (Math.hypot(p[0], p[1]) * (1 - g.e2))) / DEG;
  return {lat, lon: Math.atan2(p[1], p[0]) / DEG};
}

test('total solar eclipse of 2024-04-08: central point at maximum against Astronomy Engine', () => {
  const eclipse = SearchGlobalSolarEclipse(new Date('2024-04-01T00:00:00Z'));
  expect(eclipse.kind).toBe('total');
  const g = getShadowGeometry('earth', eclipse.peak.date, RINGS) as ShadowGeometry;
  expect(g.occluders.map(o => o.id)).toEqual(['moon']);
  const point = axisPoint(g);
  // Astronomy Engine: 25.29 N, 104.14 W at 18:17:19 UTC. Tolerance 0.02 deg (about 2 km).
  expect(Math.abs(point.lat - (eclipse.latitude as number))).toBeLessThan(0.02);
  expect(Math.abs(point.lon - (eclipse.longitude as number))).toBeLessThan(0.02);
  // Total there; lit outside the penumbra (the Moon's penumbra is about 3500 km in radius).
  expect(visibleFractionAt(g, geodeticNormal(point.lat, point.lon))).toBe(0);
  expect(visibleFractionAt(g, geodeticNormal(point.lat - 45, point.lon))).toBe(1);
  // 10 deg away (about 1100 km) the eclipse is partial.
  const partial = visibleFractionAt(g, geodeticNormal(point.lat + 10, point.lon));
  expect(partial).toBeGreaterThan(0);
  expect(partial).toBeLessThan(1);
  // The light factor on the map: the umbra keeps the tint; the penumbra is gamma-encoded.
  expect(lightAt(g, surfacePoint(geodeticNormal(point.lat, point.lon), g.e2))).toEqual(g.occluders[0].tint);
  const n = surfacePoint(geodeticNormal(point.lat + 10, point.lon), g.e2);
  const tint = g.occluders[0].tint[0];
  expect(lightAt(g, n)[0]).toBeCloseTo(tint + (1 - tint) * partial ** (1 / 2.2), 12);
  console.log(`solar 2024-04-08: model ${point.lat.toFixed(3)}, ${point.lon.toFixed(3)}; Astronomy Engine ${eclipse.latitude?.toFixed(3)}, ${eclipse.longitude?.toFixed(3)}`);
});

test('the clouds take the same 2024-04-08 shadow, as a factor on linear light', () => {
  const eclipse = SearchGlobalSolarEclipse(new Date('2024-04-01T00:00:00Z'));
  const g = getShadowGeometry('earth', eclipse.peak.date, RINGS) as ShadowGeometry;
  const point = axisPoint(g);
  const at = (dLat: number) => surfacePoint(geodeticNormal(point.lat + dLat, point.lon), g.e2);
  const tint = g.occluders[0].tint;
  // The umbra keeps only the tint: the clouds there are as dark as the ground.
  expect(lightAt(g, at(0), 'linear')).toEqual(tint);
  // The penumbra: the visible fraction itself, not gamma-encoded, so darker than the map factor.
  for (const dLat of [2, 5, 10, 20]) {
    const v = visibleFractionAt(g, geodeticNormal(point.lat + dLat, point.lon));
    const linear = lightAt(g, at(dLat), 'linear');
    const srgb = lightAt(g, at(dLat));
    for (let c = 0; c < 3; c++) {
      expect(linear[c]).toBeCloseTo(tint[c] + (1 - tint[c]) * v, 12);
      expect(linear[c]).toBeLessThan(srgb[c]);
    }
  }
  // It dims smoothly: the light grows with the distance from the axis.
  const profile = [0, 1, 2, 4, 8, 16, 32].map(dLat => lightAt(g, at(dLat), 'linear')[0]);
  for (let i = 1; i < profile.length; i++) expect(profile[i]).toBeGreaterThan(profile[i - 1]);
  // Outside the penumbra: no change.
  expect(lightAt(g, at(-45), 'linear')).toEqual([1, 1, 1]);
});

/** Lowest and highest light on the Moon's limb as the Sun sees it (the circle nearest the shadow axis). */
function moonLimb(date: Date) {
  const g = getShadowGeometry('moon', date, RINGS) as ShadowGeometry;
  if (!g.occluders.length) return {min: 1, max: 1, centre: 1};
  const s = unitV(g.sun);
  const a = unitV(Math.abs(s[2]) < 0.9 ? [-s[1], s[0], 0] : [0, -s[2], s[1]]);
  const b: V3 = [s[1] * a[2] - s[2] * a[1], s[2] * a[0] - s[0] * a[2], s[0] * a[1] - s[1] * a[0]];
  let min = 1, max = 0;
  for (let k = 0; k < 1440; k++) {
    const t = (2 * Math.PI * k) / 1440;
    // Just sunward of the limb, so that the Sun is above the horizon there.
    const n: V3 = [0, 1, 2].map(i => a[i] * Math.cos(t) + b[i] * Math.sin(t) + 1e-3 * s[i]) as V3;
    const v = visibleFractionAt(g, n);
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return {min, max, centre: visibleFractionAt(g, s)};
}
/** First time in [t0, t1] at which `test` holds (it is false at t0 and true at t1). */
function bisect(t0: number, t1: number, test: (t: number) => boolean) {
  for (let i = 0; i < 40; i++) {
    const t = (t0 + t1) / 2;
    if (test(t)) t1 = t;
    else t0 = t;
  }
  return t1;
}

test('total lunar eclipse of 2025-03-14: umbra and penumbra contacts against Astronomy Engine', () => {
  const eclipse = SearchLunarEclipse(new Date('2025-03-01T00:00:00Z'));
  expect(eclipse.kind).toBe('total');
  const peak = eclipse.peak.date.getTime();
  const at = (t: number) => moonLimb(new Date(t));
  expect(at(peak).max).toBe(0);
  expect(at(peak).centre).toBe(0);
  const peakGeometry = getShadowGeometry('moon', eclipse.peak.date, RINGS) as ShadowGeometry;
  expect(lightAt(peakGeometry, unitV(peakGeometry.sun))).toEqual(LUNAR_UMBRA_TINT);
  // The Earth's umbra on the Moon is red: refracted light keeps more red than blue.
  expect(LUNAR_UMBRA_TINT[0]).toBeGreaterThan(2 * LUNAR_UMBRA_TINT[1]);
  expect(LUNAR_UMBRA_TINT[0]).toBeGreaterThan(2 * LUNAR_UMBRA_TINT[2]);
  const minute = 60000;
  // Penumbral contact (P1), umbral contact (U1), start of totality (U2).
  const p1 = bisect(peak - 240 * minute, peak, t => at(t).min < 1);
  const u1 = bisect(peak - 240 * minute, peak, t => at(t).min === 0);
  const u2 = bisect(peak - 240 * minute, peak, t => at(t).max === 0);
  const ae = {p1: peak - eclipse.sd_penum * minute, u1: peak - eclipse.sd_partial * minute, u2: peak - eclipse.sd_total * minute};
  const errors = {p1: minutes(p1 - ae.p1), u1: minutes(u1 - ae.u1), u2: minutes(u2 - ae.u2)};
  console.log(`lunar 2025-03-14 contact errors, min: ${JSON.stringify(errors)}`);
  // Tolerance 1 minute: the Moon moves about 0.55 km/s against the shadow, 1 min = 33 km.
  for (const e of Object.values(errors)) expect(Math.abs(e)).toBeLessThan(1);
});

/** When the ray from the Sun's centre through the moon's centre meets Jupiter's ellipsoid. */
function shadowOnDisc(g: ShadowGeometry, id: string) {
  const occ = g.occluders.find(o => o.id === id);
  if (!occ) return false;
  const f = PHYSICAL_CONSTANTS.jupiter.flattening;
  const q = (v: V3): V3 => [v[0], v[1], v[2] / (1 - f)];
  const o = q(occ.center), dir = unitV(sub(o, q(g.sun)));
  const tc = -dot(o, dir);
  if (tc < 0) return false;
  const closest = [o[0] + tc * dir[0], o[1] + tc * dir[1], o[2] + tc * dir[2]];
  return len(closest) < 1;
}

test('triple shadow transit on Jupiter, 2015-01-24, against the published times', () => {
  // Sky & Telescope: the shadows of Io, Europa and Callisto are all on the disc 06:28-06:52 UT
  // (times at the Earth). The scene is at Jupiter's time: add the light time to the Earth.
  const t0 = Date.UTC(2015, 0, 24, 4, 0), t1 = Date.UTC(2015, 0, 24, 8, 0);
  const lightMs = (GeoVector(Body.Jupiter, new Date(t0 + 2.5 * 3600000), false).Length() * KM_PER_AU * 1000) / SPEED_OF_LIGHT_KM_S;
  const allThree = (t: number) => {
    const g = getShadowGeometry('jupiter', new Date(t - lightMs), RINGS) as ShadowGeometry;
    return ['io', 'europa', 'callisto'].every(id => shadowOnDisc(g, id));
  };
  let first = 0, last = 0;
  for (let t = t0; t <= t1; t += 30000) {
    if (allThree(t)) {
      if (!first) first = t;
      last = t;
    }
  }
  const start = bisect(first - 30000, first, allThree);
  const end = bisect(last, last + 30000, t => !allThree(t));
  const errors = {start: minutes(start - Date.UTC(2015, 0, 24, 6, 28)), end: minutes(end - Date.UTC(2015, 0, 24, 6, 52))};
  console.log(`triple transit: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}, errors min ${JSON.stringify(errors)}, light time ${(lightMs / 60000).toFixed(1)} min`);
  // Tolerance 3 minutes: the published times are to the minute, and they are for the shadow
  // seen from the Earth, 3 deg off the Sun's direction near opposition.
  expect(Math.abs(errors.start)).toBeLessThan(3);
  expect(Math.abs(errors.end)).toBeLessThan(3);
  // In the middle every one of the three has an umbra on the dayside.
  const g = getShadowGeometry('jupiter', new Date((start + end) / 2 - lightMs), RINGS) as ShadowGeometry;
  for (const id of ['io', 'europa', 'callisto']) {
    const occ = g.occluders.find(o => o.id === id)!;
    const one = {...g, occluders: [occ]};
    const s = unitV(sub(occ.center, g.sun));
    // The axis point on the surface: step back along the axis from the moon to the ellipsoid.
    let lo = 0, hi = len(occ.center) + 2;
    const inside = (t: number) => {
      const p = [occ.center[0] + s[0] * t, occ.center[1] + s[1] * t, (occ.center[2] + s[2] * t) / (1 - PHYSICAL_CONSTANTS.jupiter.flattening)];
      return len(p) <= 1;
    };
    for (let i = 0; i < 60; i++) {
      const t = (lo + hi) / 2;
      if (inside(t)) hi = t;
      else lo = t;
    }
    const p: V3 = [occ.center[0] + s[0] * hi, occ.center[1] + s[1] * hi, occ.center[2] + s[2] * hi];
    expect(sphereVisibility(p, one.sun, one.sunRadius, occ)).toBe(0);
  }
});

test("Saturn's shadow edge on its rings, and the rings' shadow on Saturn", () => {
  const date = new Date('2017-06-01T00:00:00Z');
  const rings = getShadowGeometry('saturn', date, RINGS, 'rings') as ShadowGeometry;
  const s = unitV(rings.sun);
  const sinB = Math.abs(s[2]);
  expect(sinB).toBeGreaterThan(0.2);
  // Ring point straight behind the planet, at radius r (units of Saturn's radius).
  const away = unitV([-s[0], -s[1], 0]);
  const lightAtRadius = (r: number) => visibleFractionAt(rings, [away[0] * r, away[1] * r, 0]);
  const edge = bisect(1.0, 6.0, r => lightAtRadius(r) >= 0.5);
  // A ray that grazes the oblate limb: in z-scaled space it is tangent to the unit sphere.
  const f = PHYSICAL_CONSTANTS.saturn.flattening;
  const cosB = Math.sqrt(1 - sinB * sinB);
  const expected = Math.sqrt(cosB * cosB + (sinB / (1 - f)) ** 2) / (sinB / (1 - f));
  console.log(`Saturn shadow edge on the rings, 2017-06-01: ${edge.toFixed(4)} radii; grazing ray ${expected.toFixed(4)}; B = ${(Math.asin(sinB) / DEG).toFixed(2)} deg`);
  // Tolerance 0.003 radii (180 km); the penumbra is about 0.008 radii wide here.
  expect(Math.abs(edge - expected)).toBeLessThan(0.003);
  expect(lightAtRadius(1.05 * expected)).toBe(1);
  expect(lightAtRadius(0.95 * expected)).toBe(0);
  // Beside the planet (90 deg from the anti-solar direction) the rings are lit.
  expect(visibleFractionAt(rings, [-away[1] * 1.8, away[0] * 1.8, 0])).toBe(1);

  // The rings' shadow on the planet: on the sub-solar meridian, the ray toward the Sun from the
  // winter hemisphere crosses the ring plane. Its crossing radius sets the transmission.
  const surface = getShadowGeometry('saturn', date, RINGS) as ShadowGeometry;
  const ring = surface.ring!;
  const lon = Math.atan2(s[1], s[0]) / DEG;
  const sign = -Math.sign(s[2]);
  const crossing = (lat: number) => {
    const n = geodeticNormal(lat, lon);
    const big = 1 / Math.sqrt(1 - surface.e2 * n[2] * n[2]);
    const p: V3 = [big * n[0], big * n[1], big * (1 - surface.e2) * n[2]];
    const d = unitV(sub(surface.sun, p));
    const t = -p[2] / d[2];
    return {p, t, mu: Math.abs(d[2]), r: Math.hypot(p[0] + t * d[0], p[1] + t * d[1])};
  };
  let shaded = 0;
  for (let lat = 0.5; lat < 60; lat += 0.5) {
    const c = crossing(sign * lat);
    const tr = ringTransmission(c.p, surface.sun, ring);
    if (c.t > 0 && c.r > ring.inner && c.r < ring.outer) {
      shaded++;
      // B ring (tau 1.8) at this slant: nearly opaque; C ring and Cassini Division: thin.
      const tau = c.r < ring.edges[0] ? 0.1 : c.r < ring.edges[1] ? 1.8 : c.r < ring.edges[2] ? 0.12 : 0.5;
      expect(tr).toBeCloseTo(Math.exp(-tau / c.mu), 9);
    } else {
      expect(tr).toBe(1);
    }
  }
  expect(shaded).toBeGreaterThan(5);
  // The summer hemisphere sees the Sun above the ring plane: no ring shadow.
  for (let lat = 1; lat < 60; lat += 7) expect(ringTransmission(crossing(-sign * lat).p, surface.sun, ring)).toBe(1);
});

test('occluders whose penumbra misses the receiver are left out', () => {
  // 2024-04-22: two weeks after the eclipse, full Moon away from a node: no shadow anywhere.
  expect(getShadowGeometry('earth', new Date('2024-04-15T00:00:00Z'), RINGS)?.occluders).toEqual([]);
  expect(getShadowGeometry('moon', new Date('2024-04-23T23:49:00Z'), RINGS)?.occluders).toEqual([]);
  expect(getShadowGeometry('mars', new Date('2024-04-08T18:00:00Z'), RINGS)).toBeNull();
});
