// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export {
  WebXRInputAdapter,
  setWebXRSessionWithFallback,
  DEFAULT_INTERPUPILLARY_DISTANCE,
  WebXRPresentation,
  WebXRViewManager,
  longitudeLatitudeToMeters,
  metersToLongitudeLatitude,
  createXRPoseMatrix,
  createXRPlacementMatrix,
  transformXRRayToContent,
  intersectXRMap,
  intersectXRGlobe,
  getXRGlobeVisibleBounds,
  unionGeographicBounds,
  WebXRMapView,
  WebXRMapController,
  WebXRFirstPersonController,
  WebXRFirstPersonView,
  WebXRGlobeController,
  WebXRGlobeView
} from './src/experimental/webxr/index.ts';
