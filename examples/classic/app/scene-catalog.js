// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Default playground scene: the original animated TRON style on live vector tiles. */
export const DEFAULT_SCENE = 'styles/tron.yaml';

/** Shared style choices for the community panel and historical GUI. */
export const SCENE_OPTIONS = [
  {label: 'TRON (OpenFreeMap)', value: DEFAULT_SCENE},
  {label: 'Crosshatch (OpenFreeMap)', value: 'styles/crosshatch.yaml'},
  {label: 'Simple', value: 'styles/simple.yaml'},
  {label: 'Bubble Wrap', value: 'styles/bubble-wrap.yaml'},
  {label: 'Walkabout', value: 'styles/walkabout.yaml'},
  {label: 'Refill', value: 'styles/refill.yaml'},
  {label: 'Refill Blue Terrain', value: 'styles/refill-blue-terrain.yaml'},
  {label: 'Rainbow Buildings', value: 'styles/rainbow-buildings.yaml'},
  {label: 'Pop-up Buildings', value: 'styles/popup-buildings.yaml'},
  {label: 'Albers projection morph', value: 'styles/projection-morph.yaml'},
  {label: 'Light raster basemap', value: 'styles/open-light-raster.yaml'},
  {label: 'Street map raster', value: 'styles/open-streets-raster.yaml'},
  {label: 'Local streets (preview)', value: 'styles/local-basemap.yaml'},
  {label: 'TRON (local preview)', value: 'styles/local-tron.yaml'},
  {label: 'Crosshatch (local preview)', value: 'styles/crosshatch-preview.yaml'}
];

/** Return a scene-specific [zoom, latitude, longitude] overview, if it needs one. */
export function getSceneOverview(scene) {
  if (typeof scene !== 'string') return null;
  const pathname = new URL(scene, 'https://example.invalid/').pathname;
  return pathname.endsWith('/styles/projection-morph.yaml') ? [4, 39, -96] : null;
}

/** Get the optional raster context only for the three small local-data previews. */
export function getPreviewBasemapUrl(scene) {
  if (typeof scene !== 'string') {
    return null;
  }
  const pathname = new URL(scene, 'https://example.invalid/').pathname;
  if (pathname.endsWith('/styles/local-tron.yaml')) {
    return 'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';
  }
  if (pathname.endsWith('/styles/local-basemap.yaml') || pathname.endsWith('/styles/crosshatch-preview.yaml')) {
    return 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
  }
  return null;
}
