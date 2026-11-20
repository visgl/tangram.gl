// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Glue between the scene and the space volumes: the look volumes of the bodies, the comet and the
// artistic clouds in scene units, and one VolumeFrame per drawn frame.

import {Matrix4} from '@math.gl/core';
import {
  BODY_IDS,
  NEOWISE,
  cometActivity,
  cometState,
  dustTail,
  ionTailDirection,
  julianTT,
  type BodyId,
  type V3
} from '../celestial';
import type {LookVolume} from './look-volumes';
import {dustLevels} from './space-dust';
import type {CloudInstance, Quality, VolumeFrame} from './space-volumes';

export type SpaceToggles = {looks: boolean; corona: boolean; comet: boolean; gas: boolean; dust: boolean; cloudMode: 'baked' | 'procedural'; quality: Quality};

/** What the glue needs from the scene: positions relative to the floating origin. */
export type SpaceScene = {
  date: Date;
  pos: Record<BodyId, V3>;
  radius: Record<BodyId, number>;
  matrix: Record<BodyId, number[]>;
  scale: 'readable' | 'true';
  /** Heliocentric AU to scene units relative to the floating origin. */
  toScene: (pAU: V3) => V3;
  /** The floating origin, absolute scene units. */
  origin: V3;
  /** Body colours, 0-255. */
  colors: Record<BodyId, readonly number[]>;
};

const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a: readonly number[], b: readonly number[], t: number): V3 => [0, 1, 2].map(k => a[k] + (b[k] - a[k]) * t) as V3;
const sphericalAU = (r: number, lonDeg: number, latDeg: number): V3 => {
  const [lo, la] = [(lonDeg * Math.PI) / 180, (latDeg * Math.PI) / 180];
  return [r * Math.cos(la) * Math.cos(lo), r * Math.cos(la) * Math.sin(lo), r * Math.sin(la)];
};
/** Scene distance from the Sun of a heliocentric distance, AU. */
const sceneDistance = (s: SpaceScene, rAU: number) => len(sub(s.toScene([rAU, 0, 0]), s.toScene([0, 0, 0])));

// ---------- Comet ----------

export const ION_POINTS = 8;
export const DUST_POINTS = 12;
/** Age of the oldest dust in the drawn tail, days; radiation-pressure ratio of the drawn syndyne. */
export const DUST_TAIL_DAYS = 12;
export const DUST_BETA = 0.6;
/** Length of the ion tail at perihelion, AU (it scales with the square root of the activity). */
export const ION_TAIL_AU = 0.18;

export type CometScene = {
  /** Heliocentric AU. */
  position: V3;
  velocity: V3;
  r: number;
  activity: number;
  ionAU: V3[];
  dustAU: V3[];
};
let cometCache: {time: number; value: CometScene} | null = null;
/** The comet at a date: position, activity and both tails in heliocentric AU. */
export function cometAt(date: Date): CometScene {
  if (cometCache && cometCache.time === date.getTime()) return cometCache.value;
  const jd = julianTT(date);
  const state = cometState(NEOWISE, jd);
  const activity = cometActivity(NEOWISE, state.r);
  const ionDir = ionTailDirection(state.position);
  const ionLength = ION_TAIL_AU * Math.sqrt(activity);
  const ionAU = Array.from({length: ION_POINTS}, (_, k) => lerp3(state.position, state.position.map((v, j) => v + ionDir[j] * ionLength), k / (ION_POINTS - 1)));
  const ages = Array.from({length: DUST_POINTS}, (_, k) => (DUST_TAIL_DAYS * k) / (DUST_POINTS - 1));
  const dustAU = dustTail(NEOWISE, jd, ages, DUST_BETA);
  const value = {position: state.position, velocity: state.velocity, r: state.r, activity, ionAU, dustAU};
  cometCache = {time: date.getTime(), value};
  return value;
}

/** Coma radius, scene units: about 2e5 km in true scale; enlarged in the readable scale. */
const comaRadius = (s: SpaceScene) => (s.scale === 'true' ? 0.2 : 0.7);

// ---------- Artistic clouds ----------

type CloudSpec = {
  id: string;
  label: string;
  /** Heliocentric distance AU, ecliptic longitude and latitude, deg. */
  at: [number, number, number];
  /** Half size: scene units in the readable scale, AU in the true scale. */
  size: {readable: number; true: number};
  /** Euler angles (rad), per-axis scale and flip: the variation transform. */
  rotation: V3;
  scale: V3;
  ramp: [V3, V3, V3];
};
/**
 * One baked base volume, three variations: each has its own transform (rotation, scale, flip)
 * and colour ramp, as EVE Online makes many clouds from a few bases. All artistic.
 */
