// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import type {
  XRGeographicPosition,
  XRGlobePlacement,
  XRMapPlacement,
  XRPlacement,
  XRPlacementPose,
  XRSpatialRay,
  XRVector3
} from './types.ts';

const TANGRAM_HALF_WORLD_METERS = 20037508.342789244;
const EARTH_RADIUS = 6370972;
const GLOBE_RADIUS = 256;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

/** Convert longitude and latitude to Tangram EPSG:3857 meters. */
export function longitudeLatitudeToMeters(longitude: number, latitude: number): [number, number] {
  const clampedLatitude = Math.max(
    -MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, latitude)
  );
  return [
    (longitude / 180) * TANGRAM_HALF_WORLD_METERS,
    (Math.log(Math.tan(((90 + clampedLatitude) * Math.PI) / 360)) / Math.PI) *
      TANGRAM_HALF_WORLD_METERS
  ];
}

/** Convert a Tangram EPSG:3857 position to longitude, latitude, and altitude. */
export function metersToLongitudeLatitude(
  x: number,
  y: number,
  altitude = 0
): [number, number, number] {
  return [
    (x / TANGRAM_HALF_WORLD_METERS) * 180,
    (Math.atan(Math.exp((y / TANGRAM_HALF_WORLD_METERS) * Math.PI)) * 360) / Math.PI - 90,
    altitude
  ];
}

/** Create an affine matrix from an XR-space pose. */
export function createXRPoseMatrix(pose: XRPlacementPose = {}): Matrix4 {
  const position = pose.position || [0, 0, 0];
  const orientation = pose.orientation || [0, 0, 0, 1];
  return new Matrix4()
    .translate(position)
    .multiplyRight(new Matrix4().fromQuaternion(orientation));
}

/** Create the world-to-reference-space placement matrix for geospatial content. */
export function createXRPlacementMatrix(
  placement: XRPlacement,
  viewState: Record<string, unknown> = {}
): Matrix4 {
  if (placement.type === 'globe') {
    const longitude = finiteNumber(viewState.longitude, placement.anchor[0]);
    const latitude = finiteNumber(viewState.latitude, placement.anchor[1]);
    const rotation = placement.rotation || 0;
    const scale = placement.radius / GLOBE_RADIUS;
    return createXRPoseMatrix(placement.pose)
      // deck.gl globe coordinates have north on +Z and longitude zero on -Y.
      // Face the anchor toward +Z in XR room space, with north toward +Y.
      .rotateX(latitude * DEGREES_TO_RADIANS - Math.PI / 2)
      .rotateZ(-(longitude + rotation) * DEGREES_TO_RADIANS)
      .scale([scale, scale, scale]);
  }

  const fallbackAnchor = placement.type === 'map' ? placement.anchor : placement.origin;
  const longitude = finiteNumber(viewState.longitude, fallbackAnchor[0]);
  const latitude = finiteNumber(viewState.latitude, fallbackAnchor[1]);
  const [centerX, centerY] = longitudeLatitudeToMeters(longitude, latitude);
  const metersPerMercatorMeter = Math.cos(
    Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude)) *
      DEGREES_TO_RADIANS
  );

  if (placement.type === 'map') {
    const scale = 1 / placement.metersPerXRUnit;
    return createXRPoseMatrix(placement.pose)
      .rotateX(-Math.PI / 2)
      .scale([scale * metersPerMercatorMeter, scale * metersPerMercatorMeter, scale])
      .translate([-centerX, -centerY, -(placement.anchor[2] || 0)]);
  }

  const offset = placement.position || [0, 0, 0];
  const bearing = finiteNumber(viewState.bearing, placement.bearing || 0);
  return createXRPoseMatrix(placement.pose)
    .rotateY(-bearing * DEGREES_TO_RADIANS)
    .rotateX(-Math.PI / 2)
    .translate([-offset[0], -offset[1], -offset[2]])
    .scale([metersPerMercatorMeter, metersPerMercatorMeter, 1])
    .translate([-centerX, -centerY, 0]);
}

