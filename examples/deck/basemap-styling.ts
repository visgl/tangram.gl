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

/** Minimal feature context passed to a serialized Tangram draw function. */
interface BuildingContext {
  /** Source feature, before any schema-specific height aliases are introduced. */
  feature: {
    /** OpenMapTiles render heights or legacy Tangram height fields, in meters. */
    properties: Record<string, unknown>;
  };
}

/**
 * Resolve OpenMapTiles' render heights for TRON roofs and outlines together.
 * This function is serialized into a worker: keep all runtime helpers local.
 * Zero is a valid height; missing or malformed render fields fall back to
 * legacy height fields, then Tangram's historical 20/0-meter defaults.
 */
export function openMapTilesBuildingExtrusion(context: BuildingContext): [number, number] {
  const properties = context.feature.properties;
  const readHeight = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined;
    const height = Number(value);
    return Number.isFinite(height) ? height : undefined;
  };
  return [
    readHeight(properties.render_min_height) ?? readHeight(properties.min_height) ?? 0,
    readHeight(properties.render_height) ?? readHeight(properties.height) ?? 20
  ];
}