export const CLOUDS: readonly CloudSpec[] = Object.freeze([
  {
    id: 'ember', label: 'Ember cloud (artistic)', at: [34, 330, 3], size: {readable: 30, true: 3},
    rotation: [0.3, 1.1, 0.2], scale: [1, 1, 1],
    ramp: [[0.05, 0.42, 0.48], [0.9, 0.38, 0.08], [1.0, 0.86, 0.55]]
  },
  {
    id: 'violet', label: 'Violet cloud (artistic)', at: [6.5, 150, -6], size: {readable: 14, true: 1.2},
    rotation: [2.0, 0.4, 1.3], scale: [-1, 0.8, 1.2],
    ramp: [[0.12, 0.05, 0.3], [0.45, 0.25, 0.85], [0.85, 0.85, 1.0]]
  },
  {
    id: 'verdant', label: 'Verdant cloud (artistic)', at: [14, 40, 9], size: {readable: 20, true: 2},
    rotation: [1.0, 2.5, 0.7], scale: [1.2, 1, -0.9],
    ramp: [[0.02, 0.18, 0.1], [0.3, 0.7, 0.35], [0.95, 0.85, 0.4]]
  }
] as CloudSpec[]);

function rotationMatrix([a, b, c]: V3): number[] {
  return new Matrix4().rotateX(a).rotateY(b).rotateZ(c).toArray() as number[];
}
/** Centre (relative to the floating origin), half size and world-to-local 3 x 3 (row-major) of a cloud. */
export function cloudPlacement(s: SpaceScene, spec: CloudSpec) {
  const center = s.toScene(sphericalAU(...spec.at));
  const half = s.scale === 'true' ? (spec.size.true * 149597870.7) / 1e6 : spec.size.readable;
  const m = rotationMatrix(spec.rotation);
  // Local = S^-1 R^T (p - c) / half. Column-major m: R[row][col] = m[col * 4 + row].
  const toLocal: number[] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) toLocal.push(m[row * 4 + col] / (spec.scale[row] * half));
  const bound = half * Math.max(...spec.scale.map(Math.abs)) * Math.sqrt(3);
  return {center, half, bound, toLocal};
}
const apply3 = (m: number[], v: readonly number[]): V3 => [0, 1, 2].map(r => m[3 * r] * v[0] + m[3 * r + 1] * v[1] + m[3 * r + 2] * v[2]) as V3;

// ---------- Look volumes ----------

const ATMOSPHERE: Partial<Record<BodyId, number>> = {venus: 0.1, earth: 0.06, mars: 0.05, jupiter: 0.08, saturn: 0.08, uranus: 0.07, neptune: 0.07};

/** The example's look volumes, in scene units relative to the floating origin. */
export function lookVolumes(s: SpaceScene): LookVolume[] {
  const sun = s.pos.sun;
  const rSun = s.radius.sun;
  const volumes: LookVolume[] = [
    {
      id: 'sun-glare', priority: 2,
      shape: {kind: 'sphere', center: sun, radius: 8 * rSun, edge: 5 * rSun},
      params: {tint: [1, 0.88, 0.72], exposure: 0.35, stars: 0.2, fogColor: [1, 0.62, 0.3], fogDensity: 0.035}
    },
    {
      // Beyond Neptune: darker, more stars. 32 to 90 AU around the Sun.
      id: 'deep-space', priority: 1,
      shape: {kind: 'shell', center: sun, inner: sceneDistance(s, 31), outer: sceneDistance(s, 90), edge: sceneDistance(s, 45) - sceneDistance(s, 31)},
      params: {tint: [0.82, 0.88, 1], exposure: -0.7, stars: 1.9}
    }
  ];
  // The zodiacal dust disc: a box around the ecliptic, inside 3 AU.
  const disc = sceneDistance(s, 3);
  const thick = 0.08 * sceneDistance(s, 1);
  volumes.push({
    id: 'zodiacal-disc', priority: 0,
    shape: {kind: 'box', min: sub(sun, [disc, disc, thick]), max: [sun[0] + disc, sun[1] + disc, sun[2] + thick], edge: thick},
    params: {fogColor: [0.85, 0.75, 0.55], fogDensity: 0.04}
  });
  for (const id of BODY_IDS) {
    const density = ATMOSPHERE[id];
    if (density === undefined) continue;
    const r = s.radius[id];
    const c = s.colors[id].map(v => v / 255) as V3;
    volumes.push({
      id: `${id}-atmosphere`, priority: 3,
      shape: {kind: 'shell', center: s.pos[id], inner: r, outer: 4 * r, edge: 2 * r},
      params: {fogColor: c, fogDensity: density, tint: lerp3([1, 1, 1], c, 0.12)}
    });
  }
  const ember = CLOUDS[0];
  const placed = cloudPlacement(s, ember);
  volumes.push({
    id: 'ember-cloud', priority: 4,
    shape: {kind: 'sphere', center: placed.center, radius: 1.1 * placed.half, edge: 0.6 * placed.half},
    params: {fogColor: [0.55, 0.32, 0.18], fogDensity: 0.1, tint: [1, 0.9, 0.82], stars: 0.5}
  });
  return volumes;
}