/** Transform an XR-space ray back into the content coordinate system. */
export function transformXRRayToContent(ray: XRSpatialRay, placementMatrix: readonly number[]) {
  const inverse = new Matrix4(placementMatrix).invert();
  const origin = transformPoint(inverse, ray.origin);
  const farPoint = transformPoint(inverse, [
    ray.origin[0] + ray.direction[0],
    ray.origin[1] + ray.direction[1],
    ray.origin[2] + ray.direction[2]
  ]);
  return {
    origin,
    direction: normalizeVector([
      farPoint[0] - origin[0],
      farPoint[1] - origin[1],
      farPoint[2] - origin[2]
    ])
  };
}

/** Intersect an XR-space ray with a placed Web Mercator map. */
export function intersectXRMap(
  ray: XRSpatialRay,
  placement: XRMapPlacement,
  viewState: Record<string, unknown> = {}
): XRGeographicPosition | null {
  const placementMatrix = createXRPlacementMatrix(placement, viewState);
  const localRay = transformXRRayToContent(ray, placementMatrix);
  const distance = intersectPlaneDistance(localRay.origin, localRay.direction, 0);
  if (distance === null) {
    return null;
  }
  const hit: XRVector3 = [
    localRay.origin[0] + localRay.direction[0] * distance,
    localRay.origin[1] + localRay.direction[1] * distance,
    0
  ];
  if (placement.surface?.type === 'bounded') {
    const longitude = finiteNumber(viewState.longitude, placement.anchor[0]);
    const latitude = finiteNumber(viewState.latitude, placement.anchor[1]);
    const [centerX, centerY] = longitudeLatitudeToMeters(longitude, latitude);
    const latitudeScale = Math.cos(
      Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude)) *
        DEGREES_TO_RADIANS
    );
    const halfWidth = (placement.surface.width * placement.metersPerXRUnit) / (2 * latitudeScale);
    const halfHeight = (placement.surface.height * placement.metersPerXRUnit) / (2 * latitudeScale);
    if (Math.abs(hit[0] - centerX) > halfWidth || Math.abs(hit[1] - centerY) > halfHeight) {
      return null;
    }
  }
  return metersToLongitudeLatitude(hit[0], hit[1]);
}

/** Intersect an XR-space ray with a placed deck.gl-compatible globe. */
export function intersectXRGlobe(
  ray: XRSpatialRay,
  placement: XRGlobePlacement,
  viewState: Record<string, unknown> = {}
): XRGeographicPosition | null {
  const placementMatrix = createXRPlacementMatrix(placement, viewState);
  const localRay = transformXRRayToContent(ray, placementMatrix);
  const distance = intersectSphereDistance(localRay.origin, localRay.direction, GLOBE_RADIUS);
  if (distance === null) {
    return null;
  }
  const point: XRVector3 = [
    localRay.origin[0] + localRay.direction[0] * distance,
    localRay.origin[1] + localRay.direction[1] * distance,
    localRay.origin[2] + localRay.direction[2] * distance
  ];
  return globePositionToLongitudeLatitude(point);
}

