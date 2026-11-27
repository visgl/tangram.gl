// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {lngLatToWorld, worldToLngLat} from '@math.gl/geospatial';

/** The spherical Earth radius used by EPSG:3857, in meters. */
export const MERCATOR_RADIUS = 6378137;
/** The distance from the prime meridian to the antimeridian, in meters. */
export const HALF_CIRCUMFERENCE_METERS = Math.PI * MERCATOR_RADIUS;
/** The width of the Web Mercator world, in meters. */
export const CIRCUMFERENCE_METERS = HALF_CIRCUMFERENCE_METERS * 2;
/** Tangram's reference tile width in pixels. */
export const TILE_SIZE = 256;

const MATH_GL_WORLD_SIZE = 512;

/** Return projected meters per reference pixel at the given zoom. */
export function metersPerPixel(zoom: number): number {
  return CIRCUMFERENCE_METERS / TILE_SIZE / Math.pow(2, zoom);
}

/** Return projected meters per tile at the given zoom and world width. */
export function metersPerTile(zoom: number, circumference = CIRCUMFERENCE_METERS): number {
  return circumference / Math.pow(2, zoom);
}

/** Return the northwest corner of an XYZ tile in east- and north-positive meters. */
export function metersForTile(
  tile: {x: number; y: number; z: number},
  circumference = CIRCUMFERENCE_METERS,
  halfCircumference = HALF_CIRCUMFERENCE_METERS
): {x: number; y: number} {
  return {
    x: tile.x * circumference / Math.pow(2, tile.z) - halfCircumference,
    y: -(tile.y * circumference / Math.pow(2, tile.z) - halfCircumference)
  };
}

/** Return the XYZ tile containing an east- and north-positive meter position. */
export function tileForMeters(
  [x, y]: readonly number[],
  zoom: number,
  circumference = CIRCUMFERENCE_METERS,
  halfCircumference = HALF_CIRCUMFERENCE_METERS
): {x: number; y: number; z: number} {
  const span = metersPerTile(zoom, circumference);
  return {
    x: Math.floor((x + halfCircumference) / span),
    y: Math.floor((-y + halfCircumference) / span),
    z: zoom
  };
}

/** Wrap XYZ tile indices on the selected axes, wrapping only X by default. */
export function wrapTile(
  {x, y, z}: {x: number; y: number; z: number},
  mask = {x: true, y: false}
): {x: number; y: number; z: number} {
  const indexMask = (1 << z) - 1;
  if (mask.x) {
    x = x & indexMask;
  }
  if (mask.y) {
    y = y & indexMask;
  }
  return {x, y, z};
}

/** Return whether a normalized world coordinate lies on a slippy-map tile edge. */
function isTileBoundary(worldCoordinate: number): boolean {
  // Every boundary through zoom 30 is an integer at zoom 30.
  const tileCoordinate = worldCoordinate * 2 ** 30;
  const nearestBoundary = Math.round(tileCoordinate);
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(tileCoordinate)) * 4;
  return Math.abs(tileCoordinate - nearestBoundary) <= floatingPointTolerance;
}

/** Project longitude and latitude in degrees to east- and north-positive Web Mercator meters. */
export function latLngToMeters(coordinates: readonly [number, number]): [number, number] {
  const [worldX, worldY] = lngLatToWorld([coordinates[0], coordinates[1]]);
  const normalizedWorldX = worldX / MATH_GL_WORLD_SIZE;
  const normalizedWorldY = worldY / MATH_GL_WORLD_SIZE;
  if (isTileBoundary(normalizedWorldX) || isTileBoundary(normalizedWorldY)) {
    // Preserve Tangram's rounding at tile edges.
    const longitude = coordinates[0] * (HALF_CIRCUMFERENCE_METERS / 180);
    const latitude =
      (Math.log(Math.tan((coordinates[1] * Math.PI) / 360 + Math.PI / 4)) / Math.PI) *
      HALF_CIRCUMFERENCE_METERS;
    return [longitude, latitude];
  }
  return [
    normalizedWorldX * CIRCUMFERENCE_METERS - HALF_CIRCUMFERENCE_METERS,
    normalizedWorldY * CIRCUMFERENCE_METERS - HALF_CIRCUMFERENCE_METERS
  ];
}

/** Convert east- and north-positive Web Mercator meters to longitude and latitude in degrees. */
export function metersToLatLng(coordinates: readonly [number, number]): [number, number] {
  const worldX =
    ((coordinates[0] + HALF_CIRCUMFERENCE_METERS) / CIRCUMFERENCE_METERS) * MATH_GL_WORLD_SIZE;
  const worldY =
    ((coordinates[1] + HALF_CIRCUMFERENCE_METERS) / CIRCUMFERENCE_METERS) * MATH_GL_WORLD_SIZE;
  return worldToLngLat([worldX, worldY]);
}
