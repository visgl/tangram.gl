// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {isGlobeViewport} from './is-globe-viewport';

/** deck.gl's `PROJECTION_MODE.CUSTOM_GEOSPATIAL`: the mode of a `_CustomProjectionViewport`. */
const PROJECTION_MODE_CUSTOM_GEOSPATIAL = 3;

/** The size of the Web Mercator world, in deck.gl common units. */
export const MERCATOR_WORLD_SIZE = 512;

/** The latitude of the top edge of the Web Mercator tile pyramid. */
export const MAX_MERCATOR_LATITUDE = 85.051129;

/** The pixels between the two samples that measure the scale of a view. */
const SCALE_SAMPLE_PIXELS = 16;

/**
 * What the projected draw mode reads of a deck.gl viewport. `project` and `unproject` convert
 * between longitude/latitude and top-left pixels, through the view's projection. `project` also
 * returns the depth of a position given with an elevation: 0 to 1 in front of the camera.
 */
export type ProjectedViewportLike = {
  width: number;
  height: number;
  zoom: number;
  project: (lngLat: number[]) => number[];
  unproject: (pixel: number[]) => number[];
  /**
   * Converts longitude/latitude to the view's map plane, before the camera. With it, the tile
   * selection finds the tiles that the projection stretches (see `getProjectedTileIndices`).
   */
  projectPosition?: (lngLat: number[]) => number[];
  /**
   * The projection of the view: deck.gl's descriptor of its coordinate reference system. Views of
   * one projection have the same object, so what the tile selection measures of the projection,
   * and not of the camera, is kept by it.
   */
  crs?: object;
};

/**
 * Whether a viewport draws longitude/latitude positions through a projected coordinate reference
 * system (deck.gl's `_CustomProjectionView`), including across copies of deck.gl.
 */
export function isProjectedViewport(viewport: unknown): boolean {
  if (!viewport || typeof viewport !== 'object') {
    return false;
  }
  const {projectionMode} = viewport as {projectionMode?: unknown};
  return projectionMode === PROJECTION_MODE_CUSTOM_GEOSPATIAL;
}

/**
 * Whether tile geometry is drawn from longitude/latitude positions in a viewport, and not from
 * tile-local positions: on a globe and in a projected view. Web Mercator tiles are squares only
 * in a Web Mercator view.
 */
export function isGeographicViewport(viewport: unknown): boolean {
  return isGlobeViewport(viewport) || isProjectedViewport(viewport);
}

/** Converts longitude/latitude to the Web Mercator world, `MERCATOR_WORLD_SIZE` wide, y up. */
export function lngLatToMercatorWorld(lngLat: ArrayLike<number>): [number, number] {
  const latitude = Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, lngLat[1]));
  const phi = (latitude * Math.PI) / 180;
  return [
    (MERCATOR_WORLD_SIZE * (lngLat[0] + 180)) / 360,
    (MERCATOR_WORLD_SIZE * (Math.PI + Math.log(Math.tan(Math.PI / 4 + phi / 2)))) / (2 * Math.PI)
  ];
}

/** Converts a Web Mercator world position, y up, to longitude/latitude. */
export function mercatorWorldToLngLat(world: ArrayLike<number>): [number, number] {
  const lambda = (world[0] / MERCATOR_WORLD_SIZE) * 2 * Math.PI - Math.PI;
  const phi = 2 * (Math.atan(Math.exp((world[1] / MERCATOR_WORLD_SIZE) * 2 * Math.PI - Math.PI)) - Math.PI / 4);
  return [(lambda * 180) / Math.PI, (phi * 180) / Math.PI];
}

const mercatorZooms = new WeakMap<object, number>();

/**
 * The zoom at which a Web Mercator map has the scale of a projected view at its center: the zoom
 * styles are evaluated at and tiles are selected for. A projected view's own zoom counts pixels
 * per unit of its coordinate reference system, and a Web Mercator zoom pixels per unit of a
 * projection that stretches with the latitude: the two differ by about log2(cos(latitude)).
 * Measured from two screen steps at the view center, so it holds for any projection. Returns the
 * view's own zoom where the center has no longitude/latitude.
 */
