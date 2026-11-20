// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Look volumes: regions of the scene that change the look (fog, tint, exposure, star field) when
// the camera is inside them. A volume can also take its weight from what the camera sees (the
// glare of the Sun), or from the point that the camera looks at in place of the camera position. The idea follows the post-process volumes of the Carbon engine
// (github.com/carbonengine, MIT): a volume carries look parameters, each parameter blends by a
// weight from the camera position, and a priority rule settles overlaps. No Carbon code is used.
// Pure functions only: no deck.gl or DOM imports.

import type {V3} from '../celestial';

export type LookParams = {
  /** Haze over the whole view, 0 (none) to 1. */
  fogDensity: number;
  /** Haze colour, linear 0-1. */
  fogColor: V3;
  /** Colour multiplier of the scene, 0-1 per channel. */
  tint: V3;
  /** Exposure, stops (EV): 0 = no change, +1 = twice as bright. */
  exposure: number;
  /** Star-field factor: 1 = no change, below 1 dims the stars, above 1 brightens them. */
  stars: number;
};

export const DEFAULT_LOOK: Readonly<LookParams> = Object.freeze({
  fogDensity: 0,
  fogColor: [0, 0, 0] as V3,
  tint: [1, 1, 1] as V3,
  exposure: 0,
  stars: 1
});

/** A region and its soft edge. The weight is 1 inside, 0 outside, smooth across `edge`. */
export type LookShape =
  /** A ball: weight 1 to `radius - edge`, 0 from `radius`. */
  | {kind: 'sphere'; center: V3; radius: number; edge: number}
  /** A shell: weight 1 between `inner` and `outer`, ramps of width `edge` inside both limits. */
  | {kind: 'shell'; center: V3; inner: number; outer: number; edge: number}
  /** An axis-aligned box: weight 1 inside `min + edge` .. `max - edge` on every axis. */
  | {kind: 'box'; min: V3; max: V3; edge: number}
  /** No region: a weight (0-1) that the caller computed, for example from what the camera sees. */
  | {kind: 'weight'; weight: number};

export type LookVolume = {
  id: string;
  shape: LookShape;
  /** Higher priority wins an overlap: see blendLook. */
  priority: number;
  /**
   * 'target': the weight comes from the point that the camera looks at, not from the camera. An
   * orbit camera moves away from its target when it zooms out; the region that the view is in
   * does not change then.
   */
  anchor?: 'target';
  /** The parameters to blend toward. A parameter left out keeps the value from below. */
  params: Partial<LookParams>;
};

