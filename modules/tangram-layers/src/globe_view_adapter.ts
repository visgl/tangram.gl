// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {LegacyHostFrame} from '@vis.gl/tangram-renderer/core';
import type {GlobeViewport} from './view_adapter_types';
const DECK_TO_TANGRAM_ZOOM_OFFSET = 1;
const MAX_MERCATOR_LATITUDE = 85.05112878;

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
 *
 * @param {object} viewport deck.gl GlobeViewport.
 * @returns {object} Tangram HostFrame fields for a globe render view.
 */
function getFrame(viewport: GlobeViewport): LegacyHostFrame {
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

  const visibleBounds = viewport.getBounds({z: 0});
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
      zoom: getTangramGlobeZoom(viewport.zoom, viewport.latitude)
    },
    projection: {type: 'globe', visibleBounds: [visibleBounds[0], visibleBounds[1], visibleBounds[2], visibleBounds[3]]},
    camera: {
      view: new Float64Array(viewport.viewMatrix),
      projection: new Float32Array(
        multiplyMatrices(viewport.projectionMatrix, viewport.viewMatrix)
      ),
      position: [viewport.cameraPosition[0], viewport.cameraPosition[1], viewport.cameraPosition[2]]
    },
    tileBuffer: 0
  };
}

/**
 * Converts deck.gl GlobeViewport zoom to Tangram's Mercator tile zoom scale.
 * GlobeViewport compensates zoom by latitude so its scale converges with
 * Web Mercator at high zoom; apply the same adjustment before choosing tiles.
 * @param zoom deck.gl GlobeViewport zoom.
 * @param latitude Globe center latitude in degrees.
 * @returns Tangram zoom value with the package's tile-size offset applied.
 */
function getTangramGlobeZoom(zoom: number, latitude: number): number {
  const scaleLatitude = Math.max(
    -MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, latitude)
  );
  const latitudeScaleAdjustment = Math.log2(
    Math.PI * Math.cos((scaleLatitude * Math.PI) / 180)
  );
  return Math.max(0, zoom - latitudeScaleAdjustment + DECK_TO_TANGRAM_ZOOM_OFFSET);
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
