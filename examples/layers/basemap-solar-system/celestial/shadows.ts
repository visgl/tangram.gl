// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Eclipse shadows, analytic. A surface point looks toward the Sun. The Sun is a disc of angular
// radius asin(R_sun / distance); each occluder sphere is a disc of angular radius
// asin(R / distance). The light that arrives is the visible fraction of the solar disc: the area
// of the Sun's disc that the occluder's disc does not cover. This gives the umbra (fraction 0),
// the antumbra (an annulus of the Sun stays) and the penumbra (between 0 and 1) with no shadow
// map. It is the exact form of the "circular occluder" idea of CORTAO
// (github.com/carbonengine/CORTAO, MIT): occluders approximated as discs, their overlap with the
// light's disc taken as the occlusion.
//
// Saturn's rings are a flat annulus in Saturn's equator plane. A ray from the point toward the
// Sun's centre that crosses the annulus is dimmed by exp(-tau / |mu|): tau is the normal optical
// depth of the ring at the crossing, mu the sine of the Sun's elevation above the ring plane.
// The Sun's size is ignored there (its disc spans about 50 km at the ring distance).
//
// Geometry is true: positions in km, in double precision, heliocentric ecliptic J2000, and then
// relative to the centre of the shaded body and in its body-fixed frame, in units of its
// equatorial radius. Occluder positions are taken at the time the shadowing light passed them
// (light time from occluder to receiver: for the Moon this moves the shadow on the Earth by about
// 38 km). The shader (scene/shadow-extension.ts) repeats these functions in GLSL.

import {MakeTime, RotateVector, Rotation_EQJ_EQD, SiderealTime, Vector} from 'astronomy-engine';
import {BODY_IDS, PHYSICAL_CONSTANTS, type BodyId} from './constants';
import {GALILEAN, KM_PER_AU, getGalileanOffsets, moonGeocentric, planetPosition} from './ephemeris';
import {eclipticToEqj, getBodyAxes} from './frames';
import {DEG, dot, norm, type V3} from './vector';

export const SPEED_OF_LIGHT_KM_S = 299792.458;
export const SUN_RADIUS_KM = PHYSICAL_CONSTANTS.sun.radiusKm;
/**
 * The Earth as an occluder of the Moon: mean radius plus 88 km of atmosphere, as Astronomy
 * Engine's lunar eclipse search uses (the atmosphere enlarges the umbra by about 2%).
 */
export const EARTH_SHADOW_RADIUS_KM = 6371.0 + 88.0;
/** The Moon as an occluder: mean radius (Astronomy Engine uses the same value). */
export const MOON_SHADOW_RADIUS_KM = 1737.4;

/**
 * Normal optical depth of Saturn's rings, by band, km. The band edges are those of the ring
 * texture (NSSDC Saturnian Rings Fact Sheet); tau is a typical value of each ring (C ring about
 * 0.1, B ring 1 to above 3, Cassini Division about 0.1, A ring about 0.5: Cuzzi et al. 2009,
 * "Ring particle composition and size distribution", Saturn from Cassini-Huygens).
 */
export const RING_OPTICAL_DEPTH: readonly {fromKm: number; toKm: number; tau: number}[] = Object.freeze([
  {fromKm: 0, toKm: 92000, tau: 0.1},
  {fromKm: 92000, toKm: 117580, tau: 1.8},
  {fromKm: 117580, toKm: 122170, tau: 0.12},
  {fromKm: 122170, toKm: Infinity, tau: 0.5}
]);

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Visible fraction of a light disc of angular radius 1 when a disc of angular radius `ro` lies
 * at angular distance `d` from its centre (both in units of the light's radius). Small angles:
 * the discs are flat. 0 in the umbra, 1 - ro^2 in the antumbra, 1 outside the penumbra.
 */
export function discVisibleFraction(ro: number, d: number): number {
  if (d >= 1 + ro) return 1;
  if (d <= Math.abs(1 - ro)) return ro >= 1 ? 0 : 1 - ro * ro;
  // Area of the lens where the two discs overlap.
  const a1 = Math.acos(clamp((d * d + 1 - ro * ro) / (2 * d), -1, 1));
  const a2 = Math.acos(clamp((d * d + ro * ro - 1) / (2 * d * ro), -1, 1));
  const k = Math.sqrt(Math.max(0, (-d + 1 + ro) * (d + 1 - ro) * (d - 1 + ro) * (d + 1 + ro)));
  const overlap = a1 + ro * ro * a2 - 0.5 * k;
  return clamp(1 - overlap / Math.PI, 0, 1);
}

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: readonly number[], b: readonly number[]): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];

