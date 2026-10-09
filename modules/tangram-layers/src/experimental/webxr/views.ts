// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  _GlobeController as GlobeController,
  FirstPersonView,
  FirstPersonController,
  MapController,
  MapView,
  _GlobeView as GlobeView
} from '@deck.gl/core';
import type {FirstPersonViewProps, GlobeViewProps, MapViewState, GlobeViewState, WebMercatorViewport, FirstPersonViewport, _GlobeViewport as GlobeViewport} from '@deck.gl/core';
import type {MjolnirGestureEvent} from 'mjolnir.js';
import type {HostCamera} from '@vis.gl/tangram-renderer/core';
import WebMercatorViewAdapter from '../../web_mercator_view_adapter.js';
import FirstPersonViewAdapter, {getFirstPersonFrameForCamera} from '../../first_person_view_adapter.js';
import GlobeViewAdapter from '../../globe_view_adapter.js';
import type {XRDeckViewport, XREyeViewportOptions, XRHostFrameFields, XRProjectionOptions} from './types.js';

/** Shared conservative visibility policy for mono and actual stereo eye cameras. */
type FirstPersonVisibilityProperties = {
  /** Maximum local geographic east/north extent per axis, in meters. */
  firstPersonMaxGroundExtent?: number;
  /** Finite ordered physical height interval, in meters; defaults to ground only. */
  firstPersonElevationRange?: readonly [number, number];
};

/**
 * Map controller that keeps touch pinch rotation enabled while treating a
 * two-finger trackpad gesture as a map pan.
 *
 * deck.gl uses the same `multiTouchDrag` option for both gesture families.
 * The temporary mode below lets the normal controller state handle each
 * gesture without duplicating deck.gl's pan and rotate calculations.
 */
export class WebXRMapController extends MapController {
  _onMultiPanStart(event: MjolnirGestureEvent) {
    const multiTouchDrag = this.multiTouchDrag;
    if (event.pointerType === 'trackpad') {
      this.multiTouchDrag = 'pan';
    }
    const handled = super._onMultiPanStart(event);
    this.multiTouchDrag = multiTouchDrag;
    return handled;
  }
}

/** First-person controller with separate trackpad pan and touch pinch modes. */
export class WebXRFirstPersonController extends FirstPersonController {
  _onMultiPanStart(event: MjolnirGestureEvent) {
    const multiTouchDrag = this.multiTouchDrag;
    if (event.pointerType === 'trackpad') {
      this.multiTouchDrag = 'pan';
    }
    const handled = super._onMultiPanStart(event);
    this.multiTouchDrag = multiTouchDrag;
    return handled;
  }
}

/** Globe controller with separate trackpad pan and touch pinch modes. */
export class WebXRGlobeController extends GlobeController {
  _onMultiPanStart(event: MjolnirGestureEvent) {
    const multiTouchDrag = this.multiTouchDrag;
    if (event.pointerType === 'trackpad') {
      this.multiTouchDrag = 'pan';
    }
    const handled = super._onMultiPanStart(event);
    this.multiTouchDrag = multiTouchDrag;
    return handled;
  }
}

/** MapView that can derive Tangram host-frame fields and per-eye viewports. */
export class WebXRMapView extends MapView {
  static displayName = 'WebXRMapView';

  makeEyeViewport({width, height, viewState, eyeOffset = 0}: XREyeViewportOptions<MapViewState>) {
    const position = viewState.position || [0, 0, 0];
    return this.makeViewport({
      width,
      height,
      viewState: {...viewState, position: [position[0] + eyeOffset, position[1], position[2]]}
    });
  }

  getHostFrame(viewport: WebMercatorViewport): XRHostFrameFields {
    return {
      view: {
        longitude: viewport.longitude,
        latitude: viewport.latitude,
        zoom: viewport.zoom + 1
      },
      projection: {type: 'web-mercator'},
      camera: WebMercatorViewAdapter.getCameraFrame(viewport),
      tileBuffer: Math.min(
        4,
        Math.ceil(
          (Math.tan((Math.abs(viewport.pitch || 0) * Math.PI) / 180) * viewport.height) / 256
        )
      )
    };
  }

  getXRProjectionMatrix({projectionMatrix}: XRProjectionOptions) {
    return projectionMatrix;
  }
}

/** FirstPersonView that can derive Tangram host-frame fields and per-eye viewports. */
export class WebXRFirstPersonView extends FirstPersonView {
  static displayName = 'WebXRFirstPersonView';
  /** Base deck view settings plus Tangram's bounded ground visibility policy. */
  declare props: FirstPersonViewProps & FirstPersonVisibilityProperties;

  /** Configure the logical first-person view and optional ground extent. */
  constructor(props: FirstPersonViewProps & FirstPersonVisibilityProperties = {}) {
    super(props);
  }

  makeEyeViewport({width, height, viewState, eyeOffset = 0}: XREyeViewportOptions) {
    const position = viewState.position || [0, 0, 0];
    return this.makeViewport({
      width,
      height,
      viewState: {...viewState, position: [position[0] + eyeOffset, position[1], position[2]]}
    });
  }

  getHostFrame(viewport: FirstPersonViewport): XRHostFrameFields {
    const frame = FirstPersonViewAdapter.getFrame(viewport, {maxGroundExtent: this.props.firstPersonMaxGroundExtent ?? undefined,
      elevationRange: this.props.firstPersonElevationRange});
    return {
      view: frame.view,
      projection: frame.projection,
      camera: frame.camera,
      tileBuffer: frame.tileBuffer
    };
  }

  /** Recomputes ground visibility after stereo or immersive camera transforms. */
  getHostFrameForCamera(viewport: XRDeckViewport, camera: HostCamera, options: {width?: number; height?: number} = {}): XRHostFrameFields {
    return getFirstPersonFrameForCamera(viewport, camera, {
      ...options,
      maxGroundExtent: this.props.firstPersonMaxGroundExtent ?? undefined,
      elevationRange: this.props.firstPersonElevationRange
    });
  }

  getXRProjectionMatrix({projectionMatrix}: XRProjectionOptions) {
    return projectionMatrix;
  }
}

/** GlobeView that can derive Tangram host-frame fields and per-eye viewports. */
export class WebXRGlobeView extends GlobeView {
  static displayName = 'WebXRGlobeView';
  /** Base deck view settings plus Tangram's globe visibility policies. */
  declare props: GlobeViewProps & {globeMaxElevation?: number; globePreloadZoom?: number};

  /** Configure a globe view and its optional globally resident loading fallback. */
  constructor(props: GlobeViewProps & {globeMaxElevation?: number; globePreloadZoom?: number} = {}) {
    super(props);
  }

  makeEyeViewport({width, height, viewState, eyeOffset = 0}: XREyeViewportOptions<GlobeViewState>) {
    return this.makeViewport({
      width,
      height,
      viewState: {...viewState, longitude: viewState.longitude + eyeOffset * 0.06}
    });
  }

  getHostFrame(viewport: GlobeViewport): XRHostFrameFields {
    const frame = GlobeViewAdapter.getFrame(viewport, {maxElevation: this.props.globeMaxElevation ?? undefined,
      preloadZoom: this.props.globePreloadZoom ?? undefined});
    return {
      view: frame.view,
      projection: frame.projection,
      camera: frame.camera,
      tileBuffer: frame.tileBuffer,
      globePreloadZoom: frame.globePreloadZoom
    };
  }

  getXRProjectionMatrix({projectionMatrix, viewMatrix}: XRProjectionOptions) {
    return projectionMatrix.clone().multiplyRight(viewMatrix);
  }
}
