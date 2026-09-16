// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export {
  WebXRInputAdapter,
  setWebXRSessionWithFallback
} from './interaction';
export type {
  WebXRInputSnapshot,
  WebXRSession,
  WebXRReferenceSpaceType,
  WebXRInputAdapterOptions
} from './interaction';
export {
  DEFAULT_INTERPUPILLARY_DISTANCE,
  WebXRPresentation,
  WebXRViewManager
} from './presentation';
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
} from './projection';
export {
  WebXRMapView,
  WebXRMapController,
  WebXRFirstPersonController,
  WebXRFirstPersonView,
  WebXRGlobeController,
  WebXRGlobeView
} from './views';
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
} from './types';