/** An occluder: centre and equatorial radius, `zScale` = 1 / (1 - flattening) about the body-fixed z. */
export type Occluder = {id: string; center: V3; radius: number; zScale: number; tint: V3};

/**
 * Visible fraction of the solar disc at point `p`, for one occluder. The Sun's angular radius is
 * taken at `p`. An oblate occluder becomes a sphere when z is scaled by `zScale`; the directions
 * are taken in that scaled space (a small error in the penumbra width only).
 */
export function sphereVisibility(p: V3, sun: V3, sunRadius: number, occ: Occluder): number {
  let a = sub(sun, p);
  let b = sub(occ.center, p);
  const rs = Math.asin(Math.min(1, sunRadius / norm(a)));
  a = [a[0], a[1], a[2] * occ.zScale];
  b = [b[0], b[1], b[2] * occ.zScale];
  const da = norm(a);
  const db = norm(b);
  if (db >= da) return 1;
  if (db <= occ.radius) return 0;
  const ro = Math.asin(occ.radius / db);
  const d = Math.atan2(norm(cross(a, b)), dot(a, b));
  return discVisibleFraction(ro / rs, d / rs);
}

export type RingShadow = {inner: number; outer: number; edges: [number, number, number]; tau: [number, number, number, number]};

/** Normal optical depth of the ring at radius `r` (units of the planet radius). */
export function ringOpticalDepth(ring: RingShadow, r: number): number {
  if (r < ring.inner || r > ring.outer) return 0;
  if (r < ring.edges[0]) return ring.tau[0];
  if (r < ring.edges[1]) return ring.tau[1];
  if (r < ring.edges[2]) return ring.tau[2];
  return ring.tau[3];
}

/** Transmission of the ring along the ray from `p` toward the Sun's centre. */
export function ringTransmission(p: V3, sun: V3, ring: RingShadow): number {
  const s = sub(sun, p);
  const n = norm(s);
  const sz = s[2] / n;
  if (Math.abs(sz) < 1e-9) return 1;
  const t = -p[2] / sz;
  if (t <= 0) return 1;
  const r = Math.hypot(p[0] + (t * s[0]) / n, p[1] + (t * s[1]) / n);
  return Math.exp(-ringOpticalDepth(ring, r) / Math.abs(sz));
}

/**
 * The shadow geometry of one receiving surface, in its body-fixed frame and in units of its
 * equatorial radius. `kind`: 'surface' = the body's ellipsoid, 'rings' = Saturn's ring plane.
 */
export type ShadowGeometry = {
  receiver: BodyId;
  kind: 'surface' | 'rings';
  sun: V3;
  sunRadius: number;
  /** Occluders whose penumbra can reach the receiver now (others are left out). */
  occluders: Occluder[];
  /** Eccentricity squared of the receiving ellipsoid (geodetic latitude to surface point). */
  e2: number;
  ring: RingShadow | null;
};

/** Surface point (units of the equatorial radius) at geodetic direction `n` on an ellipsoid. */
export function surfacePoint(n: readonly number[], e2: number): V3 {
  const k = 1 / norm(n);
  const x = n[0] * k, y = n[1] * k, z = n[2] * k;
  const big = 1 / Math.sqrt(1 - e2 * z * z);
  return [big * x, big * y, big * (1 - e2) * z];
}

/** Geodetic unit vector of latitude and longitude, degrees. */
export const geodeticNormal = (latDeg: number, lonDeg: number): V3 => [
  Math.cos(latDeg * DEG) * Math.cos(lonDeg * DEG),
  Math.cos(latDeg * DEG) * Math.sin(lonDeg * DEG),
  Math.sin(latDeg * DEG)
];

