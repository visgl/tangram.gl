// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import {calculatePlanarGroundBounds, type HostCamera, type LegacyHostFrame} from '@vis.gl/tangram-renderer/core';
import WebMercatorViewAdapter from './web_mercator_view_adapter';
import type {FirstPersonViewport} from './view_adapter_types';

const DECK_WORLD_SIZE = 512;
const HALF_WORLD_METERS = 20037508.342789244;
const TILE_SIZE = 256;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const DEFAULT_GROUND_EXTENT = 20000;

/** Rendering dimensions and bounded first-person ground visibility policy. */
export type FirstPersonViewAdapterOptions = {
  /** Target width in CSS pixels; defaults to viewport width. */
  width?: number;
  /** Target height in CSS pixels; defaults to viewport height. */
  height?: number;
  /** Maximum east/north extent from the eye in local geographic meters, per axis. Defaults to 20 km. */
  maxGroundExtent?: number;
};

/** Typed bounded ground-footprint boundary for deck.gl FirstPersonView. */
export default class FirstPersonViewAdapter {
  /** Converts the finite frustum/ground intersection without changing camera matrices. */
  static getFrame = getFrame;
}

/**
 * Derives geographic tile visibility from the full finite camera frustum.
 * Near/far planes and an eye-centered square limit bound horizon intersections.
 * Looking entirely away from ground supplies explicit empty visibility instead
 * of an error. Terrain and elevated-only geometry are not included in this flat
 * ground policy; the host projection can supply a different footprint.
 */
function getFrame(viewport: FirstPersonViewport, options: FirstPersonViewAdapterOptions = {}): LegacyHostFrame {
  return getFirstPersonFrameForCamera(viewport, WebMercatorViewAdapter.getCameraFrame(viewport), options);
}

/** Derives flat-ground visibility from the actual mono or per-eye EPSG:3857 camera. */
export function getFirstPersonFrameForCamera(
  viewport: FirstPersonViewport,
  camera: HostCamera,
  options: FirstPersonViewAdapterOptions = {}
): LegacyHostFrame {
  const width = options.width ?? viewport.width;
  const height = options.height ?? viewport.height;
  const maxGroundExtent = options.maxGroundExtent ?? DEFAULT_GROUND_EXTENT;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('FirstPersonViewport requires positive width and height');
  }
  if (!Number.isFinite(maxGroundExtent) || maxGroundExtent <= 0) {
    throw new Error('FirstPersonViewport maxGroundExtent must be finite and positive');
  }
  const {longitude, latitude} = viewport;
  const unprojectFlat = viewport.unprojectFlat;
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) ||
      typeof latitude !== 'number' || !Number.isFinite(latitude) ||
      typeof unprojectFlat !== 'function') {
    throw new Error('FirstPersonViewport geographic center and ground projection method are required');
  }
  const inverseView = new Matrix4().copy(camera.view);
  if (!Number.isFinite(inverseView.determinant()) || inverseView.determinant() === 0) {
    throw new Error('FirstPersonViewport camera is singular');
  }
  const eye = inverseView.invert().transformAsPoint([0, 0, 0]);
  if (!eye.every(Number.isFinite)) throw new Error('FirstPersonViewport eye position is invalid');
  const latitudeScale = Math.cos(Math.max(-MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, latitude)) * Math.PI / 180);
  const extent = maxGroundExtent / latitudeScale;
  const bounds = calculatePlanarGroundBounds(camera, {
    sw: {x: eye[0] - extent, y: eye[1] - extent},
    ne: {x: eye[0] + extent, y: eye[1] + extent}
  });
  const xyScale = DECK_WORLD_SIZE / (HALF_WORLD_METERS * 2);
  const toGeographic = (x: number, y: number) => unprojectFlat.call(viewport, [
    x * xyScale + DECK_WORLD_SIZE / 2, y * xyScale + DECK_WORLD_SIZE / 2
  ]);
  const center = bounds ? toGeographic((bounds.sw.x + bounds.ne.x) / 2,
    (bounds.sw.y + bounds.ne.y) / 2) : [longitude, latitude];
  const metersPerPixel = bounds ? Math.max((bounds.ne.x - bounds.sw.x) / width,
    (bounds.ne.y - bounds.sw.y) / height) : extent * 2 / Math.min(width, height);
  let visibleBounds: [number, number, number, number] | null = null;
  if (bounds) {
    const southwest = toGeographic(bounds.sw.x, bounds.sw.y);
    const northeast = toGeographic(bounds.ne.x, bounds.ne.y);
    // Keep the longitude interval unwrapped; the renderer's tile wrapping owns world copies.
    visibleBounds = [southwest[0], southwest[1], northeast[0], northeast[1]];
  }
  if (!center.every(Number.isFinite) || !Number.isFinite(metersPerPixel) || metersPerPixel <= 0 ||
      (visibleBounds && !visibleBounds.every(Number.isFinite))) {
    throw new Error('FirstPersonViewport ground footprint is invalid');
  }
  return {
    viewport: {width, height},
    view: {longitude: center[0], latitude: center[1], altitude: eye[2],
      zoom: Math.max(0, Math.log2(HALF_WORLD_METERS * 2 / (TILE_SIZE * metersPerPixel)))},
    projection: {type: 'web-mercator', visibleBounds},
    camera,
    tileBuffer: 1
  };
}
