// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {luma} from '@luma.gl/core';
import {AnimationLoop, Timeline} from '@luma.gl/engine';
import {WebXRAnimationFrameProvider, WebXRManager} from '@luma.gl/experimental';
import {webgl2Adapter} from '@luma.gl/webgl';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {ClassicWebGLRenderer} from '@vis.gl/tangram-renderer';
import {
  WebXRFirstPersonView,
  WebXRGlobeView,
  WebXRMapView,
  WebXRInputAdapter,
  WebXRViewManager,
  createXRPlacementMatrix,
  setWebXRSessionWithFallback
} from './webxr-views.js';

const PREVIEW_RADIUS_METERS = 0.72;
const NEW_YORK_LONGITUDE = -74.009764;
const NEW_YORK_LATITUDE = 40.705319;
const FULL_GLOBE_BOUNDS = [-180, -85, 180, 85];
const VIEW_MODES = {
  globe: {
    id: 'globe',
    label: 'GlobeView',
    // A room-size globe still needs regional tiles: world-level polygons use
    // long planar triangles that become visible chords when projected to a sphere.
    zoom: 5,
    projection: {type: 'globe', visibleBounds: FULL_GLOBE_BOUNDS},
    tileBuffer: 0
  },
  map: {
    id: 'map',
    label: 'MapView',
    zoom: 16,
    projection: {type: 'web-mercator'},
    tileBuffer: 2
  },
  firstPerson: {
    id: 'firstPerson',
    label: 'FirstPersonView',
    zoom: 16,
    projection: {type: 'web-mercator'},
    tileBuffer: 2
  },
  thor: {
    id: 'thor',
    label: 'Thor gestures',
    zoom: 16,
    projection: {type: 'web-mercator'},
    tileBuffer: 2
  }
};
const canvas = document.getElementById('webxr-canvas');
const container = document.getElementById('webxr-container');
const enterButton = document.getElementById('webxr-enter');
const exitButton = document.getElementById('webxr-exit');
const monoButton = document.getElementById('webxr-mono');
const stereoButton = document.getElementById('webxr-stereo');
const thorButton = document.getElementById('webxr-thor-enable');
const statusElement = document.getElementById('webxr-status');
const titleElement = document.getElementById('webxr-title');
const deviceButtons = document.querySelectorAll('[data-webxr-device]');
const query = new URLSearchParams(window.location.search);
const requestedDeviceType = query.get('device') === 'webgpu' ? 'webgpu' : 'webgl';
const requestedViewMode = window.tangramWebXRViewMode || query.get('view');
const viewMode = VIEW_MODES[requestedViewMode] || VIEW_MODES.globe;
const viewManager = createWebXRViewManager(viewMode.id);
const webXRInputAdapter = new WebXRInputAdapter();

if (thorButton && viewMode.id === 'thor') {
  thorButton.hidden = false;
}

function createWebXRViewManager(mode) {
  if (mode === 'map' || mode === 'thor') {
    return new WebXRViewManager({
      view: new WebXRMapView({
        id: 'map',
        controller: {
          dragPan: true,
          dragRotate: true,
          doubleClickZoom: true,
          scrollZoom: true,
          touchZoom: true,
          touchRotate: true,
          keyboard: true,
          maxPitch: 60
        }
      }),
      viewState: {
        longitude: NEW_YORK_LONGITUDE,
        latitude: NEW_YORK_LATITUDE,
        zoom: 14.5,
        bearing: -20,
        pitch: 45
      }
    });
  }
  if (mode === 'firstPerson') {
    return new WebXRViewManager({
      view: new WebXRFirstPersonView({id: 'first-person', controller: true, far: 20000}),
      viewState: {
        // Start above Battery Park, outside the newly extruded skyscrapers.
        longitude: -74.0165,
        latitude: 40.703,
        position: [0, 0, 150],
        bearing: 35,
        pitch: 45
      }
    });
  }
  return new WebXRViewManager({
    view: new WebXRGlobeView({id: 'globe', controller: true}),
    viewState: {
      longitude: NEW_YORK_LONGITUDE,
      latitude: NEW_YORK_LATITUDE,
      zoom: 0.8
    }
  });
}