// ---------- The frame ----------

export type FrameCamera = {
  /** Camera position relative to the floating origin. */
  eye: V3;
  /** Distance to what the camera looks at. */
  distance: number;
  /** World (relative to the floating origin) to clip. */
  viewProjection: number[];
  width: number;
  height: number;
};

/** Corner rays and a camera-relative view-projection, from a world view-projection (double precision). */
export function cameraRays(cam: FrameCamera) {
  const vp = new Matrix4(cam.viewProjection);
  const inv = new Matrix4(cam.viewProjection).invert();
  const corner = (x: number, y: number): V3 => {
    const near = inv.transform([x, y, -1]) as number[];
    const far = inv.transform([x, y, 1]) as number[];
    return sub(far, near);
  };
  const corners: [V3, V3, V3, V3] = [corner(-1, -1), corner(1, -1), corner(-1, 1), corner(1, 1)];
  const relative = vp.clone().translate(cam.eye).toArray() as number[];
  return {corners, relative};
}

export function volumeFrame(s: SpaceScene, cam: FrameCamera, t: SpaceToggles, fog: {color: V3; density: number}): {frame: VolumeFrame; viewProjection: number[]} {
  const {corners, relative} = cameraRays(cam);
  const rel = (p: readonly number[]) => sub(p, cam.eye);
  const spheres = BODY_IDS.map(id => [...rel(s.pos[id]), s.radius[id]]);
  const pole = [s.matrix.sun[8], s.matrix.sun[9], s.matrix.sun[10]];
  const poleN = len(pole);
  let comet: VolumeFrame['comet'] = null;
  if (t.comet) {
    const c = cometAt(s.date);
    if (c.activity > 1e-3) {
      const dust = c.dustAU.map(p => rel(s.toScene(p)));
      const tailLength = len(sub(dust[dust.length - 1], dust[0]));
      comet = {
        head: rel(s.toScene(c.position)),
        coma: comaRadius(s) * (0.4 + 0.6 * Math.sqrt(c.activity)),
        ion: c.ionAU.map(p => rel(s.toScene(p))),
        dust,
        width: Math.max(0.05 * tailLength, 0.5 * comaRadius(s)),
        activity: Math.sqrt(c.activity)
      };
    }
  }
  const clouds: CloudInstance[] = t.gas
    ? CLOUDS.map(spec => {
        const p = cloudPlacement(s, spec);
        const sunLocal = apply3(p.toLocal, sub(s.pos.sun, p.center));
        const n = len(sunLocal);
        return {center: rel(p.center), radius: p.bound, toLocal: p.toLocal, ramp: spec.ramp, sunLocal: sunLocal.map(v => v / n) as V3};
      })
    : [];
  const frame: VolumeFrame = {
    width: cam.width,
    height: cam.height,
    quality: t.quality,
    corners,
    spheres,
    corona: t.corona ? {center: rel(s.pos.sun), radius: s.radius.sun, pole: pole.map(v => v / poleN) as V3, gain: 0.8} : null,
    comet,
    zodiacal: t.gas ? {sun: rel(s.pos.sun), bound: sceneDistance(s, 5), trueScale: s.scale === 'true', gain: 0.04} : null,
    clouds,
    cloudMode: t.cloudMode,
    fog,
    dust: t.dust ? {levels: dustLevels(cam.eye.map((v, k) => v + s.origin[k]), cam.distance), size: 2.2} : null
  };
  return {frame, viewProjection: relative};
}
