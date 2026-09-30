// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// @ts-nocheck

import WebMercatorViewAdapter from './web_mercator_view_adapter';

const DECK_TO_TANGRAM_ZOOM_OFFSET = 1;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const VIEW_EPSILON = 1e-7;
const DECK_WORLD_SIZE = 512;
const TANGRAM_HALF_WORLD_METERS = 20037508.342789244;
const TANGRAM_TILE_SIZE = 256;
const FIRST_PERSON_TILE_BUFFER = 1;

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
export function getExternalCameraFrame(viewport) {
  return WebMercatorViewAdapter.getCameraFrame(viewport);
}

/**
 * Converts a deck.gl FirstPersonViewport into Tangram's geographic tile frame.
 *
 * FirstPersonViewport uses planar Web Mercator geometry but does not expose a
 * map-style zoom. Its internal zoom describes meters in common space, not the
 * level of detail needed by the visible ground footprint. This adapter
 * intersects the viewport corners with the ground plane and derives a Tangram
 * zoom from the resulting projected meters per pixel.
 *
 * @param {object} viewport deck.gl FirstPersonViewport.
 * @param {{width?: number, height?: number}} [options] Render-target dimensions.
 * @returns {{viewport: object, view: object, camera: object, tileBuffer: number}}
 */
export function getFirstPersonViewFrame(viewport, options = {}) {
  const width = options.width || viewport.width;
  const height = options.height || viewport.height;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new Error('FirstPersonViewport requires positive width and height');
  }
  if (
    typeof viewport.unproject !== 'function' ||
    typeof viewport.projectFlat !== 'function' ||
    typeof viewport.unprojectFlat !== 'function'
  ) {
    throw new Error('FirstPersonViewport ground projection methods are required');
  }

  const groundCorners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height]
  ].map((pixel) => getForwardGroundIntersection(viewport, pixel));
  if (groundCorners.some((corner) => !isFiniteCoordinate(corner))) {
    throw new Error('FirstPersonViewport must intersect the ground plane');
  }

  const projectedCorners = groundCorners.map((corner) => viewport.projectFlat(corner));
  if (projectedCorners.some((corner) => !isFiniteCoordinate(corner))) {
    throw new Error('FirstPersonViewport ground footprint must use Web Mercator coordinates');
  }

  const xValues = projectedCorners.map((corner) => corner[0]);
  const yValues = projectedCorners.map((corner) => corner[1]);
  const west = Math.min(...xValues);
  const east = Math.max(...xValues);
  const north = Math.min(...yValues);
  const south = Math.max(...yValues);
  const footprintWidth = east - west;
  const footprintHeight = south - north;
  const commonUnitsPerProjectedMeter = DECK_WORLD_SIZE / (TANGRAM_HALF_WORLD_METERS * 2);
  const metersPerPixel = Math.max(
    footprintWidth / commonUnitsPerProjectedMeter / width,
    footprintHeight / commonUnitsPerProjectedMeter / height
  );
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
    throw new Error('FirstPersonViewport ground footprint is empty');
  }

  const center = viewport.unprojectFlat([(west + east) / 2, (north + south) / 2]);
  if (!isFiniteCoordinate(center)) {
    throw new Error('FirstPersonViewport ground footprint center is invalid');
  }
  const worldSizeMeters = TANGRAM_HALF_WORLD_METERS * 2;
  const zoom = Math.log2(worldSizeMeters / (TANGRAM_TILE_SIZE * metersPerPixel));

  return {
    viewport: {width, height},
    view: {
      longitude: center[0],
      latitude: center[1],
      altitude:
        viewport.position && Number.isFinite(viewport.position[2]) ? viewport.position[2] : 0,
      zoom
    },
    camera: getExternalCameraFrame(viewport),
    tileBuffer: FIRST_PERSON_TILE_BUFFER
  };
}

/**
 * Converts a deck.gl GlobeViewport into Tangram's host-frame contract.
 *
 * Globe matrices consume deck common-space coordinates directly. Tangram's
 * renderer converts its EPSG:3857 tile vertices to deck's radius-256 globe in
 * the vertex shader before applying these matrices.
 *
 * @param {object} viewport deck.gl GlobeViewport.
 * @returns {object} Tangram HostFrame fields for a globe render view.
 */