/** Derive geographic bounds from the union of XR eye frusta intersecting a globe. */
export function getXRGlobeVisibleBounds({
  views,
  placement,
  viewState
}: {
  views: readonly {viewMatrix: readonly number[]; projectionMatrix: readonly number[]}[];
  placement: XRGlobePlacement;
  viewState?: Record<string, unknown>;
}): [number, number, number, number] {
  const placementMatrix = createXRPlacementMatrix(placement, viewState);
  const coordinates: XRGeographicPosition[] = [];
  const samples = [-1, 0, 1];
  for (const view of views) {
    const inverseClip = new Matrix4(view.projectionMatrix)
      .multiplyRight(view.viewMatrix)
      .multiplyRight(placementMatrix)
      .invert();
    for (const x of samples) {
      for (const y of samples) {
        const near = transformHomogeneousPoint(inverseClip, [x, y, -1]);
        const far = transformHomogeneousPoint(inverseClip, [x, y, 1]);
        const direction = normalizeVector([
          far[0] - near[0],
          far[1] - near[1],
          far[2] - near[2]
        ]);
        const distance = intersectSphereDistance(near, direction, GLOBE_RADIUS);
        if (distance !== null) {
          coordinates.push(
            globePositionToLongitudeLatitude([
              near[0] + direction[0] * distance,
              near[1] + direction[1] * distance,
              near[2] + direction[2] * distance
            ])
          );
        }
      }
    }
  }
  if (coordinates.length === 0) {
    return [-180, -MAX_MERCATOR_LATITUDE, 180, MAX_MERCATOR_LATITUDE];
  }
  const anchorLongitude = finiteNumber(viewState?.longitude, placement.anchor[0]);
  const unwrappedLongitudes = coordinates.map(([longitude]) =>
    unwrapLongitude(longitude, anchorLongitude)
  );
  const latitudes = coordinates.map((coordinate) => coordinate[1]);
  return [
    Math.min(...unwrappedLongitudes),
    Math.max(-MAX_MERCATOR_LATITUDE, Math.min(...latitudes)),
    Math.max(...unwrappedLongitudes),
    Math.min(MAX_MERCATOR_LATITUDE, Math.max(...latitudes))
  ];
}

/** Merge geographic bounds, preserving ranges that cross the antimeridian. */
export function unionGeographicBounds(
  bounds: readonly (readonly [number, number, number, number])[],
  anchorLongitude = 0
): [number, number, number, number] {
  if (bounds.length === 0) {
    return [-180, -MAX_MERCATOR_LATITUDE, 180, MAX_MERCATOR_LATITUDE];
  }
  const west = bounds.map((value) => unwrapLongitude(value[0], anchorLongitude));
  const east = bounds.map((value) => unwrapLongitude(value[2], anchorLongitude));
  return [
    Math.min(...west),
    Math.min(...bounds.map((value) => value[1])),
    Math.max(...east),
    Math.max(...bounds.map((value) => value[3]))
  ];
}

function intersectPlaneDistance(
  origin: XRVector3,
  direction: XRVector3,
  planeZ: number
): number | null {
  if (Math.abs(direction[2]) < 1e-8) {
    return null;
  }
  const distance = (planeZ - origin[2]) / direction[2];
  return distance >= 0 ? distance : null;
}

function intersectSphereDistance(
  origin: XRVector3,
  direction: XRVector3,
  radius: number
): number | null {
  const originDotDirection = dot(origin, direction);
  const discriminant =
    originDotDirection * originDotDirection - (dot(origin, origin) - radius * radius);
  if (discriminant < 0) {
    return null;
  }
  const root = Math.sqrt(discriminant);
  const near = -originDotDirection - root;
  const far = -originDotDirection + root;
  if (near >= 0) {
    return near;
  }
  return far >= 0 ? far : null;
}

function globePositionToLongitudeLatitude(point: XRVector3): [number, number, number] {
  const radius = Math.hypot(point[0], point[1], point[2]);
  return [
    Math.atan2(point[0], -point[1]) * RADIANS_TO_DEGREES,
    Math.asin(point[2] / radius) * RADIANS_TO_DEGREES,
    (radius / GLOBE_RADIUS - 1) * EARTH_RADIUS
  ];
}

function transformPoint(matrix: readonly number[], point: XRVector3): XRVector3 {
  return transformHomogeneousPoint(matrix, point);
}

function transformHomogeneousPoint(matrix: readonly number[], point: XRVector3): XRVector3 {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const divisor = w || 1;
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / divisor,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / divisor,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / divisor
  ];
}

function normalizeVector(vector: readonly number[]): XRVector3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!length) {
    return [0, 0, -1];
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function finiteNumber(value: unknown, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function unwrapLongitude(longitude: number, anchor: number): number {
  let result = longitude;
  while (result - anchor > 180) result -= 360;
  while (result - anchor < -180) result += 360;
  return result;
}
