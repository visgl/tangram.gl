// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {useEffect, useRef, useState} from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';

function appendStylesheet(url) {
  const linkElement = document.createElement('link');
  linkElement.rel = 'stylesheet';
  linkElement.href = url;
  document.head.appendChild(linkElement);
  return linkElement;
}

function appendScript(url, type = 'text/javascript') {
  return new Promise((resolve, reject) => {
    const scriptElement = document.createElement('script');
    scriptElement.src = url;
    scriptElement.type = type;
    scriptElement.onload = () => resolve(scriptElement);
    scriptElement.onerror = () => reject(new Error(`Unable to load ${url}`));
    document.body.appendChild(scriptElement);
  });
}

const VIEW_LABELS = {
  globe: 'GlobeView',
  map: 'MapView',
  firstPerson: 'FirstPersonView',
  thor: 'Thor gestures'
};

let webXRExampleMountId = 0;

export default function WebXRExample({viewMode = 'globe'}) {
  const exampleBaseUrl = useBaseUrl('/examples/webxr/');
  const layersUrl = useBaseUrl('/modules/tangram-layers/dist/index.js');
  const webXRUrl = useBaseUrl('/modules/tangram-layers/dist/experimental/webxr.js');
  const rendererUrl = useBaseUrl('/modules/tangram-renderer/dist/index.js');
  const [errorMessage, setErrorMessage] = useState(null);
  const appendedElements = useRef([]);
  const viewLabel = VIEW_LABELS[viewMode] || VIEW_LABELS.globe;

  useEffect(() => {
    let cancelled = false;
    const mountId = String(++webXRExampleMountId);
    window.tangramWebXRViewMode = viewMode;
    document.body.classList.add('tangram-webxr-embedded');
    const stylesheetElement = appendStylesheet(`${exampleBaseUrl}main.css`);
    appendedElements.current.push(stylesheetElement);

    const importMapElement = document.createElement('script');
    importMapElement.type = 'importmap';
    importMapElement.textContent = JSON.stringify({
      imports: {
        '@deck.gl/core':
          'https://esm.sh/deck.gl@9.4.0?bundle&external=@luma.gl/core,@math.gl/core',
        '@luma.gl/core': 'https://esm.sh/@luma.gl/core@9.4.0?bundle',
        '@luma.gl/engine':
          'https://esm.sh/@luma.gl/engine@9.4.0?bundle&external=@luma.gl/core,@math.gl/core',
        '@luma.gl/experimental':
          'https://esm.sh/@luma.gl/experimental@9.4.0?bundle&external=@luma.gl/core,@math.gl/core',
        '@luma.gl/webgl':
          'https://esm.sh/@luma.gl/webgl@9.4.0?bundle&external=@luma.gl/core',
        '@luma.gl/webgpu':
          'https://esm.sh/@luma.gl/webgpu@9.4.0?bundle&external=@luma.gl/core',
        '@math.gl/core': 'https://esm.sh/@math.gl/core@4.1.0?bundle',
        '@mediapipe/tasks-vision':
          'https://esm.sh/@mediapipe/tasks-vision@0.10.22-rc.20250304?bundle',
        react: 'https://esm.sh/react@19.1.1?bundle',
        '@vis.gl/tangram-layers': `${layersUrl}?embedded=webxr`,
        '@vis.gl/tangram-layers/experimental/webxr': `${webXRUrl}?embedded=webxr`,
        '@vis.gl/tangram-renderer': `${rendererUrl}?embedded=webxr`,
        'mjolnir.js': 'https://esm.sh/mjolnir.js@3.1.1?bundle'
      }
    });
    document.head.appendChild(importMapElement);
    appendedElements.current.push(importMapElement);

    appendScript(
      `${exampleBaseUrl}app.js?embedded=1&view=${encodeURIComponent(viewMode)}&mount=${mountId}`,
      'module'
    )
      .then((scriptElement) => {
        appendedElements.current.push(scriptElement);
        if (cancelled) {
          scriptElement.remove();
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      });

    return () => {
      cancelled = true;
      window.tangramWebXRExampleDestroy?.();
      appendedElements.current.forEach((element) => {
        element.remove();
      });
      appendedElements.current = [];
      document.body.classList.remove('tangram-webxr-embedded');
      delete window.tangramWebXRExampleDestroy;
      delete window.tangramWebXRViewMode;
    };
  }, [exampleBaseUrl, layersUrl, rendererUrl, viewMode, webXRUrl]);

  return (
    <div className="webxr-example-embed">
      <div id="webxr-container">
        <canvas id="webxr-canvas" tabIndex="0" aria-label="Interactive Tangram WebXR view" />
        <canvas id="webxr-stereo-canvas" aria-label="Side-by-side stereoscopic preview" />
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
        </aside>
        <p className="webxr-attribution">
          &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>
        </p>
      </div>
      {errorMessage ? <p className="alert alert--danger">{errorMessage}</p> : null}
    </div>
  );
}