let device;
let renderer;
let webXRManager;
let animationLoop;
let xrSession = null;
let stereoPreview = false;
let immersiveVRSupported = false;
let xrReferenceSpaceType = 'local-floor';
let destroyed = false;
let thorController = null;
let lastXRFrameTime = null;

const scene = createTronScene({portable: requestedDeviceType === 'webgpu'});

if (titleElement) {
  titleElement.textContent = `WebXR ${viewMode.label}`;
}

for (const button of deviceButtons) {
  const active = button.dataset.webxrDevice === requestedDeviceType;
  button.classList.toggle('is-active', active);
  button.setAttribute('aria-selected', String(active));
  button.addEventListener('click', () => {
    if (!active) {
      const url = new URL(window.location.href);
      url.searchParams.set('device', button.dataset.webxrDevice);
      window.location.assign(url);
    }
  });
}

function setStatus(message, type = '') {
  statusElement.textContent = message;
  statusElement.dataset.type = type;
}

function updatePresentationButtons(mode) {
  monoButton.classList.toggle('is-active', mode === 'mono');
  stereoButton.classList.toggle('is-active', mode === 'stereo-preview');
  enterButton.classList.toggle('is-active', mode === 'immersive-vr');
  monoButton.setAttribute('aria-pressed', String(mode === 'mono'));
  stereoButton.setAttribute('aria-pressed', String(mode === 'stereo-preview'));
  enterButton.setAttribute('aria-pressed', String(mode === 'immersive-vr'));
}

function resizePreviewCanvas() {
  const canvasContext = device.getDefaultCanvasContext();
  const width = Math.max(1, Math.round(canvas.clientWidth * window.devicePixelRatio));
  const height = Math.max(1, Math.round(canvas.clientHeight * window.devicePixelRatio));
  const [drawingBufferWidth, drawingBufferHeight] = canvasContext.getDrawingBufferSize();
  if (width !== drawingBufferWidth || height !== drawingBufferHeight) {
    canvasContext.setDrawingBufferSize(width, height);
  }
  // deck.gl cameras and controllers use CSS pixels; only the GPU pass uses
  // drawing-buffer pixels. Mixing them changes zoom and gesture speed on Retina.
  return {
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    bufferWidth: width,
    bufferHeight: height
  };
}

function createPlacementMatrix({immersive, time}) {
  const viewState = viewManager.getViewState();
  if (viewMode.id === 'globe') {
    return createXRPlacementMatrix(
      {
        type: 'globe',
        anchor: [viewState.longitude, viewState.latitude, 0],
        pose: {position: immersive ? [0, 1.35, -2.35] : [0.5, 0, -2.6]},
        radius: PREVIEW_RADIUS_METERS * 2 ** clamp(viewState.zoom, -1, 1.5),
        rotation: (-time * 0.00004 * 180) / Math.PI
      },
      viewState
    );
  }

  if (viewMode.id === 'map' || viewMode.id === 'thor') {
    const extraAngle = immersive ? 0 : Math.PI * 0.14;
    return createXRPlacementMatrix(
      {
        type: 'map',
        anchor: [viewState.longitude, viewState.latitude, 0],
        pose: {
          position: immersive ? [0, 0.72, -1.8] : [0.25, -0.48, -2.4],
          orientation: [Math.sin(extraAngle / 2), 0, 0, Math.cos(extraAngle / 2)]
        },
        metersPerXRUnit: 2500,
        surface: {type: 'unbounded'}
      },
      viewState
    );
  }

  const groundY = immersive
    ? xrReferenceSpaceType === 'local-floor'
      ? 0
      : -1.6
    : 0;
  return createXRPlacementMatrix(
    {
      type: 'first-person',
      origin: [viewState.longitude, viewState.latitude, 0],
      pose: {position: [0, groundY, 0]},
      position: viewManager.placement.position || [0, 0, 0],
      bearing: viewState.bearing || 0
    },
    viewState
  );
}

