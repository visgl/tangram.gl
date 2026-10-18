// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {StyleSpecification} from 'maplibre-gl';
import {BLUE_MARBLE_URL, BLUE_MARBLE_ATTRIBUTION} from '../classic/app/nasa-basemap.js';
import {createVectorSource} from '../classic/app/vector-providers.js';

/** Geographic camera state shared by the two independently owned renderers. */
export interface ComparisonCamera {
  /** Geographic center in degrees. */
  longitude: number;
  /** Geographic center in degrees. */
  latitude: number;
  /** Renderer-independent map zoom, not an individual stereo eye's zoom. */
  zoom: number;
  /** Clockwise heading in degrees. */
  bearing?: number;
  /** Camera tilt in degrees. */
  pitch?: number;
}

/** Return a reason rather than offering an unrelated reference for unsupported examples. */
export function getComparisonLimitation(viewMode: string, basemapId: string): string | null {
  if (!['mapFlat', 'mapPerspective', 'globe'].includes(viewMode)) return 'MapLibre comparison requires a MapView or GlobeView.';
  if (!['streetsVector', 'blueMarbleRaster', 'tron'].includes(basemapId)) return 'The original Nextzen shader style has no MapLibre reference.';
  return null;
}

/** Use the common camera domain and keep the flat example flat on either side. */
export function normalizeComparisonCamera(camera: ComparisonCamera, viewMode: string): ComparisonCamera {
  return {longitude: camera.longitude, latitude: Math.max(-85.0511287798, Math.min(85.0511287798, camera.latitude)),
    zoom: Math.max(0, Math.min(20, camera.zoom)), bearing: camera.bearing ?? 0,
    pitch: viewMode === 'mapFlat' || viewMode === 'globe' ? 0 : Math.max(0, Math.min(50, camera.pitch ?? 0))};
}

/** Build a static reference from the same imagery or vector provider, not a Tangram shader translation. */
export function createComparisonStyle(basemapId: string, viewMode: string, provider = 'openfreemap'): StyleSpecification {
  if (getComparisonLimitation(viewMode, basemapId)) throw new Error('Unsupported MapLibre comparison');
  const projection = {type: viewMode === 'globe' ? 'globe' : 'mercator'} as const;
  if (basemapId === 'blueMarbleRaster') return {version: 8, projection, sources: {basemap: {
    type: 'raster', tiles: [BLUE_MARBLE_URL], tileSize: 256, maxzoom: 8, attribution: BLUE_MARBLE_ATTRIBUTION
  }}, layers: [{id: 'imagery', type: 'raster', source: 'basemap', paint: {'raster-fade-duration': 0}}]};
  const source = createVectorSource(provider), tron = basemapId === 'tron';
  return {version: 8, projection, sources: {basemap: {type: 'vector', maxzoom: source.max_zoom, attribution: source.attribution,
    ...(source.tilejson ? {url: source.tilejson} : {tiles: [source.url]})}}, layers: [
    {id: 'background', type: 'background', paint: {'background-color': tron ? '#071b33' : '#f5f3ef'}},
    {id: 'landcover', type: 'fill', source: 'basemap', 'source-layer': 'landcover', paint: {'fill-color': tron ? '#0a2540' : '#e8eee5'}},
    {id: 'landuse', type: 'fill', source: 'basemap', 'source-layer': 'landuse', paint: {'fill-color': tron ? '#11263e' : '#eeeae2'}},
    {id: 'park', type: 'fill', source: 'basemap', 'source-layer': 'park', paint: {'fill-color': tron ? '#113b43' : '#cfe5c8'}},
    {id: 'water', type: 'fill', source: 'basemap', 'source-layer': 'water', paint: {'fill-color': tron ? '#06172d' : '#a9d4e8'}},
    {id: 'roads', type: 'line', source: 'basemap', 'source-layer': 'transportation', paint: {
      'line-color': tron ? '#21d9ed' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 15, 3, 20, 18]}},
    {id: 'buildings', type: 'fill-extrusion', source: 'basemap', 'source-layer': 'building', minzoom: 13, paint: {
      'fill-extrusion-color': tron ? '#8b54c6' : '#d6d0c8',
      'fill-extrusion-height': ['coalesce', ['to-number', ['get', 'render_height']], ['to-number', ['get', 'height']], 10]}}
  ]};
}
