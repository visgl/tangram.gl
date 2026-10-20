// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Flat cartographic colors must not depend on a backend's default scene light. */
export function createUnlitVectorStyles() {
  return {
    'basemap-polygons': {base: 'polygons', lighting: false},
    'basemap-lines': {base: 'lines', lighting: false}
  };
}

/** Tangram supplies feature properties when compiling a closure-free draw function. */
declare const feature: Record<string, unknown>;

/**
 * Resolve OpenMapTiles' render heights for TRON roofs and outlines together.
 * This function is serialized into a worker: keep all runtime helpers local.
 * Zero is a valid height; missing or malformed render fields fall back to
 * legacy height fields, then Tangram's historical 20/0-meter defaults.
 */
export function openMapTilesBuildingExtrusion(): [number, number] {
  const properties = feature;
  const readHeight = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && (typeof value !== 'string' || value === '')) return undefined;
    const height = Number(value);
    return Number.isFinite(height) ? height : undefined;
  };
  return [
    readHeight(properties.render_min_height) ?? readHeight(properties.min_height) ?? 0,
    readHeight(properties.render_height) ?? readHeight(properties.height) ?? 20
  ];
}