function createHostFrame({viewport, renderViews, activeRenderViewId}) {
  const viewState = viewManager.getViewState();
  const hostFrame = renderViews.find((renderView) => renderView.hostFrame)?.hostFrame;
  const geographicAnchor = hostFrame?.view || {
    longitude: viewState.longitude,
    latitude: viewState.latitude,
    zoom: viewMode.zoom
  };
  return {
    viewport,
    geographicAnchor: viewMode.id === 'globe'
      ? {...geographicAnchor, zoom: Math.max(viewMode.zoom, geographicAnchor.zoom)}
      : geographicAnchor,
    projection: hostFrame?.projection || viewMode.projection,
    renderViews,
    activeRenderViewId,
    tileBuffer: hostFrame?.tileBuffer ?? viewMode.tileBuffer
  };
}

function renderTangram({frame, renderPass, renderViewId}) {
  const render = () => renderer.render({frame, renderPass, renderViewId, force: true});
  if (device.type === 'webgl') {
    renderer.scene.withWebGLContext(render);
  } else {
    render();
  }
}

function renderPreview() {
  const {width, height, bufferWidth, bufferHeight} = resizePreviewCanvas();
  viewManager.updateController({width, height});
  const viewport = {x: 0, y: 0, width, height};
  const renderView = viewManager.makeRenderView({id: 'preview', width, height});
  const renderPass = device.beginRenderPass({
    clearColor: [0.006, 0.014, 0.04, 1],
    clearDepth: 1,
    clearStencil: 0
  });
  renderPass.setParameters({viewport: [0, 0, bufferWidth, bufferHeight]});
  renderTangram({
    frame: createHostFrame({
      viewport,
      renderViews: [renderView],
      activeRenderViewId: renderView.id
    }),
    renderPass,
    renderViewId: renderView.id
  });
  renderPass.end();
}

function renderStereoPreview() {
  const {width, height, bufferWidth, bufferHeight} = resizePreviewCanvas();
  viewManager.updateController({width, height});
  const eyeWidth = width / 2;
  const bufferEyeWidth = Math.floor(bufferWidth / 2);
  const renderViews = viewManager.makeStereoRenderViews({
    width: eyeWidth,
    height
  });
  const hostFrame = createHostFrame({
    viewport: {x: 0, y: 0, width, height},
    renderViews,
    activeRenderViewId: renderViews[0].id
  });
  for (let index = 0; index < renderViews.length; index++) {
    const renderView = renderViews[index];
    const renderPass = device.beginRenderPass({
      clearColor: index === 0 ? [0.006, 0.014, 0.04, 1] : false,
      clearDepth: index === 0 ? 1 : false,
      clearStencil: index === 0 ? 0 : false
    });
    const eyeViewport = [
      index * bufferEyeWidth,
      0,
      index === 0 ? bufferEyeWidth : bufferWidth - bufferEyeWidth,
      bufferHeight
    ];
    renderPass.setParameters({viewport: eyeViewport, scissorRect: eyeViewport});
    renderTangram({frame: hostFrame, renderPass, renderViewId: renderView.id});
    renderPass.end();
  }
}

function renderXRFrame(time, xrFrame) {
  const frameState = webXRManager.getFrameState(xrFrame);
  if (!frameState || frameState.views.length === 0) {
    return;
  }
  const elapsedSeconds =
    lastXRFrameTime === null ? 0 : clamp((time - lastXRFrameTime) / 1000, 0, 0.1);
  lastXRFrameTime = time;
  for (const intent of webXRInputAdapter.update(
    webXRManager.getInputState(xrFrame) || [],
    elapsedSeconds
  )) {
    viewManager.dispatchInteractionIntent(intent);
  }
  const placementMatrix = createPlacementMatrix({immersive: true, time});
  const clearedFramebuffers = new Set();
  const renderViews = viewManager.makeXRRenderViews({frameState, placementMatrix});
  const fullViewport = renderViews.reduce(
    (viewport, view) => ({
      x: 0,
      y: 0,
      width: Math.max(viewport.width, view.viewport.x + view.viewport.width),
      height: Math.max(viewport.height, view.viewport.y + view.viewport.height)
    }),
    {x: 0, y: 0, width: 1, height: 1}
  );
  const hostFrame = createHostFrame({
    viewport: fullViewport,
    renderViews,
    activeRenderViewId: renderViews[0].id
  });

  for (let index = 0; index < frameState.views.length; index++) {
    const view = frameState.views[index];
    const renderView = renderViews[index];
    const framebuffer = view.framebuffer || frameState.framebuffer;
    const shouldClear = !clearedFramebuffers.has(framebuffer);
    clearedFramebuffers.add(framebuffer);
    const renderPass = device.beginRenderPass({
      framebuffer,
      clearColor: shouldClear ? [0.006, 0.014, 0.04, 1] : false,
      clearDepth: shouldClear ? 1 : false,
      clearStencil: false
    });
    renderPass.setParameters({viewport: view.viewport});
    renderTangram({
      frame: hostFrame,
      renderPass,
      renderViewId: renderView.id
    });
    renderPass.end();
  }
}

