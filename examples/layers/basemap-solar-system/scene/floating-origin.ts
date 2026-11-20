// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {V3} from '../celestial';

/** The interaction flags that a deck.gl controller sends to `onInteractionStateChange`. */
export type CameraActivity = {
  isDragging?: boolean;
  isPanning?: boolean;
  isRotating?: boolean;
  isZooming?: boolean;
  inTransition?: boolean;
};

/**
 * No gesture and no camera transition runs. A deck.gl controller keeps world points of a gesture
 * (the grabbed point of a pan, the zoom anchor) and the end view state of a transition in the
 * frame in which they started, so the origin can move only when all flags are clear.
 */
export function isCameraIdle(activity: CameraActivity): boolean {
  return !(activity.isDragging || activity.isPanning || activity.isRotating || activity.isZooming || activity.inTransition);
}

/**
 * The spacing of float32 values next to `value`: 2^(e - 23) for a value in [2^e, 2^(e + 1)).
 * math.gl's `getFloat32Spacing` (visgl/math.gl#638) computes the same; the math.gl version of
 * this example does not have it yet.
 */
export function float32Spacing(value: number): number {
  const a = Math.abs(value);
  if (a < 2 ** -126) return 2 ** -149;
  let e = Math.floor(Math.log2(a));
  // Math.log2 is not exact next to a power of two.
  if (2 ** e > a) e--;
  else if (2 ** (e + 1) <= a) e++;
  return 2 ** (e - 23);
}

/** Largest float32 step at the camera target that the origin allows, in pixels. */
export const MAX_STEP_PX = 1 / 16;

/**
 * The origin moves only when the camera is idle and float32 steps at the camera target (`offset`,
 * the target relative to the origin) are larger than MAX_STEP_PX. `pixelSize` is the size of one
 * pixel at the nearest geometry in view, in scene units.
 */
export function shouldRebase(offset: readonly number[], pixelSize: number, idle: boolean): boolean {
  if (!idle) return false;
  const extent = Math.max(Math.abs(offset[0]), Math.abs(offset[1]), Math.abs(offset[2]));
  return float32Spacing(extent) > MAX_STEP_PX * pixelSize;
}

type Camera = {eye: V3; target: V3};

/**
 * The camera states after the origin moves by `delta`, in one step: the OrbitView target and the
 * free camera move by -delta. The OrbitView state loses its transition props: deck.gl would
 * otherwise start a new transition from the view state of the old frame.
 */
export function shiftCameras<O extends {target: V3}, C extends Camera>(
  delta: readonly number[],
  overview: O,
  camera: C | null
): {overview: Omit<O, 'transitionDuration' | 'transitionInterpolator'>; camera: C | null} {
  const shift = (p: V3): V3 => [p[0] - delta[0], p[1] - delta[1], p[2] - delta[2]];
  const {transitionDuration: _duration, transitionInterpolator: _interpolator, ...rest} = overview as O & {
    transitionDuration?: unknown;
    transitionInterpolator?: unknown;
  };
  return {
    overview: {...rest, target: shift(overview.target)},
    camera: camera && {...camera, eye: shift(camera.eye), target: shift(camera.target)}
  };
}
