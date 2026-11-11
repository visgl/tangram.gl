// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Viewport} from '@deck.gl/core';
import {Matrix4} from '@math.gl/core';
import {containsScreenPixel, unprojectScreenSegment} from '@tangram.gl/map-utils/screen-ray';

/** Structural loaders.gl-compatible hit, separating displayed geometry from source elevation. */
export type TerrainSurfaceHit = {
  /** Displayed content position, in the same units as the query ray. */
  readonly position: readonly [number, number, number];
  /** Longitude/latitude degrees and physical, unexaggerated source elevation meters. */
  readonly coordinate: readonly [number, number, number];
  /** Distance in content units, independent of direction length. */
  readonly distance: number;
  /** Unit normal following displayed triangle winding. */
  readonly normal: readonly [number, number, number];
  /** Original triangle identity, not a GPU feature index. */
  readonly triangleIndex: number;
  /** Weights in original vertex order. */
  readonly barycentric: readonly [number, number, number];
};

/**
 * Borrowed displayed terrain query owner. Structurally compatible with loaders.gl 5
 * and Tangram without requiring either renderer or an alpha dependency upgrade.
 */
export type TerrainSurface = {
  /** Mercator XYZ meters or host-defined center-relative globe common units. */
  readonly projection: 'web-mercator' | 'globe';
  /** Nearest loaded hit inside the inclusive distance; a miss does not certify coverage. */
  intersectRay(
    ray: {
      /** Absolute content origin, before camera and room-placement transforms. */
      readonly origin: readonly [number, number, number];
      /** Nonzero finite direction, not necessarily normalized. */
      readonly direction: readonly [number, number, number];
    },
    maxDistance?: number
  ): TerrainSurfaceHit | null;
};

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
  // deck viewports require an explicit origin; the shared helper also accepts omitted origins.
  if (!Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) ||
      !containsScreenPixel(viewport, pixel)) return null;
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
  const segment = unprojectScreenSegment(transform, viewport, pixel);
  if (!segment) return null;
  const distance = Math.hypot(...segment.direction);
  return Number.isFinite(distance) && distance > 0
    ? surface.intersectRay(segment, distance)
    : null;
}
