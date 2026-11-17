// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// MapLibre GL JS
// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2023, MapLibre contributors

/**
 * @license
 * Portions of this file are adapted from MapLibre GL JS v6.13.0, src/source/image_source.ts and
 * src/shaders/glsl/raster.vertex.glsl, under this license (see also THIRD-PARTY-NOTICES.md):
 *
 * Copyright (c) 2023, MapLibre contributors
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *     * Redistributions of source code must retain the above copyright notice,
 *       this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright notice,
 *       this list of conditions and the following disclaimer in the documentation
 *       and/or other materials provided with the distribution.
 *     * Neither the name of MapLibre GL JS nor the names of its contributors
 *       may be used to endorse or promote products derived from this software
 *       without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import {CompositeLayer} from '@deck.gl/core';
import type {CompositeLayerProps, DefaultProps} from '@deck.gl/core';
import type {BitmapBoundingBox} from '@deck.gl/layers';
import {BitmapLayer} from '@deck.gl/layers';
import {lngLatToMercatorWorld, mercatorWorldToLngLat} from './projected-viewport';
import type {BasemapLoadOptions, BasemapSource} from './style-resolver';

/** A longitude and a latitude, in degrees. */
export type ImageSourceCorner = [number, number];

/**
 * The corners of an `image` source, as the style specification lists them: top left, top right,
 * bottom right and bottom left.
 */
export type ImageSourceCorners = [
  ImageSourceCorner,
  ImageSourceCorner,
  ImageSourceCorner,
  ImageSourceCorner
];

function isCorner(value: unknown): value is ImageSourceCorner {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}

/**
 * The `coordinates` of an `image` source, or null unless they are four `[longitude, latitude]`
 * corners of finite numbers.
 */
export function getImageSourceCorners(source: BasemapSource): ImageSourceCorners | null {
  const {coordinates} = source;
  return Array.isArray(coordinates) && coordinates.length === 4 && coordinates.every(isCorner)
    ? (coordinates.map(([longitude, latitude]) => [longitude, latitude]) as ImageSourceCorners)
    : null;
}

/** Whether a source is an `image` source that can draw: one with a `url` and valid corners. */
export function isDrawableImageSource(source: BasemapSource | undefined): boolean {
  return (
    source?.type === 'image' &&
    typeof source.url === 'string' &&
    source.url.length > 0 &&
    getImageSourceCorners(source) !== null
  );
}

/**
 * The `bounds` of a `BitmapLayer` over the corners of an image: bottom left, top left, top right
 * and bottom right. `ImageQuadLayer` draws its own mesh, but a change of bounds rebuilds it.
 */
export function getImageSourceBounds([
  topLeft,
  topRight,
  bottomRight,
  bottomLeft
]: ImageSourceCorners): BitmapBoundingBox {
  return [bottomLeft, topLeft, topRight, bottomRight];
}

/**
 * How much a warp may foreshorten the image, as the ratio between the largest and the smallest
 * homogeneous denominator over the quad, while staying purely projective (MapLibre's value).
 */
const PROJECTIVE_FORESHORTENING = 4;

/** The foreshortening at which a warp is taken to be purely bilinear (MapLibre's value). */
const BILINEAR_FORESHORTENING = 512;

/**
 * The grid cells along each side of the mesh of a quad that is not a parallelogram. Within a cell
 * the image is mapped linearly, so the drawn image departs from the warp by a small fraction of a
 * cell: MapLibre GL JS draws a projective warp exactly, and a blended one on 16 cells.
 */
const WARP_GRID_CELLS = 32;

/**
 * How an image is warped onto its corners, as MapLibre GL JS warps it (`ImageSource` with its
 * default `auto` warp): `[perspectiveX, perspectiveY, blend]`. The first two are the perspective
 * terms of the projective mapping of the unit square onto the corners, and `blend` mixes that
 * mapping towards the bilinear one: 0 is purely projective, 1 purely bilinear. A parallelogram,
 * and a quad with no perspective view (concave, self-crossing or collinear), is warped bilinearly.
 */
export type ImageWarp = [number, number, number];

const BILINEAR_WARP: ImageWarp = [0, 0, 1];

/** The corners in Web Mercator world units, y up. */
function getWorldCorners(corners: ImageSourceCorners): [number, number][] {
  return corners.map(corner => lngLatToMercatorWorld(corner));
}

/**
 * Whether the corners form a parallelogram, which every warp maps affinely. Compared relative to
 * the size of the quad: MapLibre compares corners rounded to its tile grid.
 */
