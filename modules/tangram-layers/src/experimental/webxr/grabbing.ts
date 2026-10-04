// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4, Quaternion} from '@math.gl/core';
import {pickXRSurface} from './picking';
import {createXRPlacementMatrix} from './projection';
import type {XRGlobePlacement, XRInteractionIntent, XRMapPlacement, XRSpatialRay,
  XRSurfacePickingOptions, XRVector3} from './types';

/** Rendered placement snapshot used to start a room-space surface grab. */
export type XRSurfaceGrabContext = Omit<XRSurfacePickingOptions, 'pointer'>;

/** Private immutable baseline for one controller-owned gesture. */
type SurfaceGrab = {
  inputId: string;
  placement: XRMapPlacement | XRGlobePlacement;
  context: XRSurfaceGrabContext;
  matrix: Matrix4;
  hit: XRVector3;
  normal: XRVector3;
  center: XRVector3;
};

/**
 * Translate tabletop maps in their initial plane and rotate globes around their
 * room-space center. This owns gesture state, not a renderer or XR session.
 * Only room rays can grab; desktop screen pointers keep normal deck controls.
 */
export class WebXRSurfaceGrabber {
  private grab: SurfaceGrab | null = null;

  /** Whether one input currently owns a grab, including paused off-surface movement. */
  isGrabbing(): boolean {
    return this.grab !== null;
  }

  /** End a gesture without rolling back the application's last accepted placement. */
  reset(): void {
    this.grab = null;
  }

  /**
   * Consume grab/hover/release/cancel intents and return a new placement on movement.
   * Supply the actual rendered placement when starting; subsequent movement uses
   * that frozen baseline, avoiding feedback as the application moves the object.
   * Missing input IDs share a single implicit owner. Select-button releases never
   * terminate a squeeze grab. First-person ground and screen grabs are unsupported.
   */
  dispatchInteractionIntent(intent: XRInteractionIntent, context: XRSurfaceGrabContext):
    XRMapPlacement | XRGlobePlacement | null {
    if (intent.type !== 'point') return null;
    const inputId = intent.inputId ?? 'pointer';
    if (this.grab && this.grab.inputId !== inputId) return null;
    if (intent.action === 'cancel' || (intent.action === 'release' && intent.button !== 'select')) {
      this.reset();
      return null;
    }
    if (!('origin' in intent.pointer)) return null;
    if (intent.action === 'grab' && !this.grab) {
      this.beginGrab(inputId, intent.pointer, context);
      return null;
    }
    if (intent.action !== 'hover' || !this.grab) return null;
    return this.moveGrab(intent.pointer);
  }

  /** Freeze geographic state, pose and the actual room matrix after a valid surface hit. */
  private beginGrab(inputId: string, pointer: XRSpatialRay, context: XRSurfaceGrabContext): void {
    if (context.placement.type === 'first-person') return;
    const hit = pickXRSurface({...context, pointer});
    if (!hit) return;
    const placement = context.placement;
    const position = placement.pose?.position ?? [0, 0, 0];
    const orientation = placement.pose?.orientation ?? [0, 0, 0, 1];
    const scale = placement.type === 'map' ? placement.metersPerXRUnit : placement.radius;
    if (!position.every(Number.isFinite) || !orientation.every(Number.isFinite) ||
      !(Math.hypot(...orientation) > 0) || !Number.isFinite(scale) || scale <= 0) return;
    const snapshot = copyPlacement(placement);
    const viewState = {...(context.viewState ?? {
      longitude: context.frame?.logicalViewport.longitude,
      latitude: context.frame?.logicalViewport.latitude})};
    const matrix = new Matrix4().copy(context.placementMatrix ??
      createXRPlacementMatrix(placement, viewState));
    const normal = normalize([
      matrix[1] * matrix[6] - matrix[2] * matrix[5],
      matrix[2] * matrix[4] - matrix[0] * matrix[6],
      matrix[0] * matrix[5] - matrix[1] * matrix[4]
    ]);
    if (!normal || Math.abs(matrix[3]) + Math.abs(matrix[7]) + Math.abs(matrix[11]) > 1e-9 ||
      Math.abs(matrix[15] - 1) > 1e-9) return;
    this.grab = {inputId, placement: snapshot,
      context: {...context, placement: snapshot, viewState, placementMatrix: matrix},
      matrix, hit: transformPoint(matrix, hit.position), normal,
      center: transformPoint(matrix, [0, 0, 0])};
  }

