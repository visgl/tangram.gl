// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';

/** Unproject an absolute, top-origin CSS pixel to the finite clip-space segment. */
export function unprojectScreenSegment(
  inverse: Matrix4,
  viewport: {x?: number; y?: number; width: number; height: number},
  pixel: readonly [number, number]
): {origin: [number, number, number]; direction: [number, number, number]} | null {
  const horizontal = 2 * (pixel[0] - (viewport.x ?? 0)) / viewport.width - 1;
  const vertical = 1 - 2 * (pixel[1] - (viewport.y ?? 0)) / viewport.height;
  const points = [-1, 1].map(depth => inverse.transform([horizontal, vertical, depth, 1]));
  if (points.some(point => point[3] === 0 || !point.every(Number.isFinite))) return null;
  const origin: [number, number, number] = [points[0][0] / points[0][3], points[0][1] / points[0][3], points[0][2] / points[0][3]];
  const direction: [number, number, number] = [points[1][0] / points[1][3] - origin[0], points[1][1] / points[1][3] - origin[1], points[1][2] / points[1][3] - origin[2]];
  return origin.every(Number.isFinite) && direction.every(Number.isFinite) ? {origin, direction} : null;
}
