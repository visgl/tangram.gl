// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {projectLngLatToMetersLegacy} from './web-mercator-legacy';

const WORLD_SIZE = 512;
const HALF_CIRCUMFERENCE_METERS = 20037508.342789244;
const CIRCUMFERENCE_METERS = HALF_CIRCUMFERENCE_METERS * 2;

/** Return whether a normalized world coordinate lies on a slippy-map tile edge. */
function isTileBoundary(worldCoordinate: number): boolean {
  for (let zoom = 0; zoom <= 30; zoom++) {
    const tileCoordinate = worldCoordinate * 2 ** zoom;
    const nearestBoundary = Math.round(tileCoordinate);
    const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(tileCoordinate)) * 4;
    if (Math.abs(tileCoordinate - nearestBoundary) <= floatingPointTolerance) {
      return true;
    }
  }
  return false;
}

/** Project longitude/latitude degrees to Tangram Web Mercator meters using math.gl. */
export function projectLngLatToMetersWithMath(
  coordinates: readonly [number, number]
): [number, number] {
  const [worldX, worldY] = lngLatToWorld([coordinates[0], coordinates[1]]);
  const normalizedWorldX = worldX / WORLD_SIZE;
  const normalizedWorldY = worldY / WORLD_SIZE;
  const legacyMeters =
    isTileBoundary(normalizedWorldX) || isTileBoundary(normalizedWorldY)
      ? projectLngLatToMetersLegacy(coordinates)
      : undefined;
  return [
    legacyMeters?.[0] ?? normalizedWorldX * CIRCUMFERENCE_METERS - HALF_CIRCUMFERENCE_METERS,
    // math.gl 4.x world Y is north-positive: latitude +40 maps above WORLD_SIZE / 2.
    legacyMeters?.[1] ?? normalizedWorldY * CIRCUMFERENCE_METERS - HALF_CIRCUMFERENCE_METERS
  ];
}

/** Unproject Tangram Web Mercator meters to longitude/latitude degrees using math.gl. */
export function unprojectMetersToLngLatWithMath(
  coordinates: readonly [number, number]
): [number, number] {
  const worldX =
    ((coordinates[0] + HALF_CIRCUMFERENCE_METERS) / CIRCUMFERENCE_METERS) * WORLD_SIZE;
  // Preserve math.gl's north-positive world-Y convention for the inverse transform.
  const worldY =
    ((coordinates[1] + HALF_CIRCUMFERENCE_METERS) / CIRCUMFERENCE_METERS) * WORLD_SIZE;
  return worldToLngLat([worldX, worldY]) as [number, number];
}
