// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {StyleSpecification, ExpressionSpecification} from 'maplibre-gl';
import {BLUE_MARBLE_URL, BLUE_MARBLE_ATTRIBUTION} from '../classic/app/nasa-basemap.js';
import {createVectorSource} from '../classic/app/vector-providers.js';
import {STREETS_COLORS, STREETS_BUILDING_MIN_ZOOM, STREETS_MAJOR_ROAD_CLASSES, STREETS_PLACE_LABELS, createStreetsRoadWidths} from './streets-cartography';

/** Public glyph service used by OpenFreeMap's own styles; no sprite dependency. */
export const COMPARISON_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

/** Native reference labels, independent of Tangram's fonts and placement pipeline. */
function createComparisonLabels(tron: boolean): StyleSpecification['layers'] {
  return [{id: 'place-labels', type: 'symbol', source: 'basemap', 'source-layer': 'place',
    layout: {
      'text-field': ['coalesce', ['get', 'name'], ['get', 'name:latin'], ['get', 'name_en'], ''],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 11, 14, 15, 15],
      'text-max-width': 8, 'text-padding': 3,
      'symbol-sort-key': ['to-number', ['coalesce', ['get', 'rank'], 999], 999],
      'text-allow-overlap': false, 'text-ignore-placement': false
    }, paint: {'text-color': tron ? '#70f4ff' : '#4b4b4b',
      'text-halo-color': tron ? '#08111f' : STREETS_COLORS.background, 'text-halo-width': 1.5}}];
}

/** Preserve Streets' flat buildings and road hierarchy without translating Tangram shaders. */
function createStreetsLayers(): StyleSpecification['layers'] {
  const majorFilter: ExpressionSpecification = ['in', ['get', 'class'], ['literal', [...STREETS_MAJOR_ROAD_CLASSES]]];
  const roadClass: ExpressionSpecification = ['match', ['get', 'class'],
    'path', 0, 'track', 1, 'service', 2, 'minor', 3, 'tertiary', 4, 'secondary', 5, 'primary', 6, 'trunk', 7, 'motorway', 8, 0];
  // Match Tangram's valid OpenMapTiles numeric layer domain. Preserve the
  // legacy callback's permissive parseInt behavior on the Tangram side.
  const roadGrade: ExpressionSpecification = ['let', 'roadLayer', coerceBuildingHeight('layer', 0),
    ['let', 'integerLayer', ['case', ['<', ['var', 'roadLayer'], 0], ['ceil', ['var', 'roadLayer']], ['floor', ['var', 'roadLayer']]],
      ['max', -5, ['min', 5, ['case', ['==', ['var', 'integerLayer'], 0],
        ['match', ['get', 'brunnel'], 'bridge', 1, 'tunnel', -1, 0], ['var', 'integerLayer']]]]]];
  const width = (outline: boolean): ExpressionSpecification => {
    const expression: ExpressionSpecification = ['interpolate', ['linear'], ['zoom']];
    const minorWidths = createStreetsRoadWidths(), majorWidths = createStreetsRoadWidths(true);
    for (const [index, [zoom, pixels]] of minorWidths.entries()) {
      // Tangram outlines extend by the configured width on each side.
      expression.push(zoom - 1, ['case', majorFilter,
        Number.parseFloat(majorWidths[index][1]) + (outline ? 2 : 0), Number.parseFloat(pixels) + (outline ? 2 : 0)]);
    }
    return expression;
  };
  const roads: StyleSpecification['layers'] = [];
  // Grade takes precedence over road class: a service bridge belongs above
  // a primary road. Keep casings and fills together at each physical grade.
  for (let grade = -5; grade <= 5; grade++) {
    for (const outline of [true, false]) {
      roads.push({id: `roads-grade-${grade}${outline ? '-outline' : ''}`, type: 'line',
        source: 'basemap', 'source-layer': 'transportation',
        filter: ['==', roadGrade, grade], layout: {'line-sort-key': roadClass},
        paint: {'line-color': ['case', majorFilter, outline ? STREETS_COLORS.majorRoadOutline : STREETS_COLORS.majorRoad,
          outline ? STREETS_COLORS.roadOutline : STREETS_COLORS.road], 'line-width': width(outline)}});
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

/**
 * Glyphs for the optional place names: CARTO's SDF ranges of Montserrat, the web font Tangram's
 * canvas text draws, with CARTO's fallback stack for scripts Montserrat lacks.
 */
export const CONFORMANCE_GLYPHS = 'https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf';
const COMPARISON_FONT_STACK = ['Montserrat Regular', 'Open Sans Regular', 'Noto Sans Regular',
  'HanWangHeiLight Regular', 'NanumBarunGothic Regular'];

/** Streets' place names as a MapLibre symbol layer. Tangram style zoom is MapLibre zoom + 1. */
function createStreetsPlaceLayer(): StyleSpecification['layers'][number] {
  const size: ExpressionSpecification = ['interpolate', ['linear'], ['zoom']];
  for (const [zoom, pixels] of STREETS_PLACE_LABELS.sizes) size.push(zoom - 1, pixels);
  return {id: 'places', type: 'symbol', source: 'basemap', 'source-layer': 'place',
    layout: {'text-field': ['get', 'name'], 'text-font': COMPARISON_FONT_STACK, 'text-size': size},
    paint: {'text-color': STREETS_PLACE_LABELS.fill, 'text-halo-color': STREETS_PLACE_LABELS.stroke,
      'text-halo-width': STREETS_PLACE_LABELS.strokeWidth / 2}};
}

/** Options of the comparison style. */
export interface ComparisonStyleOptions {
  /**
   * Use the pinned corpus's Streets label style for conformance scoring. By default the
   * example uses its native reference labels. Set false to omit reference labels.
   */
  labels?: boolean;
}

/** Build a static reference from the same imagery or vector provider, not a Tangram shader translation. */
export function createComparisonStyle(basemapId: string, viewMode: string, provider = 'openfreemap',
  {labels}: ComparisonStyleOptions = {}): StyleSpecification {
  if (getComparisonLimitation(viewMode, basemapId)) throw new Error('Unsupported MapLibre comparison');
  // MapLibre's `globe` preset morphs to Mercator at zoom 11–12. deck's
  // GlobeView stays spherical, so compare the same camera model at every zoom.
  const projection = {type: viewMode === 'globe' ? 'vertical-perspective' : 'mercator'} as const;
  if (basemapId === 'blueMarbleRaster') return {version: 8, projection, sources: {basemap: {
    type: 'raster', tiles: [BLUE_MARBLE_URL], tileSize: 256, maxzoom: 8, attribution: BLUE_MARBLE_ATTRIBUTION
  }}, layers: [{id: 'imagery', type: 'raster', source: 'basemap', paint: {'raster-fade-duration': 0}}]};
  const source = createVectorSource(provider), tron = basemapId === 'tron';
  const layers = !tron ? createStreetsLayers() : [
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
  ] satisfies StyleSpecification['layers'];
  const corpusLabels = labels === true && !tron;
  const labelLayers = corpusLabels ? [createStreetsPlaceLayer()] : labels === false ? [] : createComparisonLabels(tron);
  return {version: 8, projection, ...(labelLayers.length ? {glyphs: corpusLabels ? CONFORMANCE_GLYPHS : COMPARISON_GLYPHS} : {}),
    sources: {basemap: {type: 'vector', maxzoom: source.max_zoom, attribution: source.attribution,
      ...(source.tilejson ? {url: source.tilejson} : {tiles: [source.url]})}},
    layers: [...layers, ...labelLayers]};
}
