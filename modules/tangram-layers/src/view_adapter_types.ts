// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** deck.gl's planar camera surface, independent of concrete viewport subclasses. */
export interface PlanarCameraViewport {
  longitude?: number;
  latitude?: number;
  zoom?: number;
  pitch?: number;
  height?: number;
  isGeospatial?: boolean;
  viewMatrix?: ArrayLike<number> | null;
  projectionMatrix?: ArrayLike<number> | null;
  distanceScales?: {unitsPerMeter?: ArrayLike<number>};
  getDistanceScales?: () => {unitsPerMeter?: ArrayLike<number>};
}

/** Public methods required to derive a FirstPersonView ground footprint. */
export interface FirstPersonViewport extends PlanarCameraViewport {
  width: number;
  height: number;
  position?: ArrayLike<number>;
  unproject?: (pixel: number[], options?: {targetZ: number}) => number[];
  projectFlat?: (coordinate: number[]) => number[];
  unprojectFlat?: (coordinate: number[]) => number[];
}

/** Public GlobeView matrix and geographic-bounds contract. */
export interface GlobeViewport {
  width: number;
  height: number;
  longitude: number;
  latitude: number;
  zoom: number;
  viewMatrix?: ArrayLike<number>;
  projectionMatrix?: ArrayLike<number>;
  cameraPosition?: ArrayLike<number>;
  getBounds?: (options: {z: number}) => unknown;
}
