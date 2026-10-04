// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export type {
  XRViewState,
  XRViewportSize,
  XREyeViewportOptions,
  XRProjectionOptions,
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

export {
  DEFAULT_INTERPUPILLARY_DISTANCE,
  WebXRPresentation,
  WebXRViewManager
} from './presentation.js';
export type {
  WebXRPresentationOptions,
  WebXRControllerOptions,
  WebXRFrameOptions
} from './presentation.js';
export {
  WebXRMapView,
  WebXRMapController,
  WebXRFirstPersonView,
  WebXRFirstPersonController,
  WebXRGlobeView,
  WebXRGlobeController
} from './views.js';
