// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Layer} from '@deck.gl/core';
import {Renderer as ClassicWebGLRenderer} from '@tangram.gl/tangram-renderer/core';
import createTangramLayerClass, {
  getExternalCameraFrame,
  getFirstPersonViewFrame,
  getGlobeViewFrame,
  injectNextzenApiKey
} from './tangram-layer.js';
import type {TangramLayerProps} from './tangram-layer.js';

const BaseTangramLayer = createTangramLayerClass({Layer, ClassicWebGLRenderer, Renderer: undefined});

/**
 * A deck.gl basemap layer that renders a Tangram scene into deck's active
 * luma.gl device and render pass.
 */
class TangramLayer extends BaseTangramLayer {
  /** Preserve deck.gl's complete public context rather than only the bridge capabilities. */
  declare context: Layer<TangramLayerProps>['context'];
  /** Public layer properties retain deck's resolved defaults. */
  declare props: Layer<TangramLayerProps>['props'];
  /** Preserve deck's state update signature through the injected base class. */
  declare setState: Layer<TangramLayerProps>['setState'];
  /** Keep deck's public state surface while the internal adapter checks its own record. */
  declare state: Layer<TangramLayerProps>['state'];
  /** Stable deck.gl metadata for the typed public subclass. */
  static componentName = 'TangramLayer';
  /** Compatibility name for integrations using deck.gl's historical metadata. */
  static layerName = 'TangramLayer';
  /** Preserve deck.gl's public initialization signature through the injected superclass. */
  initializeState(_context: Layer<TangramLayerProps>['context']): void {super.initializeState();}
  /** Forward the standard deck.gl property/state change contract. */
  updateState(parameters: Parameters<Layer<TangramLayerProps>['updateState']>[0]): void {super.updateState(parameters);}
  /** Release the scene using the standard deck.gl finalization signature. */
  finalizeState(_context: Layer<TangramLayerProps>['context']): void {super.finalizeState();}
  /** Forward deck's complete draw options to the existing render-pass bridge. */
  draw(options: Parameters<Layer<TangramLayerProps>['draw']>[0]): void {super.draw(options);}
}

/** deck.gl fields inherited through the dependency-injected runtime superclass. */
interface TangramLayer extends Layer<TangramLayerProps> {}

export {
  TangramLayer,
  createTangramLayerClass,
  getExternalCameraFrame,
  getFirstPersonViewFrame,
  getGlobeViewFrame,
  injectNextzenApiKey
};

export default TangramLayer;
export type {TangramLayerProps} from './tangram-layer.js';

export {default as WebMercatorViewAdapter} from './web_mercator_view_adapter.js';
export {default as FirstPersonViewAdapter} from './first_person_view_adapter.js';
export type {FirstPersonViewAdapterOptions} from './first_person_view_adapter.js';
export {default as GlobeViewAdapter} from './globe_view_adapter.js';
export type {GlobeViewAdapterOptions} from './globe_view_adapter.js';
export type {FirstPersonViewport, GlobeViewport, PlanarCameraViewport} from './view_adapter_types.js';
