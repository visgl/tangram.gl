// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {HostFrameOptions, HostRenderView} from '@vis.gl/tangram-renderer';
import type {TerrainSurface, TerrainSurfaceHit} from '@vis.gl/tangram-renderer/core';
import type {Controller, FirstPersonViewState, MapViewState, View, Viewport} from '@deck.gl/core';
import type {Matrix4} from '@math.gl/core';

/** Shared geographic navigation state, independent of the rendered eye. */
export type XRViewState = Omit<MapViewState, 'zoom'> & FirstPersonViewState & {zoom?: number};

/** Canvas dimensions used to create a logical or per-eye viewport. */
export type XRViewportSize = {width: number; height: number};

/** Parameters used to derive an eye from the shared logical navigation state. */
export type XREyeViewportOptions<State = XRViewState> = XRViewportSize & {viewState: State; eyeOffset?: number};

/** Matrices supplied to a view-specific projection adapter. */
export type XRProjectionOptions = {projectionMatrix: Matrix4; viewMatrix: Matrix4};

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
  constructor: Function & {displayName?: string};
  controller: View['controller'];
  makeViewport: View['makeViewport'];
  makeEyeViewport(options: XREyeViewportOptions<Parameters<View['makeViewport']>[0]['viewState']>): XRDeckViewport | null;
  getHostFrame(viewport: XRDeckViewport): XRHostFrameFields;
  /** Optional visibility recalculation after actual per-eye camera transforms. */
  getHostFrameForCamera?(viewport: XRDeckViewport, camera: HostRenderView['camera'],
    options?: {width?: number; height?: number}): XRHostFrameFields;
  getXRProjectionMatrix(options: XRProjectionOptions): Matrix4;
};

/** Deck viewport surface used by the package without importing private deck internals. */
export type XRDeckViewport = Viewport & {longitude?: number; latitude?: number; pitch?: number; bearing?: number};

/** Deck controller methods used by the shared logical view. */
export type XRDeckController = Pick<Controller<never>, 'setProps' | 'finalize' | 'updateTransition'>;

/** Host-frame fields derived from one logical deck viewport. */
export type XRHostFrameFields = {
  view: {
    longitude: number;
    latitude: number;
    altitude?: number;
    zoom: number;
  };
  projection?: HostFrameOptions['projection'];
  camera: HostRenderView['camera'];
  tileBuffer?: number;
  /** Optional globally resident coarse globe fallback level. */
  globePreloadZoom?: number;
};

/** One rendered eye or mono view and its corresponding deck viewport. */
export type XRPresentationRenderView = HostRenderView & {
  id: string;
  /** Eye rectangle is always defined by a prepared presentation. */
  viewport: HostFrameOptions['viewport'];
  hostFrame?: XRHostFrameFields;
  deckViewport: XRDeckViewport;
  xrView?: XRFrameView;
  /** Logical view attached to native XR eyes for host integration. */
  view?: XRDeckView;
  /** Shared navigation snapshot attached to native XR eyes. */
  viewState?: XRViewState;
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

/** Top-origin canvas pointer in frame viewport units: CSS pixels for desktop, framebuffer pixels for XR. */
export type XRScreenPointer = {
  x: number;
  y: number;
  eye?: 'left' | 'right' | 'center';
};

/** Geographic analytic or explicit terrain surface hit, not a rendered feature selection. */
export type XRSurfaceHit = {
  /** Longitude/latitude degrees; zero altitude by default, physical terrain altitude when supplied. */
  coordinate: readonly [number, number, number];
  /** EPSG:3857 meters for planar content, or radius-256 globe common coordinates. */
  position: XRVector3;
  /** Rendered eye used by a screen pointer; absent for room rays and logical center-eye picks. */
  renderViewId?: string;
  /** Triangle and normal metadata when the explicit terrain surface was intersected. */
  terrain?: Pick<TerrainSurfaceHit, 'triangleIndex' | 'normal' | 'barycentric'>;
};

/** Snapshot used to resolve a screen pointer or XR reference-space ray. */
export type XRSurfacePickingOptions = {
  /** Host-owned mesh in content coordinates; a miss never falls back to the zero-height surface. */
  terrain?: TerrainSurface;
  /** Top-origin canvas pointer in frame viewport units, or reference-space ray. */
  pointer: XRScreenPointer | XRSpatialRay;
  /** Content placement and optional finite map interaction boundary. */
  placement: XRPlacement;
  /** Actual rendered frame; required for screen pointers. */
  frame?: XRPresentationFrame;
  /** Logical geographic state at the time the frame was rendered. */
  viewState?: Record<string, unknown>;
  /** Actual room placement matrix, including application animation; used only for room rays. */
  placementMatrix?: HostRenderView['camera']['view'];
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
      action?: 'hover' | 'select' | 'grab' | 'release' | 'cancel';
      /** Stable controller/pointer owner during a gesture; omitted for single-pointer clients. */
      inputId?: string;
      /** Activation source, so select release cannot end an independent squeeze grab. */
      button?: 'select' | 'squeeze';
    }
  | {
      type: 'signal';
      action: string;
      data?: unknown;
    };
