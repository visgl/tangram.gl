// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import WebMercatorViewAdapter from '../../web_mercator_view_adapter';
import {createXRPlacementMatrix, intersectContentSurface, transformXRRayToContent, isContentPointWithinMapBounds} from './projection';
import type {XRPresentationFrame, XRPresentationRenderView, XRSpatialRay, XRSurfaceHit,
  XRSurfacePickingOptions, XRVector3} from './types';

/**
 * Resolve a pointer against the zero-altitude map plane or globe sphere.
 * Screen input uses the actual rendered eye, not a reconstructed logical camera.
 * Room rays use the supplied placement snapshot. Misses, invalid rays and clipped
 * screen hits return null. Explicit terrain meshes replace, rather than supplement,
 * the analytic surface; this API does not select worker feature IDs or load a DEM.
 */
export function pickXRSurface(options: XRSurfacePickingOptions): XRSurfaceHit | null {
  const {pointer, placement, frame} = options;
  const viewState = options.viewState || {
    longitude: frame?.logicalViewport.longitude,
    latitude: frame?.logicalViewport.latitude,
    bearing: frame?.logicalViewport.bearing
  };
  let ray: XRSpatialRay;
  let farPoint: XRVector3 | undefined;
  let renderViewId: string | undefined;
  if ('origin' in pointer) {
    if (!isFiniteVector(pointer.origin) || !isFiniteVector(pointer.direction) ||
        Math.hypot(...pointer.direction) === 0) return null;
    const matrix = options.placementMatrix || createXRPlacementMatrix(placement, viewState);
    if (!isInvertibleMatrix(matrix)) return null;
    const magnitude = Math.hypot(...pointer.direction);
    if (!Number.isFinite(magnitude)) return null;
    ray = transformXRRayToContent({origin: pointer.origin, direction: [pointer.direction[0] / magnitude,
      pointer.direction[1] / magnitude, pointer.direction[2] / magnitude]}, matrix);
  } else {
    if (!frame || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return null;
    let camera;
    let viewport;
    if (pointer.eye === 'center') {
      if (frame.mode === 'immersive-vr') return null;
      viewport = frame.logicalViewport;
      camera = placement.type === 'globe'
        ? {view: viewport.viewMatrix, projection: new Matrix4().copy(viewport.projectionMatrix).multiplyRight(viewport.viewMatrix)}
        : WebMercatorViewAdapter.getCameraFrame(viewport);
    } else {
      const eye = frame.renderViews.find(view => view.viewport && containsPixel(getScreenViewport(view, frame), pointer.x, pointer.y) &&
        (!pointer.eye || view.id === `${pointer.eye}-eye` || view.xrView?.eye === pointer.eye));
      if (!eye?.camera) return null;
      camera = eye.camera;
      viewport = getScreenViewport(eye, frame);
      renderViewId = eye.id;
    }
    if (!viewport || !containsPixel(viewport, pointer.x, pointer.y) ||
        !isInvertibleMatrix(camera.projection) || !isInvertibleMatrix(camera.view)) return null;
    // Globe HostCamera.projection already contains view × placement. Applying
    // camera.view a second time would turn screen picks away from the globe.
    const clipMatrix = new Matrix4().copy(camera.projection);
    if (placement.type !== 'globe') clipMatrix.multiplyRight(camera.view);
    if (!isInvertibleMatrix(clipMatrix)) return null;
    const inverse = clipMatrix.invert();
    const horizontal = 2 * (pointer.x - (viewport.x ?? 0)) / viewport.width - 1;
    const vertical = 1 - 2 * (pointer.y - (viewport.y ?? 0)) / viewport.height;
    const nearPoint = unprojectPoint(inverse, horizontal, vertical, -1);
    farPoint = unprojectPoint(inverse, horizontal, vertical, 1) || undefined;
    if (!nearPoint || !farPoint) return null;
    ray = {origin: nearPoint, direction: [farPoint[0] - nearPoint[0],
      farPoint[1] - nearPoint[1], farPoint[2] - nearPoint[2]]};
  }
  const length = Math.hypot(...ray.direction);
  if (!isFiniteVector(ray.origin) || !Number.isFinite(length) || length === 0) return null;
  const direction: XRVector3 = [ray.direction[0] / length, ray.direction[1] / length, ray.direction[2] / length];
  if (options.terrain && options.terrain.projection !== (placement.type === 'globe' ? 'globe' : 'web-mercator')) return null;
  const terrainHit = options.terrain?.intersectRay({origin: ray.origin, direction}, farPoint ? length : Infinity);
  const hit: XRSurfaceHit | null = options.terrain ? (terrainHit ? {
    position: terrainHit.position, coordinate: terrainHit.coordinate, terrain: {
      triangleIndex: terrainHit.triangleIndex, normal: terrainHit.normal, barycentric: terrainHit.barycentric
    }} : null) : intersectContentSurface({origin: ray.origin, direction}, placement, viewState);
  if (!hit || !isFiniteVector(hit.position)) return null;
  if (!isContentPointWithinMapBounds(hit.position, placement, viewState)) return null;
  if (farPoint && Math.hypot(hit.position[0] - ray.origin[0], hit.position[1] - ray.origin[1],
    hit.position[2] - ray.origin[2]) > length * (1 + 1e-9)) return null;
  return renderViewId ? {...hit, renderViewId} : hit;
}

/** Convert native XR's bottom-origin framebuffer rectangle to top-origin screen coordinates. */
function getScreenViewport(view: XRPresentationRenderView, frame: XRPresentationFrame) {
  const viewport = view.viewport!;
  return view.xrView ? {...viewport,
    y: frame.hostFrame.viewport.height - (viewport.y ?? 0) - viewport.height} : viewport;
}

/** Test a CSS-pixel position against a half-open render rectangle. */
function containsPixel(viewport: {x?: number; y?: number; width: number; height: number}, x: number, y: number): boolean {
  const left = viewport.x ?? 0;
  const top = viewport.y ?? 0;
  return Number.isFinite(viewport.width) && Number.isFinite(viewport.height) &&
    x >= left && y >= top && x < left + viewport.width && y < top + viewport.height;
}

/** Reject singular and non-finite transforms before math.gl inversion. */
function isInvertibleMatrix(matrix: ArrayLike<number>): boolean {
  if (matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite)) return false;
  const determinant = new Matrix4(Array.from(matrix)).determinant();
  return Number.isFinite(determinant) && determinant !== 0;
}

/** Unproject a clip-space point with an explicit homogeneous divide. */
function unprojectPoint(matrix: Matrix4, x: number, y: number, z: number): XRVector3 | null {
  const point = matrix.transform([x, y, z, 1]);
  if (!point.every(Number.isFinite) || point[3] === 0) return null;
  return [point[0] / point[3], point[1] / point[3], point[2] / point[3]];
}

/** Narrow input validation without modifying application-owned arrays. */
function isFiniteVector(vector: readonly number[]): boolean {
  return vector.length === 3 && vector.every(Number.isFinite);
}
