// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {BasemapStyle} from '@tangram.gl/basemap-layers/map-style';

/** One PMTiles archive, the style that draws it, and the view that shows it. */
export type ArchiveOption = {
  id: 'vector' | 'raster';
  label: string;
  /** The URL of the `.pmtiles` file. The style source reads it as `pmtiles://<url>`. */
  url: string;
  /** The size of the file in bytes. */
  size: number;
  /** What the archive holds, for the info panel. */
  description: string;
  attributionHtml: string;
  view: {longitude: number; latitude: number; zoom: number};
  style: BasemapStyle;
};

/**
 * A Protomaps basemap extract of Florence, Italy: MVT tiles, zoom 0 to 15. The PMTiles repository
 * and the MapLibre GL JS PMTiles example use it. Data © OpenStreetMap contributors, ODbL.
 */
export const VECTOR_ARCHIVE_URL = 'https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles';

/**
 * The Stamen Toner raster map of the world as an archive: 256 pixel PNG tiles, zoom 0 to 3.
 * Map tiles by Stamen Design, CC BY 4.0. Data © OpenStreetMap contributors, ODbL.
 */
export const RASTER_ARCHIVE_URL = 'https://pmtiles.io/stamen_toner(raster)CC-BY+ODbL_z3.pmtiles';

/** The glyphs of the Protomaps basemaps, Noto Sans, under the SIL Open Font License. */
const GLYPHS_URL = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

const SOURCE = 'protomaps';

/**
 * A minimal style for the version 3 schema of the Protomaps basemap, which the Florence archive
 * uses: the kind of each feature is in its `pmap:kind` property.
 */
function getVectorStyle(url: string): BasemapStyle {
  const kind = ['get', 'pmap:kind'];
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {[SOURCE]: {type: 'vector', url: `pmtiles://${url}`, attribution: OSM_ATTRIBUTION}},
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#dcd8d0'}},
      {
        id: 'earth',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'earth',
        paint: {'fill-color': '#f2efe9'}
      },
      {
        id: 'landuse-green',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landuse',
        filter: ['in', kind, ['literal', ['park', 'garden', 'grass', 'cemetery', 'pitch', 'golf_course', 'recreation_ground']]],
        paint: {'fill-color': '#cfe5c0'}
      },
      {
        id: 'natural-wood',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'natural',
        filter: ['in', kind, ['literal', ['forest', 'wood', 'scrub', 'meadow']]],
        paint: {'fill-color': '#bcd9a8'}
      },
      {
        id: 'landuse-urban',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'landuse',
        filter: ['in', kind, ['literal', ['hospital', 'school', 'university', 'kindergarten']]],
        paint: {'fill-color': '#eee3d6'}
      },
      {
        id: 'water',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'water',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: {'fill-color': '#9fc8e6'}
      },
      {
        id: 'waterway',
        type: 'line',
        source: SOURCE,
        'source-layer': 'physical_line',
        filter: ['in', kind, ['literal', ['river', 'canal', 'stream']]],
        paint: {
          'line-color': '#9fc8e6',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 3]
        }
      },
      {
        id: 'buildings',
        type: 'fill',
        source: SOURCE,
        'source-layer': 'buildings',
        minzoom: 13,
        paint: {'fill-color': '#ddd6cc', 'fill-outline-color': '#cbc2b6'}
      },
      {
        id: 'rail',
        type: 'line',
        source: SOURCE,
        'source-layer': 'transit',
        filter: ['==', kind, 'rail'],
        paint: {'line-color': '#a8a29a', 'line-width': 1}
      },
      {
        id: 'roads-minor',
        type: 'line',
        source: SOURCE,
        'source-layer': 'roads',
        filter: ['in', kind, ['literal', ['minor_road', 'other', 'path']]],
        minzoom: 13,
        paint: {
          'line-color': '#ffffff',
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 0.5, 16, 5]
        }
      },
      {
        id: 'roads-major',
        type: 'line',
        source: SOURCE,
        'source-layer': 'roads',
        filter: ['in', kind, ['literal', ['medium_road', 'major_road']]],
        paint: {
          'line-color': '#fbe3a6',
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 10, 0.6, 16, 8]
        }
      },
      {
        id: 'roads-highway',
        type: 'line',
        source: SOURCE,
        'source-layer': 'roads',
        filter: ['==', kind, 'highway'],
        paint: {
          'line-color': '#f2a65a',
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 8, 0.8, 16, 10]
        }
      },
      {
        id: 'road-labels',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'roads',
        minzoom: 15,
        filter: ['has', 'name'],
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11
        },
        paint: {'text-color': '#5c5650', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5}
      },
      {
        id: 'place-labels',
        type: 'symbol',
        source: SOURCE,
        'source-layer': 'places',
        filter: ['in', kind, ['literal', ['locality', 'neighbourhood']]],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Medium'],
          'text-size': ['match', kind, 'locality', 15, 12]
        },
        paint: {'text-color': '#333333', 'text-halo-color': '#ffffff', 'text-halo-width': 2}
      }
    ]
  };
}

function getRasterStyle(url: string): BasemapStyle {
  return {
    version: 8,
    sources: {
      toner: {
        type: 'raster',
        url: `pmtiles://${url}`,
        tileSize: 256,
        attribution: `Map tiles by Stamen Design, CC BY 4.0. ${OSM_ATTRIBUTION}`
      }
    },
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
      {id: 'toner', type: 'raster', source: 'toner'}
    ]
  };
}

/** The archives that the example can show. */
export const ARCHIVE_OPTIONS: ArchiveOption[] = [
  {
    id: 'vector',
    label: 'Vector, Florence',
    url: VECTOR_ARCHIVE_URL,
    size: 6601156,
    description: 'A Protomaps basemap extract of Florence: MVT tiles, zoom 0 to 15.',
    attributionHtml: [
      '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a>',
      OSM_ATTRIBUTION
    ].join(' '),
    view: {longitude: 11.2543, latitude: 43.7672, zoom: 14},
    style: getVectorStyle(VECTOR_ARCHIVE_URL)
  },
  {
    id: 'raster',
    label: 'Raster, world',
    url: RASTER_ARCHIVE_URL,
    size: 716052,
    description: 'Stamen Toner for the world: 256 pixel PNG tiles, zoom 0 to 3.',
    attributionHtml: [
      'Map tiles by <a href="https://stamen.com" target="_blank" rel="noopener">Stamen Design</a>,',
      'under <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>.',
      OSM_ATTRIBUTION
    ].join(' '),
    view: {longitude: 10, latitude: 30, zoom: 1.5},
    style: getRasterStyle(RASTER_ARCHIVE_URL)
  }
];
