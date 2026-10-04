// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export type {
  XRVector3,
  XRQuaternion,
  XRGeographicPosition,
  XRPlacementPose,
  XRBoundedMapSurface,
  XRUnboundedMapSurface,
  XRMapPlacement,
  XRGlobePlacement,
  XRFirstPersonPlacement,
  XRPlacement,
  XRPresentationMode,
  XRFrameView,
  XRFrameState,
  XRDeckView,
  XRDeckViewport,
  XRDeckController,
  XRHostFrameFields,
  XRPresentationRenderView,
  XRPresentationFrame,
  XRSpatialRay,
  XRScreenPointer,
  XRInteractionIntent,
  XRSurfaceHit,
  XRSurfacePickingOptions
} from './types.js';
export type {
  WebXRInputSnapshot,
  WebXRSession,
  WebXRReferenceSpaceType,
  WebXRInputAdapterOptions
} from './interaction.js';
export {
  WebXRInputAdapter,
  setWebXRSessionWithFallback
} from './interaction.js';
export {
  longitudeLatitudeToMeters,
  metersToLongitudeLatitude,
  createXRPoseMatrix,
  createXRPlacementMatrix,
  transformXRRayToContent,
  intersectXRMap,
  intersectXRGlobe,
  getXRGlobeVisibleBounds,
  unionGeographicBounds
} from './projection.js';
export {pickXRSurface} from './picking.js';
export {WebXRSurfaceGrabber} from './grabbing.js';
export type {XRSurfaceGrabContext} from './grabbing.js';

import {MapView, MapController, FirstPersonView, FirstPersonController,
  _GlobeView as GlobeView, _GlobeController as GlobeController} from '@deck.gl/core';
import type {HostCamera} from '@vis.gl/tangram-renderer/core';
import type {FirstPersonViewAdapterOptions} from '../../first_person_view_adapter';
import type {FirstPersonViewport} from '../../view_adapter_types';

import type {
  XRDeckController,
  XRDeckView,
  XRFrameState,
  XRHostFrameFields,
  XRInteractionIntent,
  XRPlacement,
  XRPresentationFrame,
  XRPresentationMode
} from './types.js';

/** Default human interpupillary distance used by desktop stereo preview, in meters. */
export const DEFAULT_INTERPUPILLARY_DISTANCE: number;

/** MapView with WebXR and Tangram host-frame support. */
export class WebXRMapView extends MapView {}

/** Map controller with trackpad pan and touch pinch rotation support. */
export class WebXRMapController extends MapController {}

/** First-person controller with trackpad pan and touch pinch rotation support. */
export class WebXRFirstPersonController extends FirstPersonController {}

/** Globe controller with trackpad pan and touch pinch rotation support. */
export class WebXRGlobeController extends GlobeController {}

/** FirstPersonView with WebXR and Tangram host-frame support. */
export class WebXRFirstPersonView extends FirstPersonView {
  /** Eye-centered ground extent per axis in local geographic meters; defaults to 20 km. */
  constructor(props?: ConstructorParameters<typeof FirstPersonView>[0] & {firstPersonMaxGroundExtent?: number});
  /** Recomputes finite flat-ground bounds from the actual per-eye camera. */
  getHostFrameForCamera(viewport: FirstPersonViewport, camera: HostCamera, options?: FirstPersonViewAdapterOptions): XRHostFrameFields;
}

/** GlobeView with WebXR and Tangram host-frame support. */
export class WebXRGlobeView extends GlobeView {
  /** Maximum rendered geographic elevation; omit when no reliable scene-wide bound is known. */
  constructor(props?: ConstructorParameters<typeof GlobeView>[0] & {
    globeMaxElevation?: number;
    /** Optional global coarse loading fallback level, integer 0–3. */
    globePreloadZoom?: number;
  });
}

/** Options for creating one reusable WebXR presentation. */
export type WebXRPresentationOptions = {
  view: XRDeckView;
  viewState: Record<string, unknown>;
  placement?: XRPlacement;
  mode?: XRPresentationMode;
};

/** One logical deck view with mono, split-stereo, and immersive render modes. */
export class WebXRPresentation {
  constructor(options: WebXRPresentationOptions);
  readonly view: XRDeckView;
  placement: XRPlacement;
  mode: XRPresentationMode;
  controller: XRDeckController | null;
  getViewState(): Record<string, unknown>;
  setViewState(
    update:
      | Record<string, unknown>
      | ((viewState: Record<string, unknown>) => Record<string, unknown>)
  ): Record<string, unknown>;
  setPlacement(placement: XRPlacement): void;
  setMode(mode: XRPresentationMode): void;
  attachController(options: {
    element: HTMLElement;
    timeline: unknown;
    onViewStateChange?: (parameters: Record<string, unknown>) => void;
    onStateChange?: (parameters: Record<string, unknown>) => void;
  }): XRDeckController | null;
  updateController(size: {width: number; height: number}, mode?: XRPresentationMode): void;
  /** Advance desktop zoom and inertia transitions once per animation frame. */
  updateTransitions(): void;
  finalize(): void;
  createFrame(options: {
    width: number;
    height: number;
    frameState?: XRFrameState;
    mode?: XRPresentationMode;
    interpupillaryDistance?: number;
  }): XRPresentationFrame;
  dispatchInteractionIntent(intent: XRInteractionIntent): Record<string, unknown>;
}

/** Backward-compatible name for the first WebXR prototype. */
export class WebXRViewManager extends WebXRPresentation {}
