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

let heroMountId = 0;

/** Mounts the vector-backed, animated TRON deck example behind the homepage hero. */
export default function TronHeroBackground() {
  const deckExampleBaseUrl = useBaseUrl('/examples/deck/');
  const backgroundElement = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const mountId = `hero-${++heroMountId}`;
    if (!backgroundElement.current) {
      return undefined;
    }

    const stylesheetElements = [appendStylesheet(`${deckExampleBaseUrl}main.css`)];
    document.body.classList.add('tangram-deck-embedded');
    window.tangramExampleBaseUrl = new URL(deckExampleBaseUrl, window.location.origin).href;
    window.tangramExampleViewMode = 'mapPerspective';
    window.tangramExampleBasemapId = 'tron';
    window.tangramExampleShowOverlays = false;
    window.tangramDeckExampleMountId = mountId;

    import(/* webpackChunkName: "deck-example" */ '@vis.gl/tangram-deck-example/app-runtime')
      .then(({initializeDeckExample}) => {
        if (!cancelled && window.tangramDeckExampleMountId === mountId) {
          initializeDeckExample({embeddedViewMode: 'mapPerspective', basemapId: 'tron', showOverlays: false});
        }
      })
      .catch(error => {
        if (!cancelled) console.warn(error);
      });

    return () => {
      cancelled = true;
      if (window.tangramDeckExampleMountId === mountId) {
        window.tangramDeckExampleDestroy?.();
      }
      stylesheetElements.forEach((linkElement) => {
        linkElement.remove();
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
  }, [deckExampleBaseUrl]);

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
            <span id="tron-source-link" />
          </div>
        </div>
      </div>
      <p id="attribution" className="tangram-home-attribution">
        &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>
        {' | '}<a href="https://www.openmaptiles.org/">© OpenMapTiles</a>
        {' | '}<a href="https://openfreemap.org">OpenFreeMap</a>
      </p>
    </>
  );
}