/**
 * Light at a point, as a factor on sRGB map colours: per channel, the product of every occluder
 * and the ring. The visible fraction is linear light, so it is encoded with the sRGB gamma.
 */
export function lightAt(geometry: ShadowGeometry, p: V3): V3 {
  const light: V3 = [1, 1, 1];
  for (const occ of geometry.occluders) {
    const v = sphereVisibility(p, geometry.sun, geometry.sunRadius, occ) ** (1 / SRGB_GAMMA);
    for (let c = 0; c < 3; c++) light[c] *= occ.tint[c] + (1 - occ.tint[c]) * v;
  }
  if (geometry.ring) {
    const t = ringTransmission(p, geometry.sun, geometry.ring) ** (1 / SRGB_GAMMA);
    for (let c = 0; c < 3; c++) light[c] *= RING_SHADOW_FLOOR + (1 - RING_SHADOW_FLOOR) * t;
  }
  return light;
}

/** Visible fraction of the solar disc (no tint) at a geodetic direction on the receiver. */
export function visibleFractionAt(geometry: ShadowGeometry, n: readonly number[]): number {
  const p = geometry.kind === 'rings' ? ([n[0], n[1], n[2]] as V3) : surfacePoint(n, geometry.e2);
  let v = 1;
  for (const occ of geometry.occluders) v *= sphereVisibility(p, geometry.sun, geometry.sunRadius, occ);
  if (geometry.ring) v *= ringTransmission(p, geometry.sun, geometry.ring);
  return v;
}

/** Light left in a full umbra: a little scattered light, so the map stays readable. */
export const UMBRA_TINT: V3 = [0.04, 0.04, 0.05];
/** The Earth's umbra on the Moon: sunlight refracted by the Earth's atmosphere is red. */
export const LUNAR_UMBRA_TINT: V3 = [0.32, 0.1, 0.04];
export const RING_SHADOW_FLOOR = 0.06;
/** Approximate sRGB gamma: a linear light factor k scales an sRGB colour by about k^(1 / 2.2). */
export const SRGB_GAMMA = 2.2;

// ---------- Sources and frames ----------

type Source = BodyId | (typeof GALILEAN)[number]['id'];

/** Heliocentric position, km, ecliptic J2000. */
export function helioKm(source: Source, date: Date): V3 {
  const scale = (v: V3): V3 => [v[0] * KM_PER_AU, v[1] * KM_PER_AU, v[2] * KM_PER_AU];
  if (source === 'sun') return [0, 0, 0];
  if (source === 'moon') {
    const e = planetPosition('earth', date);
    const m = moonGeocentric(date);
    return scale([e[0] + m[0], e[1] + m[1], e[2] + m[2]]);
  }
  const k = GALILEAN.findIndex(g => g.id === source);
  if (k >= 0) {
    const j = planetPosition('jupiter', date);
    const o = getGalileanOffsets(date)[k];
    return scale([j[0] + o[0], j[1] + o[1], j[2] + o[2]]);
  }
  return scale(planetPosition(source as Exclude<BodyId, 'sun' | 'moon'>, date));
}

/** Position of `source` when the light that reaches `receiverKm` at `date` passed it. */
export function retardedKm(source: Source, receiverKm: V3, date: Date): V3 {
  const now = helioKm(source, date);
  const tau = norm(sub(now, receiverKm)) / SPEED_OF_LIGHT_KM_S;
  return helioKm(source, new Date(date.getTime() - tau * 1000));
}

/**
 * Ecliptic J2000 vector to body-fixed coordinates (x = prime meridian, z = north). The Earth
 * uses Astronomy Engine's precession-nutation matrix and Greenwich apparent sidereal time, so
 * its longitudes are geographic; the other bodies use the IAU rotation models.
 */
export function bodyFixedFrame(id: BodyId, date: Date): (v: readonly number[]) => V3 {
  if (id === 'earth') {
    const time = MakeTime(date);
    const rotation = Rotation_EQJ_EQD(time);
    const g = SiderealTime(time) * 15 * DEG;
    const cg = Math.cos(g), sg = Math.sin(g);
    return v => {
      const q = eclipticToEqj(v);
      const e = RotateVector(rotation, new Vector(q[0], q[1], q[2], time));
      return [cg * e.x + sg * e.y, -sg * e.x + cg * e.y, e.z];
    };
  }
  const [x, y, z] = getBodyAxes(id, date);
  return v => [dot(v, x), dot(v, y), dot(v, z)];
}

