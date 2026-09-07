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

let deckExampleMountId = 0;

export default function DeckExample({
  viewMode = 'mapPerspective',
  title = 'MapView perspective',
  description = 'deck.gl owns the camera and supplies its matrices to the Tangram renderer.'
}) {
  const deckExampleBaseUrl = useBaseUrl('/examples/deck/');
  const tangramLayersUrl = useBaseUrl('/modules/tangram-layers/dist/index.js');
  const tangramRendererUrl = useBaseUrl('/modules/tangram-renderer/dist/index.js');
  const [errorMessage, setErrorMessage] = useState(null);
  const scriptElements = useRef([]);
  const stylesheetElement = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const mountId = String(++deckExampleMountId);
    document.body.classList.add('tangram-deck-embedded');
    window.tangramExampleBaseUrl = new URL(deckExampleBaseUrl, window.location.origin).href;
    window.tangramExampleViewMode = viewMode;
    window.tangramDeckExampleMountId = mountId;
    stylesheetElement.current = appendStylesheet(`${deckExampleBaseUrl}main.css`);

    const importMapElement = document.createElement('script');
    importMapElement.type = 'importmap';
    importMapElement.textContent = JSON.stringify({
      imports: {
        '@deck.gl/core': 'https://esm.sh/deck.gl@9.4.0?bundle&external=@luma.gl/core',
        '@deck.gl/layers': 'https://esm.sh/deck.gl@9.4.0?bundle&external=@luma.gl/core',
        '@luma.gl/core': 'https://esm.sh/@luma.gl/core@9.4.0?bundle',
        '@vis.gl/tangram-layers': `${tangramLayersUrl}?embedded=1`,
        '@vis.gl/tangram-renderer': `${tangramRendererUrl}?embedded=1`
      }
    });
    document.head.appendChild(importMapElement);
    scriptElements.current.push(importMapElement);

    appendScript(`${deckExampleBaseUrl}app.js?embedded=1&mount=${mountId}`, 'module')
      .then((scriptElement) => {
        scriptElements.current.push(scriptElement);
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
      if (window.tangramDeckExampleMountId === mountId) {
        window.tangramDeckExampleDestroy?.();
      }
      stylesheetElement.current?.remove();
      scriptElements.current.forEach((scriptElement) => {
        scriptElement.remove();
      });
      scriptElements.current = [];
      document.body.classList.remove('tangram-deck-embedded');
      if (window.tangramDeckExampleMountId === mountId) {
        delete window.tangramExampleBaseUrl;
        delete window.tangramExampleViewMode;
        delete window.tangramDeckExampleMountId;
        delete window.tangramDeckExampleDestroy;
      }
    };
  }, [deckExampleBaseUrl, tangramLayersUrl, tangramRendererUrl, viewMode]);

  return (
    <div className="deck-example-embed">
      <div id="deck-container">
        <aside id="controls">
          <h1>{title}</h1>
          <div className="info-tabs" role="tablist" aria-label="Example information">
            <button
              type="button"
              className="is-active"
              data-example-tab="controls"
              role="tab"
              aria-selected="true"
            >
              Controls
            </button>
            <button type="button" data-example-tab="about" role="tab" aria-selected="false">
              About
            </button>
          </div>
          <div data-example-tab-panel="controls">
            <p id="status" role="status" />
            <label className="control">
              <span>Basemap</span>
              <select id="basemap-style" defaultValue="tron">
                <option value="streetsVector">Streets (vector)</option>
                <option value="positronRaster">Positron (raster)</option>
                <option value="tron">TRON 2.0 (vector, no key)</option>
                <option value="tronNextzen">Original TRON 2.0 on Nextzen</option>
              </select>
            </label>
            <label className="control checkbox-control">
              <input id="basemap-visible" type="checkbox" defaultChecked />
              Show TangramBasemapLayer
            </label>
            <form id="nextzen-key-form" hidden>
              <label className="control" htmlFor="nextzen-api-key">
                <span>Existing Nextzen API key</span>
              </label>
              <div className="key-input-row">
                <input
                  id="nextzen-api-key"
                  name="nextzen-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck="false"
                />
                <button type="submit">Load</button>
              </div>
              <p className="hint">Kept only in this browser tab; never written to source.</p>
            </form>
          </div>
          <div data-example-tab-panel="about" hidden>
            <p className="example-description">{description}</p>
            <p className="hint">Blue landmarks and the orange path are deck.gl layers.</p>
            <p className="source-link">
              <a
                href="https://github.com/visgl/tangram.gl/blob/master/examples/deck/app-runtime.js"
                target="_blank"
                rel="noopener noreferrer"
              >
                View TangramLayer demo source
              </a>
            </p>
            <p id="tron-source-link" className="source-link" hidden>
              Style source: <a href="https://github.com/tangrams/tron-style">tangrams/tron-style</a>
            </p>
          </div>
        </aside>
        <div className="canvas-toolbar">
          <div className="canvas-device-tabs" role="tablist" aria-label="Rendering device">
            <button type="button" data-device-type="webgpu" role="tab">
              WebGPU
            </button>
            <button type="button" data-device-type="webgl" role="tab">
              WebGL
            </button>
          </div>
          <button
            id="example-fullscreen"
            className="canvas-fullscreen"
            type="button"
            aria-label="Open fullscreen example"
            title="Fullscreen"
          >
            ⛶
          </button>
        </div>
        <p id="attribution">
          &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>
          <span id="carto-attribution"> &copy; Basemap data providers</span>
          <span id="nextzen-attribution" hidden>
            {' '}
            &copy; Nextzen
          </span>
        </p>
      </div>
      {errorMessage ? <p className="alert alert--danger">{errorMessage}</p> : null}
    </div>
  );
}
