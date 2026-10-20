// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {StyleSpecification, ExpressionSpecification} from 'maplibre-gl';
import {BLUE_MARBLE_URL, BLUE_MARBLE_ATTRIBUTION} from '../classic/app/nasa-basemap.js';
import {createVectorSource} from '../classic/app/vector-providers.js';
import {STREETS_COLORS, STREETS_BUILDING_MIN_ZOOM, STREETS_MAJOR_ROAD_CLASSES, createStreetsRoadWidths} from './streets-cartography';

/** Preserve Streets' flat buildings and road hierarchy without translating Tangram shaders. */
function createStreetsLayers(): StyleSpecification['layers'] {
  const majorFilter: ExpressionSpecification = ['in', ['get', 'class'], ['literal', [...STREETS_MAJOR_ROAD_CLASSES]]];
  const width = (major: boolean, outline: boolean): ExpressionSpecification => {
    const expression: ExpressionSpecification = ['interpolate', ['linear'], ['zoom']];
    for (const [zoom, pixels] of createStreetsRoadWidths(major)) {
      // Tangram outlines extend by the configured width on each side.
      expression.push(zoom - 1, Number.parseFloat(pixels) + (outline ? 2 : 0));
    }
    return expression;
  };
  const roads: StyleSpecification['layers'] = [];
  for (const major of [false, true]) {
    for (const outline of [true, false]) {
      roads.push({id: `${major ? 'major-roads' : 'roads'}${outline ? '-outline' : ''}`, type: 'line',
        source: 'basemap', 'source-layer': 'transportation',
        filter: major ? majorFilter : ['!', majorFilter],
        paint: {'line-color': major ? (outline ? STREETS_COLORS.majorRoadOutline : STREETS_COLORS.majorRoad)
          : (outline ? STREETS_COLORS.roadOutline : STREETS_COLORS.road), 'line-width': width(major, outline)}});
    }
  }
  return [
    {id: 'background', type: 'background', paint: {'background-color': STREETS_COLORS.background}},
    ...(['landcover', 'landuse', 'park', 'water'] as const).map(layer => ({
      id: layer, type: 'fill' as const, source: 'basemap', 'source-layer': layer, paint: {'fill-color': STREETS_COLORS[layer]}
    })),
    {id: 'waterways', type: 'line', source: 'basemap', 'source-layer': 'waterway',
      paint: {'line-color': STREETS_COLORS.waterway, 'line-width': 1}},
    {id: 'buildings', type: 'fill', source: 'basemap', 'source-layer': 'building',
      minzoom: STREETS_BUILDING_MIN_ZOOM - 1, paint: {'fill-color': STREETS_COLORS.building}},
    ...roads
  ];
}

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

/** Convert each height candidate separately, without accepting null, booleans or non-finite values. */
function coerceBuildingHeight(field: string, fallback: number | ExpressionSpecification): ExpressionSpecification {
  const raw = `raw_${field}`, parsed = `parsed_${field}`;
  return ['let', raw, ['get', field], ['let', parsed, ['case',
    ['all', ['in', ['typeof', ['var', raw]], ['literal', ['number', 'string']]], ['!=', ['var', raw], '']],
    ['to-number', ['var', raw], fallback], fallback],
  ['case', ['all', ['>=', ['var', parsed], -Number.MAX_VALUE], ['<=', ['var', parsed], Number.MAX_VALUE]],
    ['var', parsed], fallback]]];
}

/** Build a static reference from the same imagery or vector provider, not a Tangram shader translation. */
export function createComparisonStyle(basemapId: string, viewMode: string, provider = 'openfreemap'): StyleSpecification {
  if (getComparisonLimitation(viewMode, basemapId)) throw new Error('Unsupported MapLibre comparison');
  // MapLibre's `globe` preset morphs to Mercator at zoom 11–12. deck's
  // GlobeView stays spherical, so compare the same camera model at every zoom.
  const projection = {type: viewMode === 'globe' ? 'vertical-perspective' : 'mercator'} as const;
  if (basemapId === 'blueMarbleRaster') return {version: 8, projection, sources: {basemap: {
    type: 'raster', tiles: [BLUE_MARBLE_URL], tileSize: 256, maxzoom: 8, attribution: BLUE_MARBLE_ATTRIBUTION
  }}, layers: [{id: 'imagery', type: 'raster', source: 'basemap', paint: {'raster-fade-duration': 0}}]};
  const source = createVectorSource(provider), tron = basemapId === 'tron';
  return {version: 8, projection, sources: {basemap: {type: 'vector', maxzoom: source.max_zoom, attribution: source.attribution,
    ...(source.tilejson ? {url: source.tilejson} : {tiles: [source.url]})}}, layers: !tron ? createStreetsLayers() : [
    {id: 'background', type: 'background', paint: {'background-color': tron ? '#071b33' : '#f5f3ef'}},
    {id: 'landcover', type: 'fill', source: 'basemap', 'source-layer': 'landcover', paint: {'fill-color': tron ? '#0a2540' : '#e8eee5'}},
    {id: 'landuse', type: 'fill', source: 'basemap', 'source-layer': 'landuse', paint: {'fill-color': tron ? '#11263e' : '#eeeae2'}},
    {id: 'park', type: 'fill', source: 'basemap', 'source-layer': 'park', paint: {'fill-color': tron ? '#113b43' : '#cfe5c8'}},
    {id: 'water', type: 'fill', source: 'basemap', 'source-layer': 'water', paint: {'fill-color': tron ? '#06172d' : '#a9d4e8'}},
    {id: 'roads', type: 'line', source: 'basemap', 'source-layer': 'transportation', paint: {
      'line-color': tron ? '#21d9ed' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.5, 15, 3, 20, 18]}},
    {id: 'buildings', type: 'fill-extrusion', source: 'basemap', 'source-layer': 'building', minzoom: 13, paint: {
      'fill-extrusion-color': tron ? '#8b54c6' : '#d6d0c8',
      'fill-extrusion-height': coerceBuildingHeight('render_height', coerceBuildingHeight('height', 20)),
      'fill-extrusion-base': coerceBuildingHeight('render_min_height', coerceBuildingHeight('min_height', 0))}}
  ]};
}
