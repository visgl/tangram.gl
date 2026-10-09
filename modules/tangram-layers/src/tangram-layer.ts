// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// @ts-nocheck

import WebMercatorViewAdapter from './web_mercator_view_adapter.js';
import FirstPersonViewAdapter from './first_person_view_adapter.js';
import GlobeViewAdapter from './globe_view_adapter.js';
import type {GlobeViewAdapterOptions} from './globe_view_adapter.js';
import type {FirstPersonViewAdapterOptions} from './first_person_view_adapter.js';
import type {FirstPersonViewport, GlobeViewport} from './view_adapter_types.js';
import type {HostFrameOptions} from '@vis.gl/tangram-renderer/core';
import type {ProjectionEngine, ProjectionExecutionOptions} from '@vis.gl/tangram-renderer/core';
import type {LayerProps} from '@deck.gl/core';
import type {SceneDefinition} from '@vis.gl/tangram-renderer/core';

/** Tangram-specific properties in addition to ordinary deck.gl layer properties. */
export type TangramLayerProps = LayerProps & {
  /** Inline scene or URL loaded by the renderer. */
  scene: SceneDefinition;
  /** Caller-owned CRS factory for CPU-projected basemaps; omitted keeps worker-local math.gl transforms. */
  projectionEngine?: ProjectionEngine;
  /** Immutable host kernel chunking policy; changing it recreates the scene, like changing the engine. */
  projectionEngineExecution?: ProjectionExecutionOptions;
  /** Remaining existing Tangram bridge properties. */
  [property: string]: unknown;
};

/** Opt-in host adapter, kept independent of the ordinary geographic view dispatch. */
export interface TangramHostViewAdapter {
  /** Validate and adapt a host viewport before modifying renderer state. */
  getFrame(viewport: unknown, properties: unknown, dimensions: {width: number; height: number}): HostFrameOptions;
}

const VIEW_EPSILON = 1e-7;

/**
 * Injects an API key into every Nextzen source in a Tangram scene.
 *
 * @param {object} config Tangram scene configuration.
 * @param {string|null|undefined} apiKey Nextzen API key.
 * @returns {boolean} `true` when at least one source was updated.
 */
export function injectNextzenApiKey(config, apiKey) {
  if (!apiKey || !config || !config.sources) {
    return false;
  }

  let updated = false;
  for (const source of Object.values(config.sources)) {
    if (source && typeof source.url === 'string' && source.url.includes('nextzen.org')) {
      source.url_params = source.url_params || {};
      source.url_params.api_key = apiKey;
      updated = true;
    }
  }
  return updated;
}

/**
 * Converts a deck.gl Web Mercator viewport into Tangram camera matrices.
 *
 * Tangram tile models use absolute EPSG:3857 meters while deck matrices consume
 * zoom-zero common coordinates. Altitude remains in physical meters and uses
 * deck's latitude-dependent distance scale.
 *
 * @param {object} viewport deck.gl WebMercatorViewport.
 * @returns {{view: Float64Array, projection: Float32Array, position: number[]}}
 */
export function getExternalCameraFrame(viewport): {view: Float64Array; projection: Float32Array; position: [number, number, number]} {
  return WebMercatorViewAdapter.getCameraFrame(viewport);
}

/** Converts a finite first-person camera into a bounded flat-ground host frame. */
export function getFirstPersonViewFrame(viewport: FirstPersonViewport, options: FirstPersonViewAdapterOptions = {}) {
  return FirstPersonViewAdapter.getFrame(viewport, options);
}

export function getGlobeViewFrame(viewport: GlobeViewport, options: GlobeViewAdapterOptions = {}) {
  return GlobeViewAdapter.getFrame(viewport, options);
}

