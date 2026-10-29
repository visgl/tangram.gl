// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {LegacyHostFrame} from '@tangram.gl/tangram-renderer/core';
import type {GlobeViewport} from './view_adapter_types.js';
const DECK_TO_TANGRAM_ZOOM_OFFSET = 1;

/** Scene visibility declarations, independent of the host camera's altitude. */
export type GlobeViewAdapterOptions = {
  /** Conservative maximum rendered height in geographic meters; omit if unknown. */
  maxElevation?: number;
  /** Optional host-supplied footprint enclosing ground AND elevated content. */
  visibleBounds?: readonly [number, number, number, number];
  /** Globally resident loading fallback level, integer 0–3; omit to disable. */
  preloadZoom?: number;
};

/** Typed globe projection and visibility boundary for deck.gl. */
export default class GlobeViewAdapter {
    /** Converts globe common-space matrices and visible geographic bounds. */
    static getFrame = getFrame;
}

/**
 * Converts a deck.gl GlobeViewport into Tangram's host-frame contract.
 *
 * Globe matrices consume deck common-space coordinates directly. Tangram's
 * renderer converts its EPSG:3857 tile vertices to deck's radius-256 globe in
 * the vertex shader before applying these matrices.
 * GlobeViewport already compensates its camera scale for latitude. The local
 * Mercator-to-sphere derivative cancels that compensation, so data/style zoom
 * needs only the same 512-to-256 tile-size offset as MapView, not another
 * latitude adjustment. Source tile_size and zoom_offset are applied later.
 *
 * @param {object} viewport deck.gl GlobeViewport.
 * @param options Explicit scene height and conservative geographic footprint.
 * @returns {object} Tangram HostFrame fields for a globe render view.
 */
function getFrame(viewport: GlobeViewport, options: GlobeViewAdapterOptions = {}): LegacyHostFrame {
  if (options.maxElevation !== undefined &&
    (!Number.isFinite(options.maxElevation) || options.maxElevation < 0)) {
    throw new Error('GlobeView maxElevation must be a finite non-negative number');
  }
  if (
    !viewport ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    !viewport.viewMatrix ||
    viewport.viewMatrix.length !== 16 ||
    !viewport.projectionMatrix ||
    viewport.projectionMatrix.length !== 16 ||
    !viewport.cameraPosition || viewport.cameraPosition.length !== 3 || !Array.from(viewport.cameraPosition).every(Number.isFinite) ||
    typeof viewport.getBounds !== 'function'
  ) {
    throw new Error('deck GlobeViewport matrices, camera position, size, and visible bounds are required');
  }

  const visibleBounds = options.visibleBounds ?? viewport.getBounds({z: 0});
  if (
    !Array.isArray(visibleBounds) ||
    visibleBounds.length !== 4 ||
    visibleBounds.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('deck GlobeViewport must provide finite geographic bounds');
  }

  return {
    viewport: {width: viewport.width, height: viewport.height},
    view: {
      longitude: viewport.longitude,
      latitude: viewport.latitude,
      zoom: Math.max(0, viewport.zoom + DECK_TO_TANGRAM_ZOOM_OFFSET)
    },
    projection: {
      type: 'globe', visibleBounds: [visibleBounds[0], visibleBounds[1], visibleBounds[2], visibleBounds[3]],
      ...(options.maxElevation === undefined ? {} : {maxElevation: options.maxElevation})
    },
    camera: {
      view: new Float64Array(viewport.viewMatrix),
      projection: new Float32Array(
        multiplyMatrices(viewport.projectionMatrix, viewport.viewMatrix)
      ),
      position: [viewport.cameraPosition[0], viewport.cameraPosition[1], viewport.cameraPosition[2]]
    },
    tileBuffer: 0,
    globePreloadZoom: options.preloadZoom
  };
}

function multiplyMatrices(left: ArrayLike<number>, right: ArrayLike<number>): Float64Array {
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
