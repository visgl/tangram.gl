// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {HostFrameOptions, HostRenderView} from '@vis.gl/tangram-renderer';

/** Three-dimensional coordinate expressed in meters unless documented otherwise. */
export type XRVector3 = readonly [number, number, number];

/** Quaternion in `[x, y, z, w]` order. */
export type XRQuaternion = readonly [number, number, number, number];

/** Geographic coordinate in `[longitude, latitude, altitude]` order. */
export type XRGeographicPosition = readonly [number, number, number?];

/** Placement pose in an XR reference space. */
export type XRPlacementPose = {
  position?: XRVector3;
  orientation?: XRQuaternion;
};

/** Finite tabletop dimensions in physical XR meters. */
export type XRBoundedMapSurface = {
  type: 'bounded';
  width: number;
  height: number;
};

/** Map plane without a finite interaction boundary. */
export type XRUnboundedMapSurface = {type: 'unbounded'};

/** Placement of a Web Mercator map in an XR reference space. */
export type XRMapPlacement = {
  type: 'map';
  anchor: XRGeographicPosition;
  pose?: XRPlacementPose;
  /** Geographic meters represented by one physical XR meter. */
  metersPerXRUnit: number;
  surface?: XRBoundedMapSurface | XRUnboundedMapSurface;
};

/** Placement of a globe in an XR reference space. */
export type XRGlobePlacement = {
  type: 'globe';
  anchor: XRGeographicPosition;
  pose?: XRPlacementPose;
  /** Physical globe radius in XR meters. */
  radius: number;
  /** Additional rotation around the globe's polar axis, in degrees. */
  rotation?: number;
};

/** One-to-one local tangent placement for immersive first-person navigation. */
export type XRFirstPersonPlacement = {
  type: 'first-person';
  origin: XRGeographicPosition;
  pose?: XRPlacementPose;
  /** East, north, and up locomotion offset in geographic meters. */
  position?: XRVector3;
  /** Body heading in degrees. Head pitch and roll remain owned by WebXR. */
  bearing?: number;
};

/** Supported geospatial content placements. */
export type XRPlacement = XRMapPlacement | XRGlobePlacement | XRFirstPersonPlacement;

/** Runtime presentation mode. */
export type XRPresentationMode = 'auto' | 'mono' | 'stereo-preview' | 'immersive-vr';

/** Minimal luma.gl WebXR view state consumed by the presentation. */
export type XRFrameView = {
  eye?: string;
  index: number;
  viewport: readonly [number, number, number, number];
  viewMatrix: readonly number[];
  projectionMatrix: readonly number[];
  framebuffer?: unknown;
};

/** Minimal luma.gl WebXR frame state consumed by the presentation. */
export type XRFrameState = {
  views: readonly XRFrameView[];
  framebuffer?: unknown;
};

/** Deck view contract required by {@link WebXRPresentation}. */
export type XRDeckView = {
  id: string;
  constructor: {name: string; displayName?: string};
  controller: ({type: new (properties: Record<string, unknown>) => XRDeckController} &
    Record<string, unknown>) | null;
  makeViewport(options: {
    width: number;
    height: number;
    viewState: Record<string, unknown>;
  }): XRDeckViewport | null;
  makeEyeViewport?(options: {
    width: number;
    height: number;
    viewState: Record<string, unknown>;
    eyeOffset?: number;
  }): XRDeckViewport | null;
  getHostFrame?(viewport: XRDeckViewport): XRHostFrameFields;
  getXRProjectionMatrix?(options: {
    projectionMatrix: readonly number[];
    viewMatrix: readonly number[];
  }): readonly number[];
};

/** Deck viewport surface used by the package without importing private deck internals. */
export type XRDeckViewport = {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  longitude?: number;
  latitude?: number;
  zoom?: number;
  pitch?: number;
  position?: number[];
  viewMatrix: readonly number[];
  projectionMatrix: readonly number[];
  viewMatrixInverse?: readonly number[];
  distanceScales?: {
    unitsPerMeter: readonly number[];
    metersPerUnit?: readonly number[];
  };
  getBounds?(options?: {z?: number}): [number, number, number, number];
};

/** Deck controller methods used by the shared logical view. */
export type XRDeckController = {
  setProps(properties: Record<string, unknown>): void;
  finalize(): void;
};

/** Host-frame fields derived from one logical deck viewport. */
export type XRHostFrameFields = {
  view: {
    longitude: number;
    latitude: number;
    altitude?: number;
    zoom: number;
  };
  projection: HostFrameOptions['projection'];
  camera: HostRenderView['camera'];
  tileBuffer: number;
};

/** One rendered eye or mono view and its corresponding deck viewport. */
export type XRPresentationRenderView = HostRenderView & {
  id: string;
  hostFrame?: XRHostFrameFields;
  deckViewport: XRDeckViewport;
  xrView?: XRFrameView;
};

/** Result of preparing one mono, stereo-preview, or immersive frame. */
export type XRPresentationFrame = {
  mode: Exclude<XRPresentationMode, 'auto'>;
  logicalViewport: XRDeckViewport;
  renderViews: readonly XRPresentationRenderView[];
  hostFrame: HostFrameOptions;
};

/** Ray expressed in the active XR reference space. */
export type XRSpatialRay = {
  origin: XRVector3;
  direction: XRVector3;
  handedness?: string;
};

/** Pointer expressed in canvas pixels. */
export type XRScreenPointer = {
  x: number;
  y: number;
  eye?: 'left' | 'right' | 'center';
};

/** Input-independent navigation, pointing, and signal contract. */
export type XRInteractionIntent =
  | {
      type: 'navigate';
      action: 'pan' | 'zoom' | 'rotate' | 'pitch' | 'move' | 'turn';
      delta: readonly number[];
      handedness?: string;
    }
  | {
      type: 'point';
      pointer: XRSpatialRay | XRScreenPointer;
      action?: 'hover' | 'select' | 'grab' | 'release';
    }
  | {
      type: 'signal';
      action: string;
      data?: unknown;
    };
