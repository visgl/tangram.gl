// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {getSceneOverview} from './scene-catalog.js';

const DEFAULT_VIEW = [16, 40.70531887544228, -74.00976419448853];

export function getViewFromUrl(hash = window.location.hash) {
  const values = hash.slice(1).split('/').slice(0, 3).map(Number.parseFloat);
  return values.length === 3 && values.every(Number.isFinite) ? values : null;
}

export function initializeUrlSync({map, layer, sceneUrl, location = window.location}) {
  const initialView = getViewFromUrl(location.hash) || getSceneOverview(sceneUrl) || DEFAULT_VIEW;
  let updateTimeout = null;

  function updateUrl() {
    window.clearTimeout(updateTimeout);
    updateTimeout = window.setTimeout(() => {
      const center = map.getCenter();
      location.hash = [map.getZoom(), center.lat, center.lng].join('/');
    }, 100);
  }

  function updateInitialView() {
    updateUrl();
    map.setView(initialView.slice(1, 3), initialView[0]);
  }

  map.on('move', updateUrl);
  map.setView(initialView.slice(1, 3), initialView[0]);
  layer.on('init', updateInitialView);

  return function destroyUrlSync() {
    window.clearTimeout(updateTimeout);
    map.off('move', updateUrl);
    layer.off('init', updateInitialView);
  };
}
