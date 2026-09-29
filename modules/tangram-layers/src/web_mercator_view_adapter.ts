// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

const DECK_TO_TANGRAM_ZOOM_OFFSET = 1;
const DECK_WORLD_SIZE = 512;
const TANGRAM_HALF_WORLD_METERS = 20037508.342789244;

type Matrix = ArrayLike<number>;

interface DistanceScales {
  unitsPerMeter?: ArrayLike<number>;
}

interface WebMercatorViewport {
  longitude?: number;
  latitude?: number;
  zoom?: number;
  pitch?: number;
  height?: number;
  isGeospatial?: boolean;
  viewMatrix?: Matrix | null;
  projectionMatrix?: Matrix | null;
  distanceScales?: DistanceScales;
  getDistanceScales?: () => DistanceScales;
}

interface RenderDimensions {
  width: number;
  height: number;
}

interface TangramCameraFrame {
  view: Float64Array;
  projection: Float32Array;
  position: number[];
}

/**
 * Adapts deck.gl Web Mercator viewports to Tangram's host-frame contract.
 *
 * The adapter keeps deck-specific viewport validation and matrix conversion
 * out of the layer lifecycle while preserving Tangram's EPSG:3857 meter frame.
 */
export default class WebMercatorViewAdapter {
  /**
   * Checks that a deck viewport provides the public Web Mercator contract used
   * by TangramLayer.
   * @param viewport deck.gl viewport.
   * @returns Validation error, or null when supported.
   */
  static validateViewport(viewport: WebMercatorViewport): Error | null {
    if (viewport?.isGeospatial === false) {
      return new Error('a Web Mercator viewport is required');
    }
    if (WebMercatorViewAdapter.validateGeographicAnchor(viewport, 'Web Mercator viewport')) {
      return new Error('a Web Mercator viewport is required');
    }
    return null;
  }

  /**
   * Validates the geographic anchor shared by all deck.gl view adapters.
   * @param viewport deck.gl viewport.
   * @param viewportName View name used in the error message.
   * @returns Validation error, or null when the anchor is finite.
   */
  static validateGeographicAnchor(
    viewport: WebMercatorViewport,
    viewportName = 'viewport'
  ): Error | null {
    if (
      !Number.isFinite(viewport?.longitude) ||
      !Number.isFinite(viewport?.latitude) ||
      !Number.isFinite(viewport?.zoom)
    ) {
      return new Error(`${viewportName} requires finite longitude, latitude, and zoom`);
    }
    return null;
  }

  /**
   * Converts deck.gl camera matrices to Tangram camera matrices.
   *
   * Tangram tile models use absolute EPSG:3857 meters while deck matrices
   * consume zoom-zero common coordinates. Altitude uses deck's
   * latitude-dependent distance scale.
   * @param viewport deck.gl WebMercatorViewport.
   * @returns Tangram camera matrices and eye position.
   */
  static getCameraFrame(viewport: WebMercatorViewport): TangramCameraFrame {
    const distanceScales =
      typeof viewport.getDistanceScales === 'function'
        ? viewport.getDistanceScales()
        : viewport.distanceScales;
    const unitsPerMeter = distanceScales && distanceScales.unitsPerMeter;
    const viewMatrix = viewport.viewMatrix;
    const projectionMatrix = viewport.projectionMatrix;
    if (
      !viewMatrix ||
      viewMatrix.length !== 16 ||
      !projectionMatrix ||
      projectionMatrix.length !== 16 ||
      !unitsPerMeter ||
      !Number.isFinite(unitsPerMeter[2])
    ) {
      throw new Error('deck viewport camera matrices and distance scales are required');
    }

    const xyScale = DECK_WORLD_SIZE / (TANGRAM_HALF_WORLD_METERS * 2);
    const metersToCommon = new Float64Array(16);
    metersToCommon[0] = xyScale;
    metersToCommon[5] = xyScale;
    metersToCommon[10] = unitsPerMeter[2];
    metersToCommon[12] = DECK_WORLD_SIZE / 2;
    metersToCommon[13] = DECK_WORLD_SIZE / 2;
    metersToCommon[15] = 1;

    return {
      view: multiplyMatrices(viewMatrix, metersToCommon),
      projection: new Float32Array(projectionMatrix),
      // The view matrix places the camera at the origin in eye coordinates.
      position: [0, 0, 0]
    };
  }

  /**
   * Builds Tangram's external-camera frame for a deck.gl MapView.
   * @param viewport deck.gl WebMercatorViewport.
   * @param dimensions Render-target size.
   * @returns Tangram HostFrame legacy shape.
   */
  static getFrame(
    viewport: WebMercatorViewport,
    {width, height}: RenderDimensions
  ): {
    viewport: RenderDimensions;
    view: {longitude: number; latitude: number; zoom: number};
    projection: {type: 'web-mercator'};
    camera: TangramCameraFrame;
    tileBuffer: number;
  } {
    const longitude = viewport.longitude;
    const latitude = viewport.latitude;
    const zoom = viewport.zoom;
    if (
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      typeof zoom !== 'number' ||
      !Number.isFinite(zoom)
    ) {
      throw new Error('a Web Mercator viewport is required');
    }
    const pitch = (Math.abs(viewport.pitch || 0) * Math.PI) / 180;
    return {
      viewport: {width, height},
      view: {
        longitude,
        latitude,
        zoom: zoom + DECK_TO_TANGRAM_ZOOM_OFFSET
      },
      projection: {type: 'web-mercator'},
      camera: WebMercatorViewAdapter.getCameraFrame(viewport),
      tileBuffer: Math.min(4, Math.ceil((Math.tan(pitch) * (viewport.height || height)) / 256))
    };
  }
}

function multiplyMatrices(left: Matrix, right: Matrix): Float64Array {
  const result = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let index = 0; index < 4; index++) {
        value += left[index * 4 + row] * right[column * 4 + index];
      }
      result[column * 4 + row] = value;
    }
  }
  return result;
}
