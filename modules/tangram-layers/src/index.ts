// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Layer} from '@deck.gl/core';
import {Renderer as ClassicWebGLRenderer} from '@vis.gl/tangram-renderer/core';
import createTangramLayerClass, {
  getExternalCameraFrame,
  getFirstPersonViewFrame,
  getGlobeViewFrame,
  injectNextzenApiKey
} from './tangram-layer.js';

/**
 * A deck.gl basemap layer that renders a Tangram scene into deck's active
 * luma.gl device and render pass.
 */
const TangramLayer = createTangramLayerClass({Layer, ClassicWebGLRenderer, Renderer: undefined});

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