/**
 * Creates an experimental deck.gl layer class that renders Tangram through
 * Tangram's luma.gl device renderer.
 *
 * The class is dependency-injected so this demo does not add deck.gl as a Tangram
 * package dependency.
 *
 * @param {object} dependencies Bridge dependencies.
 * @param {typeof import('@deck.gl/core').Layer} dependencies.Layer deck.gl Layer class.
 * @param {object} dependencies.ClassicWebGLRenderer Embeddable Tangram renderer class.
 * @param {object} dependencies.Renderer Legacy alias for ClassicWebGLRenderer.
 * @returns {typeof import('@deck.gl/core').Layer} TangramLayer class.
 */
export function createTangramLayerClass({Layer, ClassicWebGLRenderer, Renderer}, viewAdapter?: TangramHostViewAdapter) {
  const rendererClass = ClassicWebGLRenderer || Renderer;
  if (!Layer || !rendererClass) {
    throw new Error('createTangramLayerClass requires Layer and ClassicWebGLRenderer');
  }

  class TangramLayer extends Layer {
    /** Forward deck.gl's property objects without changing its constructor semantics. */
    constructor(...properties: Partial<TangramLayerProps>[]) {
      super(...properties);
    }

    initializeState() {
      this.setState({tangramRecord: null});
    }

    updateState({props}) {
      let record = this.state.tangramRecord;
      const shouldCreateScene =
        !record ||
        record.sceneSource !== props.scene ||
        record.sceneBasePath !== props.sceneBasePath ||
        record.apiKey !== props.apiKey ||
        record.projectionEngine !== (props.projectionEngine ?? undefined) ||
        record.projectionEngineExecution !== (props.projectionEngineExecution ?? undefined) ||
        record.maxConcurrentTileLoadsPerWorker !== (props.maxConcurrentTileLoadsPerWorker ?? undefined);

      if (shouldCreateScene) {
        this._disposeTangramRecord(record);
        record = this._createTangramRecord(props);
        this.setState({tangramRecord: record});
      }

      if (record) {
        record.owner = this;
      }
    }

    draw({renderPass} = {}) {
      const record = this.state.tangramRecord;
      if (!record || record.disposed) {
        return;
      }

      record.owner = this;
      this._synchronizeTangramScene(record);
      if (!this._canRender(record, this.props)) {
        return;
      }

      const renderTangram = () => {
        const update_options = {force: true};
        renderPass = renderPass || this.context.renderPass;
        if (renderPass) {
          update_options.renderPass = renderPass;
        }
        const rendered = record.renderer.render(update_options);
        if (
          record.scene.config &&
          record.scene.config.scene &&
          record.scene.config.scene.animated === true
        ) {
          // Keep host-driven scenes moving even while deck's view is idle.
          // Tangram's active-style list can lag tile/style activation by a frame.
          this.setNeedsRedraw();
        }
        if (rendered && record.gl) {
          // Tangram's depth and stencil buffers are internal implementation
          // details. Preserve its color output but leave a clean depth buffer
          // for deck layers that follow this basemap.
          record.gl.depthMask(true);
          record.gl.clear(record.gl.DEPTH_BUFFER_BIT | record.gl.STENCIL_BUFFER_BIT);
        }
      };

      if (record.device.type === 'webgl') {
        record.scene.withWebGLContext(renderTangram);
      } else {
        renderTangram();
      }
    }

    finalizeState() {
      this._disposeTangramRecord(this.state && this.state.tangramRecord);
    }

    get isLoaded() {
      const record = this.state && this.state.tangramRecord;
      return Boolean(record && record.loaded && !record.loadFailed && !record.disposed);
    }

    _createTangramRecord(props) {
      if (!props.scene) {
        this._raiseBridgeError(new Error('scene is required'));
        return null;
      }

      const deckCanvas = this.context.deck && this.context.deck.getCanvas();
      const device = this.context.device;
      if (!deckCanvas) {
        this._raiseBridgeError(new Error('deck canvas is required'));
        return null;
      }
      if (
        !device ||
        (device.type !== 'webgl' && device.type !== 'webgpu') ||
        typeof device.createBuffer !== 'function' ||
        typeof device.createShader !== 'function' ||
        typeof device.createTexture !== 'function' ||
        typeof device.createRenderPipeline !== 'function' ||
        typeof device.createVertexArray !== 'function'
      ) {
        this._raiseBridgeError(new Error('a deck.gl luma.gl Device is required'));
        return null;
      }

      let gl = null;
      if (device.type === 'webgl') {
        gl = device.handle;
        if (
          !gl ||
          typeof device.pushState !== 'function' ||
          typeof device.popState !== 'function'
        ) {
          this._raiseBridgeError(new Error('a deck.gl WebGLDevice is required'));
          return null;
        }
        if (gl.canvas !== deckCanvas) {
          this._raiseBridgeError(
            new Error('deck canvas and WebGLDevice handle must share a context')
          );
          return null;
        }
      }

      const record = {
        owner: this,
        renderer: null,
        scene: null,
        device,
        gl,
        deckCanvas,
        sceneSource: props.scene,
        sceneBasePath: props.sceneBasePath,
        apiKey: props.apiKey,
        projectionEngine: props.projectionEngine ?? undefined,
        projectionEngineExecution: props.projectionEngineExecution ?? undefined,
        maxConcurrentTileLoadsPerWorker: props.maxConcurrentTileLoadsPerWorker ?? undefined,
        canvasWidth: null,
        canvasHeight: null,
        disposed: false,
        destroyed: false,
        loadSettled: false,
        loadFailed: false,
        loaded: false,
        lastSceneError: null,
        lastViewportError: null,
        reportedViewportError: null,
        loadPromise: null,
        webglScopeDepth: 0
      };

      let renderer;
      try {
        const renderer_options = {
          device,
          canvas: deckCanvas,
          projectionEngine: record.projectionEngine,
          projectionEngineExecution: record.projectionEngineExecution,
          maxConcurrentTileLoadsPerWorker: record.maxConcurrentTileLoadsPerWorker,
          requestRedraw: () => {
            if (!record.disposed && record.owner.setNeedsRedraw) {
              record.owner.setNeedsRedraw();
            }
          },
          continuousZoom: true,
          highDensityDisplay: true,
          logLevel: 'warn'
        };
        if (gl) {
          renderer_options.webGLContext = gl;
          renderer_options.webGLContextScope = (callback) =>
            this._withDeviceState(record, callback);
        }
        renderer = rendererClass.create(props.scene, renderer_options);
      } catch (error) {
        this._raiseBridgeError(normalizeError(error));
        return null;
      }
      record.renderer = renderer;
      record.scene = renderer.scene;

      renderer.subscribe({
        load: (message) => {
          injectNextzenApiKey(message.config, record.apiKey);
        },
        update: () => this._updateAttributions(record),
        error: (message) =>
          this._reportSceneError(record, normalizeError(message), message.type !== 'scene_import')
      });

      this._synchronizeTangramScene(record);
      record.loadPromise = Promise.resolve()
        .then(() => {
          if (record.disposed) {
            return null;
          }
          return renderer.load(props.scene, {
            base_path: props.sceneBasePath,
            blocking: false
          });
        })
        .then((result) => {
          if (!record.disposed) {
            record.loaded = true;
            record.owner.setNeedsRedraw && record.owner.setNeedsRedraw();
            record.owner.props.onSceneLoad(record.scene);
            this._updateAttributions(record);
          }
          return result;
        })
        .catch((error) => {
          if (!record.disposed) {
            record.loadFailed = true;
            this._reportSceneError(record, normalizeError(error));
          }
        })
        .finally(() => {
          record.loadSettled = true;
          if (record.disposed) {
            this._destroyTangramRecord(record);
          }
        });

      return record;
    }

    /** Refresh credits after source recreation; ignore stale metadata and disposed layers. */
    _updateAttributions(record) {
      if (record.disposed || typeof record.renderer.getAttributions !== 'function') return;
      const generation = record.attributionGeneration = (record.attributionGeneration || 0) + 1;
      Promise.resolve().then(() => record.disposed ? undefined : record.renderer.getAttributions()).then(credits => {
        if (credits && !record.disposed && generation === record.attributionGeneration) {
          record.owner.props.onAttributionChange?.(credits, record.scene);
        }
      }).catch(error => {
        if (!record.disposed && generation === record.attributionGeneration) {
          this._reportSceneError(record, normalizeError(error), false);
        }
      });
    }

    _synchronizeTangramScene(record) {
      const viewport = this.context.viewport;
      const viewports = this.context.deck.getViewports
        ? this.context.deck.getViewports()
        : [viewport];
      if (viewAdapter) {
        try {
          if (viewports.length !== 1) throw new Error('only one deck.gl viewport is supported');
          const width = record.deckCanvas.clientWidth || viewport.width;
          const height = record.deckCanvas.clientHeight || viewport.height;
          const frame = viewAdapter.getFrame(viewport, this.props, {width, height});
          record.renderer.setFrame({...frame, tileResources: this.props.tileResources ?? undefined});
          record.lastViewportError = null;
          record.reportedViewportError = null;
        } catch (error) {
          record.lastViewportError = error.message;
          this._raiseViewportError(record, normalizeError(error));
        }
        return;
      }
      const globeOptions = {
        maxElevation: this.props.globeMaxElevation ?? undefined,
        visibleBounds: this.props.globeVisibleBounds ?? undefined,
        preloadZoom: this.props.globePreloadZoom ?? undefined
      };
      const firstPersonOptions = {maxGroundExtent: this.props.firstPersonMaxGroundExtent ?? undefined};
      const viewportError = validateViewport(viewport, viewports, globeOptions, firstPersonOptions);

      if (viewportError) {
        record.lastViewportError = viewportError.message;
        this._raiseViewportError(record, viewportError);
        return;
      }

      record.lastViewportError = null;
      record.reportedViewportError = null;
      const width = record.deckCanvas.clientWidth || viewport.width;
      const height = record.deckCanvas.clientHeight || viewport.height;

      record.canvasWidth = width;
      record.canvasHeight = height;
      const frame = isGlobeViewport(viewport)
          ? {...getGlobeViewFrame(viewport, globeOptions), viewport: {width, height}}
          : isFirstPersonViewport(viewport)
            ? getFirstPersonViewFrame(viewport, {width, height, ...firstPersonOptions})
            : getMapViewFrame(viewport, {width, height});
      record.renderer.setFrame({...frame, tileResources: this.props.tileResources ?? undefined});
    }

    _canRender(record, props) {
      return (
        props.visible !== false &&
        props.opacity !== 0 &&
        record.loaded &&
        !record.loadFailed &&
        !record.lastViewportError
      );
    }

    _raiseViewportError(record, error) {
      if (record.reportedViewportError === error.message) {
        return;
      }
      record.reportedViewportError = error.message;
      this._raiseBridgeError(error);
    }

    _reportSceneError(record, error, isFatal = true) {
      if (record.disposed || record.lastSceneError === error.message) {
        return;
      }
      record.lastSceneError = error.message;
      if (isFatal) {
        record.loadFailed = true;
      }
      record.owner.props.onSceneError(error, record.scene);
      record.owner.raiseError(error, 'TangramLayer scene');
    }

    _raiseBridgeError(error) {
      this.raiseError(error, 'TangramLayer bridge');
    }

    _disposeTangramRecord(record) {
      if (!record || record.disposed) {
        return;
      }
      record.disposed = true;
      if (!record.loadPromise || record.loadSettled) {
        this._destroyTangramRecord(record);
      }
    }

    _destroyTangramRecord(record) {
      if (!record.destroyed) {
        record.destroyed = true;
        record.renderer.destroy();
      }
    }

    _withDeviceState(record, callback) {
      if (record.webglScopeDepth > 0) {
        return callback();
      }

      const {device, gl} = record;
      const lumaState = gl.lumaState;
      const hasTrackedProgram = Boolean(lumaState && 'program' in lumaState);
      const previousProgram = hasTrackedProgram
        ? lumaState.program
        : gl.getParameter(gl.CURRENT_PROGRAM);

      record.webglScopeDepth++;
      device.pushState();
      try {
        return callback();
      } finally {
        try {
          device.popState();
          gl.useProgram(previousProgram);
        } finally {
          record.webglScopeDepth--;
        }
      }
    }
  }

  TangramLayer.layerName = 'TangramLayer';
  TangramLayer.defaultProps = {
    projectionEngine: null,
    projectionEngineExecution: null,
    scene: null,
    sceneBasePath: null,
    apiKey: null,
    globeMaxElevation: null,
    globeVisibleBounds: null,
    globePreloadZoom: null,
    tileResources: null,
    maxConcurrentTileLoadsPerWorker: null,
    firstPersonMaxGroundExtent: 20000,
    onSceneLoad: () => {},
    onAttributionChange: () => {},
    onSceneError: () => {}
  };

  return TangramLayer;
}

