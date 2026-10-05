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
  {label: 'Light vector basemap (OpenFreeMap)', value: 'styles/open-light-vector.yaml'},
  {label: 'Street vector basemap (OpenFreeMap)', value: 'styles/open-streets-vector.yaml'},
  {label: 'Local streets (preview)', value: 'styles/local-basemap.yaml'},
  {label: 'TRON (local preview)', value: 'styles/local-tron.yaml'},
  {label: 'Crosshatch (local preview)', value: 'styles/crosshatch-preview.yaml'}
];

/**
 * Preserve old raster-style links while selecting the canonical vector cards.
 * @type {Record<string, string>}
 */
export const SCENE_ALIASES = {
  'styles/open-light-raster.yaml': 'styles/open-light-vector.yaml',
  'styles/open-streets-raster.yaml': 'styles/open-streets-vector.yaml'
};

/**
 * Explain what each scene demonstrates, including live basemaps and bundled fixture overlays.
 * @type {Record<string, string>}
 */
export const SCENE_DESCRIPTIONS = {
  'styles/tron.yaml': 'Animated traffic, neon roads and buildings on live OpenFreeMap vector tiles.',
  'styles/crosshatch.yaml': 'Pen-and-ink hatching with extruded buildings on live OpenFreeMap tiles.',
  'styles/simple.yaml': 'A complete vector basemap with labels, points of interest and building shading.',
  'styles/bubble-wrap.yaml': 'A playful rounded basemap using the original hosted Bubble Wrap style.',
  'styles/walkabout.yaml': 'An outdoor map with terrain shading, paths and parks.',
  'styles/refill.yaml': 'A clean, labeled vector basemap using the original hosted Refill style.',
  'styles/refill-blue-terrain.yaml': 'Refill in blue with textured terrain shading and live vector tiles.',
  'styles/rainbow-buildings.yaml': 'Building colors cycle over time and vary with height. Best at street level.',
  'styles/popup-buildings.yaml': 'Buildings rise near the viewport center and flatten toward the edges.',
  'styles/projection-morph.yaml': 'US states morph between Albers and Mercator over a 12-second cycle. No remote tiles required.',
  'styles/open-light-vector.yaml': 'A softly colored vector basemap with live OpenFreeMap streets, buildings and labels.',
  'styles/open-streets-vector.yaml': 'A complete street map with live OpenFreeMap vector tiles, labels and landmarks.',
  'styles/local-basemap.yaml': 'Small bundled Manhattan GeoJSON features over a live OpenFreeMap light vector basemap.',
  'styles/local-tron.yaml': 'Bundled Manhattan neon features over the live animated TRON basemap from OpenFreeMap.',
  'styles/crosshatch-preview.yaml': 'Hatching on bundled Manhattan features over a live OpenFreeMap crosshatch basemap.'
};

/** Return a scene-specific [zoom, latitude, longitude] overview, if it needs one. */
export function getSceneOverview(scene) {
  if (typeof scene !== 'string') return null;
  const pathname = new URL(scene, 'https://example.invalid/').pathname;
  if (pathname.endsWith('/styles/projection-morph.yaml')) return [4, 39, -96];
  // These examples have finite geometry or street-level building effects.
  // Restore a useful view when selecting them from the national Albers overview.
  const streetScenes = ['local-basemap.yaml', 'local-tron.yaml', 'crosshatch-preview.yaml',
    'rainbow-buildings.yaml', 'popup-buildings.yaml'];
  return streetScenes.some(name => pathname.endsWith('/styles/' + name)) ? [16, 40.705, -74.009] : null;
}
