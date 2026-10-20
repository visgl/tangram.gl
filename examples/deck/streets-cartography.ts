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