  /** Resolve movement against the start plane or sphere, never the already moved object. */
  private moveGrab(pointer: XRSpatialRay): XRMapPlacement | XRGlobePlacement | null {
    const grab = this.grab;
    if (!grab || !pointer.origin.every(Number.isFinite)) return null;
    const direction = normalize(pointer.direction);
    if (!direction) return null;
    if (grab.placement.type === 'map') {
      const denominator = dot(direction, grab.normal);
      if (Math.abs(denominator) < 1e-7) return null;
      const distance = dot(subtract(grab.hit, pointer.origin), grab.normal) / denominator;
      if (!Number.isFinite(distance) || distance < 0) return null;
      const hit: XRVector3 = [pointer.origin[0] + direction[0] * distance,
        pointer.origin[1] + direction[1] * distance, pointer.origin[2] + direction[2] * distance];
      const position = grab.placement.pose?.position ?? [0, 0, 0];
      const nextPosition: XRVector3 = [position[0] + hit[0] - grab.hit[0],
        position[1] + hit[1] - grab.hit[1], position[2] + hit[2] - grab.hit[2]];
      if (!nextPosition.every(Number.isFinite)) return null;
      const placement = copyPlacement(grab.placement);
      return {...placement, pose: {...placement.pose,
        position: nextPosition}};
    }
    const hit = pickXRSurface({...grab.context, pointer});
    if (!hit) return null;
    const start = normalize(subtract(grab.hit, grab.center));
    const end = normalize(subtract(transformPoint(grab.matrix, hit.position), grab.center));
    if (!start || !end) return null;
    const rotation = new Quaternion().rotationTo([...start], [...end]);
    const orientation = new Quaternion().copy(grab.placement.pose?.orientation ?? [0, 0, 0, 1])
      .multiplyLeft(rotation).normalize();
    const placement = copyPlacement(grab.placement);
    return {...placement, pose: {...placement.pose,
      orientation: [orientation[0], orientation[1], orientation[2], orientation[3]]}};
  }
}

/** Isolate application-owned pose, anchor and finite surface dimensions from gesture state. */
function copyPlacement(placement: XRMapPlacement | XRGlobePlacement): XRMapPlacement | XRGlobePlacement {
  const position = placement.pose?.position ?? [0, 0, 0];
  const orientation = placement.pose?.orientation ?? [0, 0, 0, 1];
  const pose: NonNullable<XRMapPlacement['pose']> = {position: [position[0], position[1], position[2]],
    orientation: [orientation[0], orientation[1], orientation[2], orientation[3]]};
  return placement.type === 'map'
    ? {...placement, anchor: [...placement.anchor], pose,
      ...(placement.surface ? {surface: {...placement.surface}} : {})}
    : {...placement, anchor: [...placement.anchor], pose};
}

/** Transform an affine content position into XR reference-space meters. */
function transformPoint(matrix: Matrix4, point: XRVector3): XRVector3 {
  const result = matrix.transform([point[0], point[1], point[2], 1]);
  return [result[0], result[1], result[2]];
}

/** Normalize valid finite vectors, rejecting zero-length or overflowing input. */
function normalize(vector: XRVector3): XRVector3 | null {
  const length = Math.hypot(...vector);
  return length > 0 && Number.isFinite(length)
    ? [vector[0] / length, vector[1] / length, vector[2] / length] : null;
}

/** Subtract two reference-space coordinates. */
function subtract(first: XRVector3, second: XRVector3): XRVector3 {
  return [first[0] - second[0], first[1] - second[1], first[2] - second[2]];
}

/** Project one vector onto another. */
function dot(first: XRVector3, second: XRVector3): number {
  return first[0] * second[0] + first[1] * second[1] + first[2] * second[2];
}