function isParallelogram([topLeft, topRight, bottomRight, bottomLeft]: [number, number][]): boolean {
  const size = Math.hypot(bottomRight[0] - topLeft[0], bottomRight[1] - topLeft[1]);
  const epsilon = size * 1e-9;
  return (
    Math.abs(topLeft[0] + bottomRight[0] - topRight[0] - bottomLeft[0]) <= epsilon &&
    Math.abs(topLeft[1] + bottomRight[1] - topRight[1] - bottomLeft[1]) <= epsilon
  );
}

/**
 * How far a warp of the given foreshortening is blended towards the bilinear one: purely
 * projective up to `PROJECTIVE_FORESHORTENING`, purely bilinear at `BILINEAR_FORESHORTENING`.
 */
function getBilinearBlend(foreshortening: number): number {
  const ramp =
    (1 - PROJECTIVE_FORESHORTENING / foreshortening) /
    (1 - PROJECTIVE_FORESHORTENING / BILINEAR_FORESHORTENING);
  return Math.max(0, ramp);
}

/**
 * The warp of an image onto its corners, with MapLibre GL JS's `calculateImageWarp`, in Web
 * Mercator space. A warp is the same in any frame that differs by an affine map, so y up gives
 * the warp of MapLibre's y-down tile space.
 */
export function getImageWarp(corners: ImageSourceCorners): ImageWarp {
  const world = getWorldCorners(corners);
  if (isParallelogram(world)) {
    return BILINEAR_WARP;
  }
  const [topLeft, topRight, bottomRight, bottomLeft] = world;
  const sumX = topLeft[0] - topRight[0] + bottomRight[0] - bottomLeft[0];
  const sumY = topLeft[1] - topRight[1] + bottomRight[1] - bottomLeft[1];
  const rightX = topRight[0] - bottomRight[0];
  const rightY = topRight[1] - bottomRight[1];
  const downX = bottomLeft[0] - bottomRight[0];
  const downY = bottomLeft[1] - bottomRight[1];
  const determinant = rightX * downY - downX * rightY;
  const perspectiveX = (sumX * downY - downX * sumY) / determinant;
  const perspectiveY = (rightX * sumY - sumX * rightY) / determinant;

  // The homogeneous denominator at the corners of the unit square, one at the top left. It stays
  // finite and positive over the quad exactly while the quad is a perspective view of the image.
  const denominators = [1, 1 + perspectiveX, 1 + perspectiveX + perspectiveY, 1 + perspectiveY];
  const foreshortening = Math.max(...denominators) / Math.min(...denominators);
  const blend = getBilinearBlend(foreshortening);
  if (!(foreshortening >= 1 && foreshortening <= BILINEAR_FORESHORTENING) || blend >= 1) {
    return BILINEAR_WARP;
  }
  return [perspectiveX, perspectiveY, blend];
}

/**
 * The place of a point of the image, `u` right and `v` down from its top left corner in 0 to 1, in
 * the same units as the corners: MapLibre's raster vertex shader.
 */
export function warpImagePoint(
  [topLeft, topRight, bottomRight, bottomLeft]: [number, number][],
  [perspectiveX, perspectiveY, blend]: ImageWarp,
  u: number,
  v: number
): [number, number] {
  const point: [number, number] = [0, 0];
  const denominator = perspectiveX * u + perspectiveY * v + 1;
  for (let axis = 0; axis < 2; axis++) {
    const top = topLeft[axis] + (topRight[axis] - topLeft[axis]) * u;
    const bottom = bottomLeft[axis] + (bottomRight[axis] - bottomLeft[axis]) * u;
    const bilinear = top + (bottom - top) * v;
    const acrossTop = topRight[axis] - topLeft[axis] + perspectiveX * topRight[axis];
    const downLeft = bottomLeft[axis] - topLeft[axis] + perspectiveY * bottomLeft[axis];
    const projective = (acrossTop * u + downLeft * v + topLeft[axis]) / denominator;
    point[axis] = projective + (bilinear - projective) * blend;
  }
  return point;
}

/** A mesh of an image, as `BitmapLayer` draws it. */
export type ImageMesh = {
  /** The count of indices. */
  vertexCount: number;
  /** Longitude, latitude and 0 of each vertex. */
  positions: Float64Array;
  indices: Uint32Array;
  /** The image coordinates of each vertex, with v down. */
  texCoords: Float32Array;
};

/**
 * The mesh of an image warped onto its corners (see `getImageWarp`). A parallelogram is one cell,
 * split from its bottom left to its top right corner as MapLibre splits it; another quad is a grid
 * of `WARP_GRID_CELLS`, or of more cells where `subdivisionStep` (degrees, on a globe) asks for
 * them. The vertices are placed in Web Mercator space, so the image is uniform there, as in MapLibre.
 */