function validateViewport(viewport, viewports, globeOptions = {}, firstPersonOptions = {}) {
  if (viewports.length !== 1) {
    return new Error('only one deck.gl viewport is supported');
  }
  const globe = isGlobeViewport(viewport);
  const geographicAnchorError = WebMercatorViewAdapter.validateGeographicAnchor(
    viewport,
    globe ? 'GlobeViewport' : 'Web Mercator viewport'
  );
  if (geographicAnchorError) {
    return globe ? geographicAnchorError : new Error('a Web Mercator viewport is required');
  }
  // deck.gl uses both WEB_MERCATOR (1) and its high-zoom
  // WEB_MERCATOR_AUTO_OFFSET (4) internally. The numeric projection mode is
  // not part of the public viewport contract, so validate the public
  // geospatial capability instead of rejecting high-zoom MapView instances.
  if (!globe) {
    const webMercatorError = WebMercatorViewAdapter.validateViewport(viewport);
    if (webMercatorError) {
      return webMercatorError;
    }
  }
  if (
    !Number.isFinite(viewport.bearing || 0) ||
    !Number.isFinite(viewport.pitch || 0) ||
    (viewport.pitch || 0) < -VIEW_EPSILON ||
    (viewport.pitch || 0) >= 90
  ) {
    return new Error('bearing and pitch must describe a finite deck.gl camera');
  }
  try {
    if (globe) {
      getGlobeViewFrame(viewport, globeOptions);
    } else if (isFirstPersonViewport(viewport)) {
      getFirstPersonViewFrame(viewport, firstPersonOptions);
    } else {
      WebMercatorViewAdapter.getCameraFrame(viewport);
    }
  } catch (error) {
    return error;
  }
  return null;
}

function getMapViewFrame(viewport, {width, height}) {
  return WebMercatorViewAdapter.getFrame(viewport, {width, height});
}

function isFirstPersonViewport(viewport) {
  return Boolean(
    viewport && viewport.constructor && viewport.constructor.displayName === 'FirstPersonViewport'
  );
}

function isGlobeViewport(viewport) {
  return Boolean(
    viewport &&
      (viewport.constructor?.displayName === 'GlobeViewport' ||
        viewport.constructor?.name === 'GlobeViewport')
  );
}

function normalizeError(value) {
  if (value instanceof Error) {
    return value;
  }
  if (value && value.error instanceof Error) {
    return value.error;
  }
  if (value && value.message) {
    return new Error(value.message);
  }
  return new Error(String(value));
}

export default createTangramLayerClass;