async function setXRSession(session) {
  xrReferenceSpaceType = await setWebXRSessionWithFallback(webXRManager, session);
}

async function enterVR() {
  if (xrSession) {
    return;
  }
  if (
    !navigator.xr ||
    !immersiveVRSupported ||
    (device.type === 'webgpu' && (!device.props.xrCompatible || !('XRGPUBinding' in window)))
  ) {
    enterStereoPreview();
    return;
  }
  enterButton.disabled = true;
  setStatus('Requesting an immersive VR session…');
  const sessionInit =
    device.type === 'webgpu'
      ? {requiredFeatures: ['webgpu'], optionalFeatures: ['local-floor']}
      : {optionalFeatures: ['local-floor']};
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-vr', sessionInit);
  } catch (error) {
    if (error?.name === 'NotSupportedError') {
      enterStereoPreview();
      return;
    }
    throw error;
  }
  try {
    await setXRSession(session);
    stereoPreview = false;
    viewManager.setMode('immersive-vr');
    container.classList.remove('is-stereo');
    xrSession = session;
    lastXRFrameTime = null;
    session.addEventListener('end', clearXRSession, {once: true});
    animationLoop.setProps({
      animationFrameProvider: new WebXRAnimationFrameProvider(session)
    });
    enterButton.hidden = true;
    exitButton.hidden = false;
    updatePresentationButtons('immersive-vr');
    setStatus(`Rendering stereoscopic Tangram ${viewMode.label} through ${device.type}.`, 'success');
  } catch (error) {
    await session.end().catch(() => {});
    enterButton.disabled = false;
    throw error;
  }
}

function enterStereoPreview() {
  stereoPreview = true;
  viewManager.setMode('stereo-preview');
  container.classList.add('is-stereo');
  enterButton.disabled = false;
  updatePresentationButtons('stereo-preview');
  setStatus(
    `Rendering split-screen Tangram ${viewMode.label} with distinct left- and right-eye cameras.`,
    'success'
  );
}

async function exitVR() {
  if (xrSession) {
    await xrSession.end().catch(() => {});
  }
  clearXRSession();
}

