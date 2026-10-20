// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Example-owned cartography shared by Tangram and its static MapLibre reference. */
export const STREETS_COLORS = {
  background: '#f5f3ef', landcover: '#e8eee5', landuse: '#eeeae2', park: '#cfe5c8',
  water: '#b9d9e7', waterway: '#a4cfdf', building: '#ded8d0',
  road: '#ffffff', roadOutline: '#d5d0c8', majorRoad: '#f5c879', majorRoadOutline: '#d4aa65'
} as const;

/** Tangram style zoom uses a 256-pixel world; deck and MapLibre use 512 pixels. */
export const STREETS_BUILDING_MIN_ZOOM = 14;

/** Classes promoted by the Streets example, not a renderer-wide road classification. */
export const STREETS_MAJOR_ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary'] as const;

/** Return fresh Tangram pixel-width stops so scene normalization cannot mutate shared state. */
export function createStreetsRoadWidths(major = false): [number, string][] {
  return major ? [[8, '1px'], [12, '2px'], [16, '7px']] : [[8, '0.5px'], [12, '1px'], [16, '3px']];
}

/** Properties provided by Tangram when compiling the closure-free draw callback. */
declare const feature: {layer?: number | string; brunnel?: string; class?: string};

/** Preserve grade separation before road class; keep all helpers inside the serialized function. */
export function getStreetsRoadOrder(): number {
  const classOrder: Record<string, number> = {
    path: 0, track: 1, service: 2, minor: 3, tertiary: 4, secondary: 5, primary: 6, trunk: 7, motorway: 8
  };
  let layer = Number.parseInt(String(feature.layer), 10) || 0;
  if (layer === 0 && feature.brunnel === 'bridge') layer = 1;
  else if (layer === 0 && feature.brunnel === 'tunnel') layer = -1;
  layer = Math.max(-5, Math.min(5, layer));
  return 128 + layer * 16 + (classOrder[feature.class ?? ''] || 0);
}

/** Build the production road rules independently so hermetic fixtures exercise real example styling. */
export function createStreetsRoadRules() {
  return {
    data: {source: 'basemap', layer: 'transportation'},
    draw: {lines: {style: 'basemap-lines', order: getStreetsRoadOrder, color: STREETS_COLORS.road,
      width: createStreetsRoadWidths(), outline: {color: STREETS_COLORS.roadOutline, width: '1px'}}},
    major: {filter: {class: [...STREETS_MAJOR_ROAD_CLASSES]}, draw: {lines: {
      color: STREETS_COLORS.majorRoad, width: createStreetsRoadWidths(true),
      outline: {color: STREETS_COLORS.majorRoadOutline, width: '1px'}
    }}}
  };
}
