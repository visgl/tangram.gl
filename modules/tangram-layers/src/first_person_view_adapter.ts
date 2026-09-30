// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import WebMercatorViewAdapter from './web_mercator_view_adapter';
import type {LegacyHostFrame} from '@vis.gl/tangram-renderer/core';
import type {FirstPersonViewport} from './view_adapter_types';
const DECK_WORLD_SIZE = 512;
const TANGRAM_HALF_WORLD_METERS = 20037508.342789244;
const TANGRAM_TILE_SIZE = 256;
const FIRST_PERSON_TILE_BUFFER = 1;

/** Typed ground-footprint boundary for deck.gl FirstPersonView. */
export default class FirstPersonViewAdapter {
    /** Converts the forward ground footprint without changing camera projection. */
    static getFrame = getFrame;
}

/**
 * Converts a deck.gl FirstPersonViewport into Tangram's geographic tile frame.
 *
 * FirstPersonViewport uses planar Web Mercator geometry but does not expose a
 * map-style zoom. Its internal zoom describes meters in common space, not the
 * level of detail needed by the visible ground footprint. This adapter
 * intersects the viewport corners with the ground plane and derives a Tangram
 * zoom from the resulting projected meters per pixel.
 *
 * @param {object} viewport deck.gl FirstPersonViewport.
 * @param {{width?: number, height?: number}} [options] Render-target dimensions.
 * @returns {{viewport: object, view: object, camera: object, tileBuffer: number}}
 */
function getFrame(viewport: FirstPersonViewport, options: {width?: number; height?: number} = {}): LegacyHostFrame {
  const width = options.width || viewport.width;
  const height = options.height || viewport.height;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('FirstPersonViewport requires positive width and height');
  }
  if (
    typeof viewport.unproject !== 'function' ||
    typeof viewport.projectFlat !== 'function' ||
    typeof viewport.unprojectFlat !== 'function'
  ) {
    throw new Error('FirstPersonViewport ground projection methods are required');
  }

  const groundCorners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height]
  ].map((pixel) => getForwardGroundIntersection(viewport, pixel));
  if (!groundCorners.every(isFiniteCoordinate)) {
    throw new Error('FirstPersonViewport must intersect the ground plane');
  }

  const projectFlat = viewport.projectFlat;
  const projectedCorners = groundCorners.map((corner) => projectFlat.call(viewport, corner));
  if (projectedCorners.some((corner) => !isFiniteCoordinate(corner))) {
    throw new Error('FirstPersonViewport ground footprint must use Web Mercator coordinates');
  }

  // Use the world copy nearest the camera to keep wrapped ground footprints local.
  const {longitude, latitude} = viewport;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) ||
      typeof latitude !== 'number' || !Number.isFinite(latitude)) {
    throw new Error('FirstPersonViewport geographic center is invalid');
  }
  const projectedCenter = projectFlat.call(viewport, [longitude, latitude]);
  if (!isFiniteCoordinate(projectedCenter)) {
    throw new Error('FirstPersonViewport projected center is invalid');
  }
  const unwrappedProjectedCorners = projectedCorners.map(([x, y]) => [
    x + Math.round((projectedCenter[0] - x) / DECK_WORLD_SIZE) * DECK_WORLD_SIZE,
    y
  ]);

  const xValues = unwrappedProjectedCorners.map((corner) => corner[0]);
  const yValues = unwrappedProjectedCorners.map((corner) => corner[1]);
  const west = Math.min(...xValues);
  const east = Math.max(...xValues);
  const north = Math.min(...yValues);
  const south = Math.max(...yValues);
  const footprintWidth = east - west;
  const footprintHeight = south - north;
  const commonUnitsPerProjectedMeter = DECK_WORLD_SIZE / (TANGRAM_HALF_WORLD_METERS * 2);
  const metersPerPixel = Math.max(
    footprintWidth / commonUnitsPerProjectedMeter / width,
    footprintHeight / commonUnitsPerProjectedMeter / height
  );
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
    throw new Error('FirstPersonViewport ground footprint is empty');
  }

  const center = viewport.unprojectFlat([(west + east) / 2, (north + south) / 2]);
  if (!isFiniteCoordinate(center)) {
    throw new Error('FirstPersonViewport ground footprint center is invalid');
  }
  const worldSizeMeters = TANGRAM_HALF_WORLD_METERS * 2;
  const zoom = Math.log2(worldSizeMeters / (TANGRAM_TILE_SIZE * metersPerPixel));

  return {
    viewport: {width, height},
    view: {
      longitude: center[0],
      latitude: center[1],
      altitude:
        viewport.position && Number.isFinite(viewport.position[2]) ? viewport.position[2] : 0,
      zoom
    },
    camera: WebMercatorViewAdapter.getCameraFrame(viewport),
    tileBuffer: FIRST_PERSON_TILE_BUFFER
  };
}

function isFiniteCoordinate(coordinate: number[] | null | undefined): coordinate is number[] {
  return Boolean(coordinate && Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]));
}

function getForwardGroundIntersection(viewport: FirstPersonViewport, pixel: number[]): number[] | null {
  const near = viewport.unproject?.([pixel[0], pixel[1], 0]);
  const far = viewport.unproject?.([pixel[0], pixel[1], 1]);
  if (
    !isFiniteCoordinate(near) ||
    !Number.isFinite(near[2]) ||
    !isFiniteCoordinate(far) ||
    !Number.isFinite(far[2])
  ) {
    return null;
  }

  const rayParameter = -near[2] / (far[2] - near[2]);
  if (!Number.isFinite(rayParameter) || rayParameter <= 0) {
    return null;
  }
  return viewport.unproject?.(pixel, {targetZ: 0}) ?? null;
}