function clearXRSession() {
  xrSession = null;
  lastXRFrameTime = null;
  stereoPreview = false;
  viewManager.setMode('mono');
  xrReferenceSpaceType = 'local-floor';
  container.classList.remove('is-stereo');
  webXRManager?.clearSession();
  webXRInputAdapter.reset();
  if (!destroyed) {
    animationLoop.setProps({animationFrameProvider: undefined});
    enterButton.hidden = false;
    enterButton.disabled = false;
    exitButton.hidden = true;
    updatePresentationButtons('mono');
    setStatus(`VR session ended. The desktop ${viewMode.label} preview remains active.`, 'success');
  }
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

async function initialize() {
  setStatus(`Creating the luma.gl ${requestedDeviceType} device…`);
  const adapters = requestedDeviceType === 'webgpu' ? [webgpuAdapter] : [webgl2Adapter];
  device = await luma.createDevice({
    type: requestedDeviceType,
    adapters,
    createCanvasContext: {canvas},
    xrCompatible: requestedDeviceType === 'webgpu',
    webgl: {alpha: false, antialias: true, depth: true, stencil: true}
  });
  webXRManager = new WebXRManager(device);
  const rendererOptions = {
    device,
    canvas,
    continuousZoom: true,
    highDensityDisplay: true,
    logLevel: 'warn',
    requestRedraw: () => animationLoop?.setNeedsRedraw('Tangram scene update')
  };
  if (device.type === 'webgl') {
    rendererOptions.webGLContext = device.handle;
    rendererOptions.webGLContextScope = (callback) => {
      device.pushState();
      try {
        return callback();
      } finally {
        device.popState();
      }
    };
  }
  renderer = ClassicWebGLRenderer.create(scene, rendererOptions);
  renderer.subscribe({
    error: (message) => setStatus(message?.message || String(message), 'error')
  });
  await renderer.load(scene, {blocking: false});

  animationLoop = new AnimationLoop({
    device,
    autoResizeViewport: false,
    onRender: ({animationFrame, time}) => {
      if (xrSession && animationFrame) {
        renderXRFrame(time, animationFrame);
      } else if (stereoPreview) {
        renderStereoPreview(time);
      } else {
        renderPreview(time);
      }
    },
    onError: (error) => setStatus(error.message, 'error')
  });
  const controllerTimeline = animationLoop.attachTimeline(new Timeline());
  viewManager.attachController({
    element: canvas,
    timeline: controllerTimeline,
    onViewStateChange: () => animationLoop.setNeedsRedraw('deck.gl controller update')
  });
  await animationLoop.start();
  updatePresentationButtons('mono');

  if (query.get('stereo') === '1') {
    enterStereoPreview();
  }

  if (stereoPreview) {
    return;
  }

  if (!navigator.xr) {
    enterButton.disabled = false;
    setStatus(
      `Desktop ${viewMode.label} preview ready. Enter VR opens the split-screen stereo preview.`,
      'warning'
    );
    return;
  }
  immersiveVRSupported = await navigator.xr
    .isSessionSupported('immersive-vr')
    .catch(() => false);
  enterButton.disabled = false;
  setStatus(
    immersiveVRSupported
      ? `Desktop ${viewMode.label} preview ready on ${device.type}. Enter VR for stereoscopic rendering.`
      : `Desktop ${viewMode.label} preview ready. Enter VR opens split-screen stereo; enable the emulator for an immersive session.`,
    immersiveVRSupported ? 'success' : 'warning'
  );
}

async function enableThorGestures() {
  if (!thorButton || thorController) return;
  thorButton.disabled = true;
  setStatus('Loading Thor and requesting webcam access…');
  try {
    const {startThorGestures} = await import('./thor-adapter.js');
    thorController = await startThorGestures({
      presentation: viewManager,
      canvas,
      onIntent: (intent) => {
        if (intent.type === 'signal') {
          setStatus(`Thor signal: ${intent.action}`, 'success');
        }
      }
    });
    thorButton.textContent = 'Thor gestures enabled';
    setStatus(
      'Webcam gestures control the shared logical view in mono and stereo preview.',
      'success'
    );
  } catch (error) {
    thorButton.disabled = false;
    setStatus(error.message, 'error');
  }
}

function destroy() {
  if (destroyed) {
    return;
  }
  destroyed = true;
  void exitVR();
  animationLoop?.stop();
  thorController?.stop();
  viewManager.finalize();
  renderer?.destroy();
  webXRManager?.destroy();
  device?.destroy();
}

enterButton.addEventListener('click', () => {
  enterVR().catch((error) => {
    enterButton.disabled = false;
    setStatus(error.message, 'error');
  });
});
monoButton.addEventListener('click', () => {
  if (xrSession) {
    void exitVR();
  } else {
    stereoPreview = false;
    viewManager.setMode('mono');
    container.classList.remove('is-stereo');
    updatePresentationButtons('mono');
    setStatus(`Interactive mono ${viewMode.label} preview.`, 'success');
  }
});
stereoButton.addEventListener('click', () => {
  if (xrSession) {
    void xrSession.end().then(enterStereoPreview);
  } else {
    enterStereoPreview();
  }
});
thorButton?.addEventListener('click', () => void enableThorGestures());
exitButton.addEventListener('click', () => void exitVR());
canvas.addEventListener('pointerdown', () => canvas.focus({preventScroll: true}));
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
window.tangramWebXRExampleDestroy = destroy;
window.addEventListener('pagehide', destroy, {once: true});

initialize().catch((error) => setStatus(error.message, 'error'));

function createTronScene({portable}) {
  return {
    import: ['https://www.nextzen.org/carto/tron-style/6/tron-style.zip'],
    global: {
      sdk_api_key: '',
      sdk_animated: true,
      sdk_building_extrude: true
    },
    scene: {
      animated: true,
      background: {color: '#030817'}
    },
    styles: {
      'tron-portable-traffic': {
        base: 'lines',
        animated: true,
        texcoords: true
      }
    },
    lights: {
      ambient: {
        type: 'ambient',
        ambient: 0.55
      },
      sunlight: {
        type: 'directional',
        direction: [0.5, -0.8, -0.6],
        diffuse: 0.8
      }
    },
    sources: {
      mapzen: {
        type: 'MVT',
        url: 'https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt',
        url_params: null,
        rasters: [],
        tile_size: 512,
        max_zoom: 14
      }
    },
    layers: {
      // Imported Tilezen rules must not merge into the CARTO rules below.
      landuse: {data: {source: 'mapzen', layer: '__disabled__'}},
      water: {data: {source: 'mapzen', layer: '__disabled__'}},
      roads: {data: {source: 'mapzen', layer: '__disabled__'}},
      buildings: {data: {source: 'mapzen', layer: '__disabled__'}},
      transit: {data: {source: 'mapzen', layer: '__disabled__'}},
      'xr-landcover': {
        data: {source: 'mapzen', layer: 'landcover'},
        draw: {polygons: {order: 1, color: '#101d31'}}
      },
      'xr-landuse': {
        data: {source: 'mapzen', layer: 'landuse'},
        draw: {polygons: {order: 2, color: '#1b2946'}}
      },
      'xr-water': {
        data: {source: 'mapzen', layer: 'water'},
        draw: {polygons: {order: 3, color: '#102b4c'}}
      },
      'xr-buildings': {
        data: {source: 'mapzen', layer: 'building'},
        filter: {$zoom: {min: 14}},
        draw: {
          polygons: {order: 4, color: '#142b4b', extrude: buildingExtrusion},
          lines: {order: 5, color: '#267f9e', width: '0.5px', extrude: buildingExtrusion}
        }
      },
      'xr-roads': {
        data: {source: 'mapzen', layer: 'transportation'},
        draw: {
          lines: {
            order: 5,
            color: '#10223d',
            outline: {color: '#169fbd', width: '0.4px'},
            width: [[4, '0.25px'], [9, '0.5px'], [14, '1px'], [18, '3px']]
          }
        },
        major: {
          filter: {class: ['primary', 'secondary']},
          draw: {
            lines: {
              order: 6,
              color: '#15142f',
              outline: {color: '#8d50ff', width: '0.5px'},
              width: [[4, '0.5px'], [9, '1px'], [14, '2px'], [18, '5px']]
            }
          }
        },
        trunk: {
          filter: {class: 'trunk', $zoom: {min: 10}},
          draw: {
            traffic: {
              style: portable ? 'tron-portable-traffic' : 'fast-traffic-animation-twoways',
              order: 7,
              color: '#10223d',
              width: [[10, '0.5px'], [13, '3px'], [18, '10px']],
              outline: {color: '#4ee5e1', width: '0.5px'}
            }
          }
        },
        highway: {
          filter: {class: 'motorway', $zoom: {min: 10}},
          draw: {
            traffic: {
              style: portable ? 'tron-portable-traffic' : 'fast-traffic-animation-twoways',
              order: 8,
              color: '#15142f',
              width: [[10, '0.4px'], [13, '2.5px'], [18, '8px']],
              outline: {color: '#bd5be0', width: '0.55px'}
            }
          }
        }
      }
    }
  };
}

// Tangram serializes style functions into workers, where `feature` is supplied
// by the scene evaluator. CARTO/OpenMapTiles names its heights differently.
function buildingExtrusion() {
  return [
    feature.render_min_height || feature.min_height || 0,
    feature.render_height || feature.height || 10
  ];
}