export function getGlobeViewFrame(viewport) {
  if (
    !viewport ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    !viewport.viewMatrix ||
    viewport.viewMatrix.length !== 16 ||
    !viewport.projectionMatrix ||
    viewport.projectionMatrix.length !== 16 ||
    !isFiniteVector3(viewport.cameraPosition) ||
    typeof viewport.getBounds !== 'function'
  ) {
    throw new Error('deck GlobeViewport matrices, camera position, size, and visible bounds are required');
  }

  const visibleBounds = viewport.getBounds({z: 0});
  if (
    !Array.isArray(visibleBounds) ||
    visibleBounds.length !== 4 ||
    visibleBounds.some((value) => !Number.isFinite(value))
  ) {
    throw new Error('deck GlobeViewport must provide finite geographic bounds');
  }

  return {
    viewport: {width: viewport.width, height: viewport.height},
    view: {
      longitude: viewport.longitude,
      latitude: viewport.latitude,
      zoom: getTangramGlobeZoom(viewport.zoom, viewport.latitude)
    },
    projection: {type: 'globe', visibleBounds},
    camera: {
      view: new Float64Array(viewport.viewMatrix),
      projection: new Float32Array(
        multiplyMatrices(viewport.projectionMatrix, viewport.viewMatrix)
      ),
      position: Array.from(viewport.cameraPosition)
    },
    tileBuffer: 0
  };
}

/**
 * Converts deck.gl GlobeViewport zoom to Tangram's Mercator tile zoom scale.
 * GlobeViewport compensates zoom by latitude so its scale converges with
 * Web Mercator at high zoom; apply the same adjustment before choosing tiles.
 * @param zoom deck.gl GlobeViewport zoom.
 * @param latitude Globe center latitude in degrees.
 * @returns Tangram zoom value with the package's tile-size offset applied.
 */
function getTangramGlobeZoom(zoom, latitude) {
  const scaleLatitude = Math.max(
    -MAX_MERCATOR_LATITUDE,
    Math.min(MAX_MERCATOR_LATITUDE, latitude)
  );
  const latitudeScaleAdjustment = Math.log2(
    Math.PI * Math.cos((scaleLatitude * Math.PI) / 180)
  );
  return Math.max(0, zoom - latitudeScaleAdjustment + DECK_TO_TANGRAM_ZOOM_OFFSET);
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
export function createTangramLayerClass({Layer, ClassicWebGLRenderer, Renderer}) {
  const rendererClass = ClassicWebGLRenderer || Renderer;
  if (!Layer || !rendererClass) {
    throw new Error('createTangramLayerClass requires Layer and ClassicWebGLRenderer');
  }

  class TangramLayer extends Layer {
    initializeState() {
      this.setState({tangramRecord: null});
    }

    updateState({props}) {
      let record = this.state.tangramRecord;
      const shouldCreateScene =
        !record ||
        record.sceneSource !== props.scene ||
        record.sceneBasePath !== props.sceneBasePath ||
        record.apiKey !== props.apiKey;

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

    _synchronizeTangramScene(record) {
      const viewport = this.context.viewport;
      const viewports = this.context.deck.getViewports
        ? this.context.deck.getViewports()
        : [viewport];
      const viewportError = validateViewport(viewport, viewports);

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
      record.renderer.setFrame(
        isGlobeViewport(viewport)
          ? {...getGlobeViewFrame(viewport), viewport: {width, height}}
          : isFirstPersonViewport(viewport)
            ? getFirstPersonViewFrame(viewport, {width, height})
            : getMapViewFrame(viewport, {width, height})
      );
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
    scene: null,
    sceneBasePath: null,
    apiKey: null,
    onSceneLoad: () => {},
    onSceneError: () => {}
  };

  return TangramLayer;
}

function validateViewport(viewport, viewports) {
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
      getGlobeViewFrame(viewport);
    } else if (isFirstPersonViewport(viewport)) {
      getFirstPersonViewFrame(viewport);
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

function isFiniteCoordinate(coordinate) {
  return coordinate && Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]);
}

function isFiniteVector3(vector) {
  return vector && vector.length === 3 && vector.every(Number.isFinite);
}

function getForwardGroundIntersection(viewport, pixel) {
  const near = viewport.unproject([pixel[0], pixel[1], 0]);
  const far = viewport.unproject([pixel[0], pixel[1], 1]);
  if (
    !isFiniteCoordinate(near) ||
    !Number.isFinite(near[2]) ||
    !isFiniteCoordinate(far) ||
    !Number.isFinite(far[2])
  ) {
    return null;
  }

  const rayParameter = -near[2] / (far[2] - near[2]);
  if (!Number.isFinite(rayParameter) || rayParameter <= 0) {
    return null;
  }
  return viewport.unproject(pixel, {targetZ: 0});
}

function isGlobeViewport(viewport) {
  return Boolean(
    viewport &&
      (viewport.constructor?.displayName === 'GlobeViewport' ||
        viewport.constructor?.name === 'GlobeViewport')
  );
}

function multiplyMatrices(left, right) {
  const result = new Float64Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let value = 0;
      for (let index = 0; index < 4; index++) {
        value += left[index * 4 + row] * right[column * 4 + index];
      }
      result[column * 4 + row] = value;
    }
  }
  return result;
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
