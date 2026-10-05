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

let classicPlaygroundMountId = 0;

export default function ClassicPlayground() {
  const classicBaseUrl = useBaseUrl('/examples/classic/');
  const styleSchemaUrl = useBaseUrl('/modules/tangram-renderer/dist/tangram-style.schema.json');
  const [errorMessage, setErrorMessage] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const frameElement = useRef(null);
  const scriptElements = useRef([]);
  const stylesheetElements = useRef([]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === frameElement.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.tangramClassicCancelled = false;
    document.body.classList.add('tangram-classic-embedded');
    stylesheetElements.current = [
      appendStylesheet(`${classicBaseUrl}css/main.css`),
      appendStylesheet(`${classicBaseUrl}app/settings-panel.css`),
      appendStylesheet('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.2.0/leaflet.css'),
      appendStylesheet(
        'https://cdnjs.cloudflare.com/ajax/libs/leaflet-geocoder-mapzen/1.9.4/leaflet-geocoder-mapzen.css'
      )
    ];
    window.tangramClassicEmbedded = true;
    window.tangramClassicBaseUrl = classicBaseUrl;
    window.tangramStyleSchemaUrl = styleSchemaUrl;

    const mountId = ++classicPlaygroundMountId;
    const scripts = [
      [`https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.2.0/leaflet.js`, 'text/javascript'],
      [
        `https://cdnjs.cloudflare.com/ajax/libs/leaflet-geocoder-mapzen/1.9.4/leaflet-geocoder-mapzen.js`,
        'text/javascript'
      ],
      [`${classicBaseUrl}lib/FileSaver.js`, 'text/javascript'],
      [`${classicBaseUrl}lib/keymaster.js`, 'text/javascript'],
      [`${classicBaseUrl}main.js?embedded=1&mount=${mountId}`, 'module'],
      [`${classicBaseUrl}app/settings-panel.js?embedded=1&mount=${mountId}`, 'module']
    ];

    (async () => {
      try {
        for (const [url, type] of scripts) {
          const scriptElement = await appendScript(url, type);
          scriptElements.current.push(scriptElement);
          if (cancelled) {
            scriptElement.remove();
            return;
          }
        }
      } catch (error) {
        if (!cancelled) {
          setErrorMessage(error.message);
        }
      }
    })();

    return () => {
      cancelled = true;
      window.tangramClassicCancelled = true;
      window.tangramClassicSettingsCleanup?.();
      window.tangramClassicDestroy?.();
      stylesheetElements.current.forEach((linkElement) => {
        linkElement.remove();
      });
      scriptElements.current.forEach((scriptElement) => {
        scriptElement.remove();
      });
      stylesheetElements.current = [];
      scriptElements.current = [];
      document.body.classList.remove('tangram-classic-embedded');
      delete window.tangramClassicEmbedded;
      delete window.tangramClassicBaseUrl;
      delete window.tangramClassicCancelled;
      delete window.tangramClassicDestroy;
      delete window.tangramClassicSettingsCleanup;
      delete window.tangramStyleSchemaUrl;
    };
  }, [classicBaseUrl, styleSchemaUrl]);

  return (
    <div className="classic-playground-embed">
      <div id="classic-playground-frame" ref={frameElement}>
        <div id="map" />
        <button
          className={isFullscreen ? 'canvas-fullscreen is-active' : 'canvas-fullscreen'}
          type="button"
          aria-label={isFullscreen ? 'Exit fullscreen example' : 'Open fullscreen example'}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={() => {
            if (isFullscreen) {
              document.exitFullscreen();
            } else {
              frameElement.current?.requestFullscreen();
            }
          }}
        >
          ⛶
        </button>
      </div>
      {errorMessage ? <p className="alert alert--danger">{errorMessage}</p> : null}
    </div>
  );
}