export function getMercatorZoom(viewport: ProjectedViewportLike): number {
  const cached = mercatorZooms.get(viewport);
  if (cached !== undefined) {
    return cached;
  }
  const zoom = measureMercatorZoom(viewport);
  mercatorZooms.set(viewport, zoom);
  return zoom;
}

function measureMercatorZoom(viewport: ProjectedViewportLike): number {
  const {width, height} = viewport;
  const center = [width / 2, height / 2];
  const origin = getWorldAt(viewport, center);
  const right = getWorldAt(viewport, [center[0] + SCALE_SAMPLE_PIXELS, center[1]]);
  const down = getWorldAt(viewport, [center[0], center[1] + SCALE_SAMPLE_PIXELS]);
  if (!origin || !right || !down) {
    return viewport.zoom;
  }
  const stepX = Math.hypot(right[0] - origin[0], right[1] - origin[1]);
  const stepY = Math.hypot(down[0] - origin[0], down[1] - origin[1]);
  // The geometric mean of both axes: the two differ in a projection that is not conformal.
  const worldPerPixel = Math.sqrt(stepX * stepY) / SCALE_SAMPLE_PIXELS;
  const zoom = -Math.log2(worldPerPixel);
  return Number.isFinite(zoom) ? zoom : viewport.zoom;
}

function getWorldAt(viewport: ProjectedViewportLike, pixel: number[]): [number, number] | null {
  let lngLat: number[];
  try {
    lngLat = viewport.unproject(pixel);
  } catch {
    // deck.gl throws for a pixel that its projection converts to no number.
    return null;
  }
  if (
    !Number.isFinite(lngLat[0]) ||
    !Number.isFinite(lngLat[1]) ||
    Math.abs(lngLat[1]) > MAX_MERCATOR_LATITUDE
  ) {
    return null;
  }
  return lngLatToMercatorWorld(lngLat);
}

/**
 * The zoom styles are evaluated at in a viewport: its own zoom, or in a projected view the zoom of
 * the Web Mercator map of the same scale (see `getMercatorZoom`).
 */
export function getStyleZoom(viewport: unknown): number {
  if (!viewport) {
    return 0;
  }
  return isProjectedViewport(viewport)
    ? getMercatorZoom(viewport as ProjectedViewportLike)
    : (viewport as {zoom?: number}).zoom || 0;
}

/** The longitude step, in degrees, that measures a direction in a projected view. */
const ANGLE_SAMPLE_DEGREES = 1e-4;

/**
 * The direction a projected view draws a Web Mercator direction in, in its map plane, at
 * `lngLat`: `degrees` counter-clockwise from east in Web Mercator space, to degrees
 * counter-clockwise from the x axis of the view's coordinate reference system. The two differ by
 * the projection's convergence, and in a projection that is not conformal also with the
 * direction. Returns `degrees` where the view does not project the position.
 */
export function getProjectedPlaneAngle(
  viewport: {projectPosition: (position: number[]) => number[]},
  lngLat: ArrayLike<number>,
  degrees: number
): number {
  const radians = (degrees * Math.PI) / 180;
  const cosLatitude = Math.cos((lngLat[1] * Math.PI) / 180);
  let dx: number;
  let dy: number;
  try {
    const from = viewport.projectPosition([lngLat[0], lngLat[1], 0]);
    // A Web Mercator step: its latitude part shrinks with the latitude.
    const to = viewport.projectPosition([
      lngLat[0] + ANGLE_SAMPLE_DEGREES * Math.cos(radians),
      lngLat[1] + ANGLE_SAMPLE_DEGREES * Math.sin(radians) * cosLatitude,
      0
    ]);
    dx = to[0] - from[0];
    dy = to[1] - from[1];
  } catch {
    return degrees;
  }
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return degrees;
  }
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}
