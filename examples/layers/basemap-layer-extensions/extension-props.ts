// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** `[longitude, latitude]`, in degrees. */
export type Position = [number, number];

/**
 * The filter value of a feature that is not a building. It is the top of the filter range, so the
 * filter always keeps the feature.
 */
export const NOT_A_BUILDING = 100_000;

const METERS_PER_DEGREE = 111_320;
const CIRCLE_SEGMENTS = 96;

/** A closed ring of positions, `radius` meters around `center`. */
export function getCircle(center: Readonly<Position>, radius: number): Position[] {
  const [longitude, latitude] = center;
  const radiusLatitude = radius / METERS_PER_DEGREE;
  const radiusLongitude = radiusLatitude / Math.cos((latitude * Math.PI) / 180);
  const ring: Position[] = [];
  for (let i = 0; i <= CIRCLE_SEGMENTS; i++) {
    const angle = (2 * Math.PI * (i % CIRCLE_SEGMENTS)) / CIRCLE_SEGMENTS;
    ring.push([
      longitude + radiusLongitude * Math.cos(angle),
      latitude + radiusLatitude * Math.sin(angle)
    ]);
  }
  return ring;
}

/**
 * The `getFilterValue` of `DataFilterExtension` on a basemap. Each sublayer of the basemap calls it
 * with its own features: the fills, lines and labels of each source layer, and the background. A
 * building of the OpenMapTiles schema gives its `render_height`, in meters. All other features give
 * `NOT_A_BUILDING`.
 */
export function getBuildingFilterValue(feature: unknown): number {
  const properties = (feature as {properties?: Record<string, unknown>} | null)?.properties;
  if (properties?.layerName !== 'building') {
    return NOT_A_BUILDING;
  }
  const height = Number(properties.render_height);
  return Number.isFinite(height) ? height : 0;
}
