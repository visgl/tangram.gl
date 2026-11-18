// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** `[west, south, east, north]` in degrees. */
export type LngLatBounds = [number, number, number, number];

type MapViewState = {longitude: number; latitude: number; zoom: number; minZoom?: number};

/** The size of the world in pixels at zoom 0, as in deck.gl and MapLibre. */
const WORLD_SIZE = 512;

/**
 * Moves the view, and zooms in when necessary, so that a `width` by `height` viewport shows only
 * the area in `bounds`. deck.gl `MapView` has no `maxBounds`, so the example applies this to each
 * view state. A `bounds` that spans 360 degrees of longitude limits only the latitude: the map
 * repeats east and west. The view must have no pitch and no bearing.
 */
export function fitViewState<ViewStateT extends MapViewState>(
  viewState: ViewStateT,
  bounds: LngLatBounds,
  width: number,
  height: number
): ViewStateT {
  const [west, south, east, north] = bounds;
  const limitX = east - west < 360;
  const x0 = lngToX(west);
  const x1 = lngToX(east);
  const y0 = latToY(north);
  const y1 = latToY(south);

  let zoom = Math.max(viewState.zoom, viewState.minZoom ?? -Infinity);
  zoom = Math.max(zoom, Math.log2(height / (WORLD_SIZE * (y1 - y0))));
  if (limitX) {
    zoom = Math.max(zoom, Math.log2(width / (WORLD_SIZE * (x1 - x0))));
  }

  const scale = WORLD_SIZE * 2 ** zoom;
  const halfWidth = width / 2 / scale;
  const halfHeight = height / 2 / scale;
  const x = limitX
    ? clamp(lngToX(viewState.longitude), x0 + halfWidth, x1 - halfWidth)
    : lngToX(viewState.longitude);
  const y = clamp(latToY(viewState.latitude), y0 + halfHeight, y1 - halfHeight);

  return {...viewState, longitude: xToLng(x), latitude: yToLat(y), zoom};
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Web Mercator x, 0 at 180 degrees west and 1 at 180 degrees east. */
function lngToX(longitude: number): number {
  return (longitude + 180) / 360;
}

function xToLng(x: number): number {
  return x * 360 - 180;
}

/** Web Mercator y, 0 at the north edge of the world and 1 at the south edge. */
function latToY(latitude: number): number {
  const phi = (latitude * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
}

function yToLat(y: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}
