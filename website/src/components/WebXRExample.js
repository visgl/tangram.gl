// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {useEffect, useState} from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';

function appendStylesheet(url) {
  const linkElement = document.createElement('link');
  linkElement.rel = 'stylesheet';
  linkElement.href = url;
  document.head.appendChild(linkElement);
  return linkElement;
}

const VIEW_LABELS = {
  globe: 'GlobeView',
  map: 'MapView',
  firstPerson: 'FirstPersonView',
  thor: 'Thor gestures'
};

export default function WebXRExample({viewMode = 'globe'}) {
  const exampleBaseUrl = useBaseUrl('/examples/webxr/');
  const [errorMessage, setErrorMessage] = useState(null);
  const viewLabel = VIEW_LABELS[viewMode] || VIEW_LABELS.globe;

  useEffect(() => {
    let cancelled = false;
    let destroyRuntime;
    document.body.classList.add('tangram-webxr-embedded');
    const stylesheetElement = appendStylesheet(`${exampleBaseUrl}main.css`);

    import(/* webpackChunkName: "webxr-example" */ '@vis.gl/tangram-webxr-example/app')
      .then(({initializeWebXRExample}) => {
        if (!cancelled) destroyRuntime = initializeWebXRExample({viewMode});
      })
      .catch(error => {
        if (!cancelled) setErrorMessage(error.message);
      });

    return () => {
      cancelled = true;
      destroyRuntime?.();
      stylesheetElement.remove();
      document.body.classList.remove('tangram-webxr-embedded');
    };
  }, [exampleBaseUrl, viewMode]);

  return (
    <div className="webxr-example-embed">
      <div id="webxr-container">
        <canvas id="webxr-canvas" tabIndex="0" aria-label="Interactive Tangram WebXR view" />
        <div className="webxr-device-tabs" role="tablist" aria-label="Rendering device">
          <button type="button" data-webxr-device="webgl" role="tab">
            WebGL 2
          </button>
          <button type="button" data-webxr-device="webgpu" role="tab">
            WebGPU
          </button>
        </div>
        <aside className="webxr-panel">
          <h1 id="webxr-title">WebXR {viewLabel}</h1>
          <p id="webxr-status" role="status">
            Preparing the renderer…
          </p>
          <p id="webxr-pick-status" role="status">
            Click a view to read the basemap surface. In VR, select with a controller.
            Squeeze to slide the map or rotate the globe; release to keep its placement.
          </p>
          <div className="webxr-actions">
            <button id="webxr-mono" type="button">
              Mono
            </button>
            <button id="webxr-stereo" type="button">
              Stereo Preview
            </button>
            <button id="webxr-enter" type="button">
              Enter VR
            </button>
            <button id="webxr-exit" type="button" hidden>
              Exit VR
            </button>
            {viewMode === 'thor' ? (
              <button id="webxr-thor-enable" type="button">
                Enable webcam gestures
              </button>
            ) : null}
          </div>
          <label>
            Basemap
            <select id="webxr-basemap" defaultValue="tron">
              <option value="tron">TRON (OpenFreeMap)</option>
              <option value="blueMarbleRaster">NASA Blue Marble</option>
            </select>
          </label>
          <label>
            Vector provider
            <select id="webxr-vector-provider" defaultValue="openfreemap">
              <option value="openfreemap">OpenFreeMap</option>
            </select>
          </label>
          <details id="webxr-stereo-settings" className="webxr-help">
            <summary>Stereo settings</summary>
          </details>
          <details className="webxr-help">
            <summary>Controls and VR setup</summary>
            <p className="webxr-hint">
              luma.gl supplies the XR session, per-eye framebuffers and camera matrices. Tangram keeps
              one shared scene and tile cache. Drag and scroll to explore; FirstPersonView also
              supports the deck.gl controller&apos;s arrow-key navigation.
            </p>
            {viewMode === 'thor' ? (
              <p className="webxr-hint">
                Thor uses webcam and MediaPipe gestures as desktop controls. It does not represent
                native headset hand tracking or WebXR controllers.
              </p>
            ) : null}
            <p className="webxr-hint">
              Stereo Preview is always available without platform XR support. Install the{' '}
              <a href="https://chromewebstore.google.com/detail/immersive-web-emulator/cgffilbpcibhmcfbgggfhfolhkfbhmik">
                Immersive Web Emulator
              </a>{' '}
              to exercise the real WebXR session path in desktop Chrome.
            </p>
          </details>
        </aside>
        <p id="attribution" className="webxr-attribution">
          &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>
          {' | '}<a href="https://www.openmaptiles.org/">© OpenMapTiles</a>
          {' | '}<a href="https://openfreemap.org">OpenFreeMap</a>
        </p>
      </div>
      {errorMessage ? <p className="alert alert--danger">{errorMessage}</p> : null}
    </div>
  );
}
