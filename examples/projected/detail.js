// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Fixed geographic loading regions; neither follows orthographic panning automatically. */
export function getProjectedExampleBounds(regional) {
  return regional ? [-170, 5, -40, 75] : [-180, -85.0511287798066, 180, 85.0511287798066];
}

/** Explicit source detail choices, bounded to 256 logical candidates per source. */
export function getProjectedExampleDetailChoices(raster, regional, countTileCoordinates) {
  const bounds = getProjectedExampleBounds(regional);
  return Array.from({length: raster ? 7 : 3}, (_, index) => {
    const zoom = index + (raster ? 0 : 4);
    const tiles = countTileCoordinates(bounds, zoom);
    return {zoom, tiles, disabled: tiles > 256};
  });
}
