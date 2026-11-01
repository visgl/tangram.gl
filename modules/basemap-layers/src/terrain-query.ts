// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Viewport} from '@deck.gl/core';
import {Matrix4} from '@math.gl/core';

import type {TerrainSurface, TerrainSurfaceHit} from '@loaders.gl/raster/terrain';

/**
 * Route an absolute top-origin CSS pixel through one actual deck viewport/eye.
 * commonToSurface must be a finite affine transform from that viewport's common
 * coordinates to the provider's content coordinates, including units and offsets.
 * No geographic projection, globe radius, exaggeration or datum conversion is guessed.
 * The provider remains responsible for matching the currently displayed generation.
 */
export function pickTerrainSurface(
  viewport: Pick<Viewport, 'x' | 'y' | 'width' | 'height' | 'viewProjectionMatrix'>,
  pixel: readonly [number, number],
  surface: TerrainSurface,
  commonToSurface: Readonly<ArrayLike<number>>
): TerrainSurfaceHit | null {
  if (
    commonToSurface.length !== 16 ||
    !Array.from(commonToSurface).every(Number.isFinite) ||
    commonToSurface[3] !== 0 ||
    commonToSurface[7] !== 0 ||
    commonToSurface[11] !== 0 ||
    commonToSurface[15] !== 1
  ) {
    throw new RangeError('Terrain queries require a finite affine common-to-surface matrix');
  }
  if (
    pixel.length !== 2 ||
    !pixel.every(Number.isFinite) ||
    ![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    pixel[0] < viewport.x ||
    pixel[1] < viewport.y ||
    pixel[0] >= viewport.x + viewport.width ||
    pixel[1] >= viewport.y + viewport.height
  )
    return null;
  const conversion = new Matrix4(Array.from(commonToSurface));
  if (!Number.isFinite(conversion.determinant()) || conversion.determinant() === 0) {
    throw new RangeError('Terrain common-to-surface matrix must be invertible');
  }
  if (
    viewport.viewProjectionMatrix.length !== 16 ||
    !Array.from(viewport.viewProjectionMatrix).every(Number.isFinite)
  )
    return null;
  const projection = new Matrix4(viewport.viewProjectionMatrix);
  if (!Number.isFinite(projection.determinant()) || projection.determinant() === 0) return null;
  const transform = conversion.multiplyRight(projection.invert());
  const horizontal = (2 * (pixel[0] - viewport.x)) / viewport.width - 1;
  const vertical = 1 - (2 * (pixel[1] - viewport.y)) / viewport.height;
  const points = [-1, 1].map(depth => transform.transform([horizontal, vertical, depth, 1]));
  if (points.some(point => point[3] === 0 || !point.every(Number.isFinite))) return null;
  const origin: [number, number, number] = [
    points[0][0] / points[0][3],
    points[0][1] / points[0][3],
    points[0][2] / points[0][3]
  ];
  const direction: [number, number, number] = [
    points[1][0] / points[1][3] - origin[0],
    points[1][1] / points[1][3] - origin[1],
    points[1][2] / points[1][3] - origin[2]
  ];
  const distance = Math.hypot(...direction);
  return Number.isFinite(distance) && distance > 0
    ? surface.intersectRay({origin, direction}, distance)
    : null;
}