/** Can the penumbra of an occluder (heliocentric km) reach a receiving sphere? */
export function penumbraReaches(receiver: V3, receiverRadius: number, occ: V3, occRadius: number): boolean {
  const dSun = norm(occ);
  const u: V3 = [occ[0] / dSun, occ[1] / dSun, occ[2] / dSun];
  const rel = sub(receiver, occ);
  const along = dot(rel, u);
  if (along <= -receiverRadius) return false;
  const perp = norm(sub(rel, [u[0] * along, u[1] * along, u[2] * along]));
  const penumbra = occRadius + (Math.max(0, along) * (SUN_RADIUS_KM + occRadius)) / dSun;
  return perp < penumbra + receiverRadius;
}

type CasterSpec = {id: Source; radiusKm: number; flattening: number; tint: V3};
const GALILEAN_CASTERS: CasterSpec[] = GALILEAN.map(g => ({id: g.id, radiusKm: g.radiusKm, flattening: 0, tint: UMBRA_TINT}));
/** Shadow casters of each receiving body. */
export const SHADOW_CASTERS: Partial<Record<BodyId, CasterSpec[]>> = Object.freeze({
  earth: [{id: 'moon', radiusKm: MOON_SHADOW_RADIUS_KM, flattening: 0, tint: UMBRA_TINT}],
  moon: [{id: 'earth', radiusKm: EARTH_SHADOW_RADIUS_KM, flattening: 0, tint: LUNAR_UMBRA_TINT}],
  jupiter: GALILEAN_CASTERS,
  saturn: []
});
export const SHADOWED_BODIES = new Set<BodyId>(BODY_IDS.filter(id => id in SHADOW_CASTERS));

function saturnRing(radiusKm: number, innerKm: number, outerKm: number): RingShadow {
  const b = RING_OPTICAL_DEPTH;
  return {
    inner: innerKm / radiusKm,
    outer: outerKm / radiusKm,
    edges: [b[0].toKm / radiusKm, b[1].toKm / radiusKm, b[2].toKm / radiusKm],
    tau: [b[0].tau, b[1].tau, b[2].tau, b[3].tau]
  };
}

/**
 * Shadow geometry of the surface of a body (null if no body casts a shadow on it), or of
 * Saturn's rings. `ringKm` are Saturn's ring radii.
 */
export function getShadowGeometry(
  receiver: BodyId,
  date: Date,
  ringKm: {innerKm: number; outerKm: number},
  kind: 'surface' | 'rings' = 'surface'
): ShadowGeometry | null {
  const casters = SHADOW_CASTERS[receiver];
  if (!casters) return null;
  const body = PHYSICAL_CONSTANTS[receiver];
  const r = body.radiusKm;
  const centre = helioKm(receiver, date);
  const toFixed = bodyFixedFrame(receiver, date);
  const local = (p: V3): V3 => {
    const f = toFixed(sub(p, centre));
    return [f[0] / r, f[1] / r, f[2] / r];
  };
  const occluders: Occluder[] = [];
  if (kind === 'rings') {
    // The planet's own shadow on its rings.
    occluders.push({id: receiver, center: [0, 0, 0], radius: 1, zScale: 1 / (1 - body.flattening), tint: UMBRA_TINT});
  } else {
    for (const caster of casters) {
      const p = retardedKm(caster.id, centre, date);
      if (!penumbraReaches(centre, r, p, caster.radiusKm)) continue;
      occluders.push({id: caster.id, center: local(p), radius: caster.radiusKm / r, zScale: 1 / (1 - caster.flattening), tint: caster.tint});
    }
  }
  const f = body.flattening;
  return {
    receiver,
    kind,
    sun: local([0, 0, 0]),
    sunRadius: SUN_RADIUS_KM / r,
    occluders,
    e2: f * (2 - f),
    ring: receiver === 'saturn' && kind === 'surface' ? saturnRing(r, ringKm.innerKm, ringKm.outerKm) : null
  };
}
