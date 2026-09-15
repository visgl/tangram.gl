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
  XRInteractionIntent
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

import type {
  XRDeckController,
  XRDeckView,
  XRFrameState,
  XRInteractionIntent,
  XRPlacement,
  XRPresentationFrame,
  XRPresentationMode
} from './types.js';

/** Default human interpupillary distance used by desktop stereo preview, in meters. */
export const DEFAULT_INTERPUPILLARY_DISTANCE: number;

/** MapView with WebXR and Tangram host-frame support. */
export class WebXRMapView extends import('@deck.gl/core').MapView {}

/** FirstPersonView with WebXR and Tangram host-frame support. */
export class WebXRFirstPersonView extends import('@deck.gl/core').FirstPersonView {}

/** GlobeView with WebXR and Tangram host-frame support. */
export class WebXRGlobeView extends import('@deck.gl/core')._GlobeView {}

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
  updateController(size: {width: number; height: number}): void;
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
