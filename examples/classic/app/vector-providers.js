// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {CARTO_ATTRIBUTION} from './attribution.js';

/** Stable metadata URL: the service supplies the current versioned tile template. */
export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
/** Explicit loading-time credits; discovered TileJSON credits remain authoritative too. */
export const OPENFREEMAP_ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

/** Resolve a bookmarked provider, defaulting unknown/missing values to OpenFreeMap. */
export function resolveVectorProvider(provider) {
  return provider === 'carto' ? 'carto' : 'openfreemap';
}

/** Build a fresh OpenMapTiles source without inheriting a previous provider's URL. */
export function createVectorSource(provider = 'openfreemap') {
  const useCarto = resolveVectorProvider(provider) === 'carto';
  return {
    type: 'MVT',
    // Explicit empty values also clear imported Nextzen or previous provider settings.
    url: useCarto ? 'https://tiles-a.basemaps.cartocdn.com/vectortiles/carto.streets/v1/{z}/{x}/{y}.mvt' : '',
    tilejson: useCarto ? '' : OPENFREEMAP_TILEJSON,
    attribution: useCarto ? CARTO_ATTRIBUTION : OPENFREEMAP_ATTRIBUTION,
    url_params: null,
    rasters: [],
    tile_size: 512,
    // TileJSON resolution does not automatically adopt metadata's zoom limits.
    max_zoom: 14
  };
}
