// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {useEffect, useRef} from 'react';
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

let heroMountId = 0;

/** Mounts the vector-backed, animated TRON deck example behind the homepage hero. */
export default function TronHeroBackground() {
  const deckExampleBaseUrl = useBaseUrl('/examples/deck/');
  const tangramLayersUrl = useBaseUrl('/modules/tangram-layers/dist/index.js');
  const tangramRendererUrl = useBaseUrl('/modules/tangram-renderer/dist/index.js');
  const backgroundElement = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const mountId = `hero-${++heroMountId}`;
    if (!backgroundElement.current) {
      return undefined;
    }

    const stylesheetElements = [appendStylesheet(`${deckExampleBaseUrl}main.css`)];
    const scriptElements = [];
    document.body.classList.add('tangram-deck-embedded');
    window.tangramExampleBaseUrl = new URL(deckExampleBaseUrl, window.location.origin).href;
    window.tangramExampleViewMode = 'mapPerspective';
    window.tangramExampleBasemapId = 'tron';
    window.tangramExampleShowOverlays = false;
    window.tangramDeckExampleMountId = mountId;

    const importMapElement = document.createElement('script');
    importMapElement.type = 'importmap';
    importMapElement.textContent = JSON.stringify({
      imports: {
        '@deck.gl/core': 'https://esm.sh/deck.gl@9.4.0?bundle&external=@luma.gl/core',
        '@deck.gl/layers': 'https://esm.sh/deck.gl@9.4.0?bundle&external=@luma.gl/core',
        '@luma.gl/core': 'https://esm.sh/@luma.gl/core@9.4.0?bundle',
        '@vis.gl/tangram-layers': `${tangramLayersUrl}?homepage=1`,
        '@vis.gl/tangram-renderer': `${tangramRendererUrl}?homepage=1`
      }
    });
    document.head.appendChild(importMapElement);
    scriptElements.push(importMapElement);

    (async () => {
      try {
        const scriptElement = await appendScript(
          `${deckExampleBaseUrl}app.js?homepage=1&mount=${mountId}`,
          'module'
        );
        scriptElements.push(scriptElement);
        if (cancelled) {
          scriptElement.remove();
        }
      } catch (error) {
        if (!cancelled) {
          // The live visual is progressive enhancement; keep the hero usable
          // if a browser cannot initialize the requested GPU backend.
          console.warn(error);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (window.tangramDeckExampleMountId === mountId) {
        window.tangramDeckExampleDestroy?.();
      }
      stylesheetElements.forEach((linkElement) => {
        linkElement.remove();
      });
      scriptElements.forEach((scriptElement) => {
        scriptElement.remove();
      });
      document.body.classList.remove('tangram-deck-embedded');
      if (window.tangramDeckExampleMountId === mountId) {
        delete window.tangramExampleBaseUrl;
        delete window.tangramExampleViewMode;
        delete window.tangramExampleBasemapId;
        delete window.tangramExampleShowOverlays;
        delete window.tangramDeckExampleMountId;
        delete window.tangramDeckExampleDestroy;
      }
    };
  }, [deckExampleBaseUrl, tangramLayersUrl, tangramRendererUrl]);

  return (
    <>
      <div ref={backgroundElement} className="tangram-home-live-map" aria-hidden="true">
        <div id="deck-container">
          <div className="tangram-home-runtime-controls" hidden>
            <p id="status" />
            <select id="basemap-style" defaultValue="tron">
              <option value="tron">TRON 2.0</option>
            </select>
            <input id="basemap-visible" type="checkbox" defaultChecked />
            <form id="nextzen-key-form">
              <input id="nextzen-api-key" defaultValue="" />
            </form>
            <span id="carto-attribution" />
            <span id="nextzen-attribution" />
            <span id="tron-source-link" />
          </div>
        </div>
      </div>
      <p id="attribution" className="tangram-home-attribution">
        &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>
        <span id="carto-attribution-label"> &copy; Basemap data providers</span>
      </p>
    </>
  );
}
