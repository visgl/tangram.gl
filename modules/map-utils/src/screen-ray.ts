// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** A top-origin viewport in the same screen units as the input pixel. */
export type ScreenViewport = {
  /** Left edge, defaulting to zero. */
  x?: number;
  /** Top edge, defaulting to zero. */
  y?: number;
  /** Horizontal span. */
  width: number;
  /** Vertical span. */
  height: number;
};

/** Test a finite pixel against a half-open viewport. */
export function containsScreenPixel(
  viewport: ScreenViewport,
  pixel: readonly [number, number]
): boolean {
  const {x = 0, y = 0, width, height} = viewport;
  return pixel.length === 2 && pixel.every(Number.isFinite) &&
    [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 &&
    pixel[0] >= x && pixel[1] >= y && pixel[0] < x + width && pixel[1] < y + height;
}

/**
 * Unproject an absolute, top-origin pixel using a clip-to-content transform.
 * The origin is the near endpoint (clip z = -1), and direction is the
 * displacement to the far endpoint (z = 1), not a unit vector.
 * Callers choose whether to reject pixels outside the viewport.
 */
export function unprojectScreenSegment(
  inverse: {transform(point: readonly number[]): ArrayLike<number>},
  viewport: ScreenViewport,
  pixel: readonly [number, number]
): {origin: [number, number, number]; direction: [number, number, number]} | null {
  const horizontal = 2 * (pixel[0] - (viewport.x ?? 0)) / viewport.width - 1;
  const vertical = 1 - 2 * (pixel[1] - (viewport.y ?? 0)) / viewport.height;
  const points = [-1, 1].map(depth => inverse.transform([horizontal, vertical, depth, 1]));
  if (points.some(point => point.length !== 4 || point[3] === 0 || !Array.from(point).every(Number.isFinite))) return null;
  const origin: [number, number, number] = [points[0][0] / points[0][3], points[0][1] / points[0][3], points[0][2] / points[0][3]];
  const direction: [number, number, number] = [points[1][0] / points[1][3] - origin[0], points[1][1] / points[1][3] - origin[1], points[1][2] / points[1][3] - origin[2]];
  return origin.every(Number.isFinite) && direction.every(Number.isFinite) ? {origin, direction} : null;
}