export function createImageMesh(corners: ImageSourceCorners, subdivisionStep = 0): ImageMesh {
  const world = getWorldCorners(corners);
  const warp = getImageWarp(corners);
  let cells = isParallelogram(world) ? 1 : WARP_GRID_CELLS;
  if (subdivisionStep > 0) {
    const longitudes = corners.map(corner => corner[0]);
    const latitudes = corners.map(corner => corner[1]);
    const span = Math.max(
      Math.max(...longitudes) - Math.min(...longitudes),
      Math.max(...latitudes) - Math.min(...latitudes)
    );
    cells = Math.max(cells, Math.ceil(span / subdivisionStep));
  }
  const side = cells + 1;
  const positions = new Float64Array(side * side * 3);
  const texCoords = new Float32Array(side * side * 2);
  const indices = new Uint32Array(cells * cells * 6);
  let index = 0;
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const vertex = row * side + column;
      const u = column / cells;
      const v = row / cells;
      positions.set(mercatorWorldToLngLat(warpImagePoint(world, warp, u, v)), vertex * 3);
      texCoords[vertex * 2] = u;
      texCoords[vertex * 2 + 1] = v;
      if (row > 0 && column > 0) {
        const bottomRight = vertex;
        const bottomLeft = vertex - 1;
        const topRight = vertex - side;
        const topLeft = vertex - side - 1;
        indices.set([topRight, topLeft, bottomLeft, topRight, bottomLeft, bottomRight], index);
        index += 6;
      }
    }
  }
  return {vertexCount: indices.length, positions, indices, texCoords};
}

/**
 * Whether the corners are listed counterclockwise on the map, which mirrors the image. Its
 * triangles then face away, and a globe, which culls back faces, must cull front faces instead, as
 * MapLibre GL JS does. Measured in Web Mercator space, as MapLibre measures it.
 */
export function hasFlippedWinding([topLeft, topRight, bottomRight]: ImageSourceCorners): boolean {
  const [x0, y0] = lngLatToMercatorWorld(topLeft);
  const [x1, y1] = lngLatToMercatorWorld(topRight);
  const [x2, y2] = lngLatToMercatorWorld(bottomRight);
  // Mercator world y is up: clockwise corners turn with a negative cross product.
  return (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0) > 0;
}

/** A `BitmapLayer` that draws an image warped onto four corners (see `createImageMesh`). */
class ImageQuadLayer extends BitmapLayer<{corners: ImageSourceCorners}> {
  static layerName = 'ImageQuadLayer';

  protected _createMesh() {
    return createImageMesh(this.props.corners, this.getSubdivisionStep()) as ReturnType<
      BitmapLayer['_createMesh']
    >;
  }
}

/** Props of {@link ImageSourceLayer}. */
export type ImageSourceLayerProps = CompositeLayerProps & {
  /** The URL of the image, loaded with the layer's `fetch` and `loadOptions`. */
  image: string;
  /** The corners the image is drawn at (see {@link getImageSourceCorners}). */
  corners: ImageSourceCorners;
  /** The texture parameters of the image, or null for the defaults of `BitmapLayer`. */
  textureParameters?: Record<string, unknown> | null;
  /** The load options of the basemap, for the image. */
  loadOptions?: BasemapLoadOptions | null;
};

const defaultProps: DefaultProps<ImageSourceLayerProps> = {
  image: '',
  corners: {
    type: 'array',
    value: [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0]
    ],
    compare: true
  },
  textureParameters: {type: 'object', value: null, compare: true},
  loadOptions: {type: 'object', value: null, compare: true}
};

/**
 * Draws a `raster` style layer over an `image` source: one image warped onto four corners, as
 * MapLibre GL JS draws it. The layer's extensions (`RasterColorExtension`) pass to the image, as
 * they pass to each tile of a raster tile layer.
 */
export class ImageSourceLayer extends CompositeLayer<ImageSourceLayerProps> {
  static layerName = 'ImageSourceLayer';
  static defaultProps = defaultProps;

  renderLayers() {
    const {image, corners, textureParameters, loadOptions} = this.props;
    const subLayerProps = this.getSubLayerProps({id: 'image'});
    // Set by `RasterColorExtension` where its shader runs, which outputs premultiplied colors.
    const blendParameters = subLayerProps.rasterColorBlendParameters as object | null | undefined;
    return new ImageQuadLayer({
      ...subLayerProps,
      // A texture keeps the filter it was created with, so a filter change needs a new layer.
      id: textureParameters ? `${subLayerProps.id}-filtered` : subLayerProps.id,
      ...(loadOptions ? {loadOptions} : {}),
      image,
      corners,
      bounds: getImageSourceBounds(corners),
      textureParameters,
      parameters: blendParameters
        ? {...subLayerProps.parameters, ...blendParameters}
        : subLayerProps.parameters
    } as any);
  }
}