/** 0 at `a`, 1 at `b`, with zero slope at both ends (C1). `a` may be greater than `b`. */
export function smoothstep(a: number, b: number, x: number): number {
  if (a === b) return x < a ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Weight of a shape at a camera position, 0-1. Continuous everywhere, smooth across the edges. */
export function weightAt(shape: LookShape, p: readonly number[]): number {
  switch (shape.kind) {
    case 'sphere':
      return smoothstep(shape.radius, shape.radius - shape.edge, dist(p, shape.center));
    case 'shell': {
      const d = dist(p, shape.center);
      return smoothstep(shape.inner, shape.inner + shape.edge, d) * smoothstep(shape.outer, shape.outer - shape.edge, d);
    }
    case 'box': {
      let w = 1;
      for (let k = 0; k < 3; k++) {
        w *= smoothstep(shape.min[k], shape.min[k] + shape.edge, p[k]) * smoothstep(shape.max[k], shape.max[k] - shape.edge, p[k]);
      }
      return w;
    }
    case 'weight':
      return Math.max(0, Math.min(1, shape.weight));
    default:
      return assertNever(shape);
  }
}
function assertNever(value: never): never {
  throw new Error(`unknown look shape ${JSON.stringify(value)}`);
}

type Numeric = 'fogDensity' | 'exposure' | 'stars';
const NUMERIC: readonly Numeric[] = ['fogDensity', 'exposure', 'stars'];
const COLORS: readonly ('fogColor' | 'tint')[] = ['fogColor', 'tint'];

/** The weight of each volume after the priority rule, for display and tests. */
export type LookBlend = {params: LookParams; weights: {id: string; weight: number; share: number}[]};

/**
 * Blends the look parameters of the volumes at a camera position.
 *
 * Priority rule: the volumes group by priority, highest first. A group covers a fraction
 * `g = max(weights)` of what the groups above it left; inside a group the parameters average
 * by weight. The fraction that no group covers keeps `base`. So a higher-priority volume at full
 * weight overrides every lower one, volumes of equal priority mix, and the result is continuous
 * in the camera position because every weight is. A parameter that a volume leaves out takes the
 * value of the layers below it (lower groups, then `base`) inside that volume's share.
 * Exposure blends in stops, colours per channel.
 *
 * `target` is the point that the camera looks at: the volumes with `anchor: 'target'` take their
 * weight there. Without it they use the camera position.
 */
export function blendLook(
  volumes: readonly LookVolume[],
  p: readonly number[],
  base: Readonly<LookParams> = DEFAULT_LOOK,
  target: readonly number[] = p
): LookBlend {
  const scored = volumes.map(v => ({v, w: weightAt(v.shape, v.anchor === 'target' ? target : p)})).filter(s => s.w > 0);
  const priorities = [...new Set(scored.map(s => s.v.priority))].sort((a, b) => b - a);
  const groups = priorities.map(priority => scored.filter(s => s.v.priority === priority));
  const weights: LookBlend['weights'] = [];
  // Resolve from the lowest group up: each group lays its share over what is below it.
  let result: LookParams = {...base, fogColor: [...base.fogColor] as V3, tint: [...base.tint] as V3};
  const shares: number[] = [];
  let remaining = 1;
  for (const group of groups) {
    const g = Math.min(1, Math.max(...group.map(s => s.w)));
    shares.push(g * remaining);
    remaining *= 1 - g;
  }
  for (let k = groups.length - 1; k >= 0; k--) {
    const group = groups[k];
    const g = Math.min(1, Math.max(...group.map(s => s.w)));
    const sum = group.reduce((a, s) => a + s.w, 0);
    const below = result;
    const mixed: LookParams = {...below, fogColor: [...below.fogColor] as V3, tint: [...below.tint] as V3};
    for (const key of NUMERIC) {
      mixed[key] = group.reduce((a, s) => a + (s.w / sum) * (s.v.params[key] ?? below[key]), 0);
    }
    for (const key of COLORS) {
      mixed[key] = [0, 1, 2].map(c => group.reduce((a, s) => a + (s.w / sum) * (s.v.params[key] ?? below[key])[c], 0)) as V3;
    }
    // The group covers g of the result at its level; the layers below keep 1 - g.
    const next: LookParams = {...below, fogColor: [...below.fogColor] as V3, tint: [...below.tint] as V3};
    for (const key of NUMERIC) next[key] = below[key] + (mixed[key] - below[key]) * g;
    for (const key of COLORS) next[key] = [0, 1, 2].map(c => below[key][c] + (mixed[key][c] - below[key][c]) * g) as V3;
    result = next;
    for (const s of group) weights.push({id: s.v.id, weight: s.w, share: (shares[k] * s.w) / sum});
  }
  return {params: result, weights};
}

/** The Sun as the camera sees it. */
export type SunView = {
  /** Radius of the Sun's disc on the screen, pixels. */
  sunPx: number;
  /**
   * How far the nearest point of the disc is outside the view, in half-views: 0 or less when a
   * part of the disc is on the screen, Infinity when the Sun is behind the camera.
   */
  outside: number;
  /** Fraction of the solar disc that no body covers, seen from the camera, 0-1. */
  visible: number;
};

/** The glare stays at this weight while a Sun of any size is in view. */
export const GLARE_FLOOR = 0.15;
/** Disc radius, pixels, at which the glare is at the floor, and at which it is full. */
export const GLARE_PX: readonly [number, number] = [3, 300];
/** The glare is gone when the disc is this far outside the view, half-views. */
export const GLARE_OUTSIDE = 0.5;

/**
 * Weight of the Sun glare, from what the camera sees: it grows with the size of the disc on the
 * screen (smoothly in log size, from GLARE_FLOOR to 1), falls to 0 as the Sun leaves the view,
 * and scales with the part of the disc that no body covers. Continuous in all three inputs. A
 * camera that zooms out with the Sun in view keeps a weaker glare; it never switches off.
 */
export function sunGlareWeight(view: SunView): number {
  if (!(view.sunPx > 0) || !Number.isFinite(view.outside)) return 0;
  const size = GLARE_FLOOR + (1 - GLARE_FLOOR) * smoothstep(Math.log(GLARE_PX[0]), Math.log(GLARE_PX[1]), Math.log(view.sunPx));
  return size * smoothstep(GLARE_OUTSIDE, 0, view.outside) * Math.max(0, Math.min(1, view.visible));
}

/** Radius of the halo of the Sun, Sun radii, and its least radius on the screen, pixels. */
export const HALO_RADII = 4;
export const HALO_MIN_PX = 22;
/** Halo emission at the centre: for a small Sun (a star), and close to the Sun (the corona takes over). */
export const HALO_GAIN: readonly [far: number, near: number] = [2.2, 0.15];
/** Disc radius, pixels, between which the halo goes from the far gain to the near gain. */
export const HALO_PX: readonly [number, number] = [3, 40];

/**
 * The halo of the Sun: a glow with a least size on the screen, so a Sun of under a pixel still
 * reads as a bright star. `radius` is in units of the Sun's radius, at the Sun's distance. It dims
 * with the part of the disc that a body covers.
 */
export function sunHalo(view: SunView): {radius: number; gain: number} {
  if (!(view.sunPx > 0)) return {radius: HALO_RADII, gain: 0};
  const near = smoothstep(Math.log(HALO_PX[0]), Math.log(HALO_PX[1]), Math.log(view.sunPx));
  const gain = (HALO_GAIN[0] + (HALO_GAIN[1] - HALO_GAIN[0]) * near) * Math.max(0, Math.min(1, view.visible));
  return {radius: Math.max(HALO_RADII, HALO_MIN_PX / view.sunPx), gain};
}

/** Linear multiplier of an exposure in stops. */
export const exposureGain = (ev: number) => 2 ** ev;
