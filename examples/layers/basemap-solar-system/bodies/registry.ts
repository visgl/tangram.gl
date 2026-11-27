// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The map of each body: its coordinate reference system, raster tile source, vector data, and
// the credit and licence of each. A Body is the celestial constants plus this map description.

import {BODY_IDS, PHYSICAL_CONSTANTS, type BodyId, type PhysicalConstants} from '../celestial';

/** A geographic (plate carree, 2 x 1 tiles at z0, origin -180/90) raster tile source. */
export type GeoSource = {
  readonly template: string;
  readonly maxZoom: number;
  readonly tileSize: 256 | 512;
  readonly label: string;
  readonly credit: string;
};

/** Vector map data: a GeoJSON file in ./data, and the credit of each source in it. */
export type VectorData = {readonly file: string; readonly credit: string};

export type BodyMap = {
  /**
   * The geographic CRS of the map coordinates: the IAU 2015 planetocentric sphere code of the
   * body (OGC "IAU_2015" authority), or EPSG:4326 for the Earth.
   */
  readonly crs: string;
  /** Fill colour of the body where no map draws. */
  readonly color: readonly [number, number, number];
  /** Gas or ice giant: banded fill. */
  readonly bands?: boolean;
  /** Raster tiles for the globe and the overview texture. */
  readonly source?: GeoSource;
  /** Vector map data. */
  readonly vector?: VectorData;
  /** Why a body has no vector map. */
  readonly noVector?: string;
  /** Credit of the raster tiles or the plain colour. */
  readonly rasterCredit: string;
};

export type Body = PhysicalConstants & BodyMap;

/**
 * The host of the resampled raster tiles: scene/tiles.ts answers
 * `https://${SHIM_HOST}/<body>/{z}/{x}/{y}.jpg` with Web Mercator tiles made from the GeoSource.
 */
export const SHIM_HOST = 'planet-tiles.invalid';

const TREK = 'https://trek.nasa.gov/tiles';
const WMTS = '1.0.0/default/default028mm/{z}/{row}/{col}.jpg';
const NAMES = 'Names: IAU/USGS Gazetteer of Planetary Nomenclature (public domain).';
const GRID = 'Graticule: generated.';
const GAS = 'a gas giant has no solid surface; its cloud bands move.';
const ICE = 'an ice giant has no solid surface to map.';

const MAPS: Record<BodyId, BodyMap> = {
  sun: {crs: 'IAU_2015:1000', color: [255, 196, 64], noVector: 'the Sun has no solid surface to map.', rasterCredit: 'Plain colour (no tiles).'},
  mercury: {
    crs: 'IAU_2015:19900',
    color: [150, 140, 130],
    source: {
      template: `${TREK}/Mercury/EQ/Mercury_MESSENGER_MDIS_Basemap_EnhancedColor_Mosaic_Global_665m/${WMTS}`,
      maxZoom: 5, tileSize: 256, label: 'MESSENGER MDIS enhanced colour mosaic, 665 m',
      credit: 'MESSENGER MDIS: NASA/JHUAPL/Carnegie Institution of Washington (via NASA Mercury Trek).'
    },
    vector: {
      file: 'mercury.geojson',
      credit: `4 km contours from the USGS MESSENGER global DEM 665 m v2 (public domain); crater rims from the gazetteer centres and diameters. ${NAMES} ${GRID}`
    },
    rasterCredit: 'MESSENGER MDIS: NASA/JHUAPL/Carnegie Institution of Washington (via NASA Mercury Trek).'
  },
  venus: {
    crs: 'IAU_2015:29900',
    color: [230, 205, 150],
    vector: {file: 'venus.geojson', credit: `Crater rims from the gazetteer centres and diameters. ${NAMES} ${GRID}`},
    rasterCredit: 'Plain colour (no tiles).'
  },
  earth: {crs: 'EPSG:4326', color: [70, 120, 200], rasterCredit: 'NASA Blue Marble shaded relief and bathymetry (NASA GIBS).'},
  moon: {
    crs: 'IAU_2015:30100',
    color: [170, 170, 170],
    source: {
      template: `${TREK}/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/${WMTS}`,
      maxZoom: 8, tileSize: 256, label: 'LRO LROC WAC global mosaic, 303 ppd',
      credit: 'LROC WAC: NASA/GSFC/Arizona State University (via NASA Moon Trek).'
    },
    vector: {
      file: 'moon.geojson',
      credit: `Maria, crater rim crests and basin rings: USGS Unified Geologic Map of the Moon 1:5M, Fortezzo et al. 2020 (CC0). ${NAMES} ${GRID}`
    },
    rasterCredit: `LROC WAC: NASA/GSFC/Arizona State University (via NASA Moon Trek). ${NAMES}`
  },
  mars: {
    crs: 'IAU_2015:49900',
    color: [200, 110, 70],
    source: {
      template: `${TREK}/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/${WMTS}`,
      maxZoom: 7, tileSize: 256, label: 'Viking MDIM 2.1 colour mosaic, 232 m',
      credit: 'Viking MDIM 2.1: NASA/JPL/USGS (via NASA Mars Trek).'
    },
    vector: {
      file: 'mars.geojson',
      credit: `Geologic units by age: USGS SIM 3292, Geologic Map of Mars, Tanaka et al. 2014 (public domain); crater rims from the gazetteer centres and diameters. ${NAMES} ${GRID}`
    },
    rasterCredit: `Viking MDIM 2.1: NASA/JPL/USGS (via NASA Mars Trek). ${NAMES}`
  },
  jupiter: {crs: 'IAU_2015:59900', color: [205, 170, 130], bands: true, noVector: GAS, rasterCredit: 'Plain colour bands (no tiles).'},
  saturn: {
    crs: 'IAU_2015:69900', color: [220, 195, 140], bands: true, noVector: GAS,
    rasterCredit: 'Plain colour bands (no tiles). Rings: math.gl ring radii, NSSDC band edges.'
  },
  uranus: {crs: 'IAU_2015:79900', color: [160, 215, 225], noVector: ICE, rasterCredit: 'Plain colour (no tiles).'},
  neptune: {crs: 'IAU_2015:89900', color: [80, 120, 220], bands: true, noVector: ICE, rasterCredit: 'Plain colour bands (no tiles).'}
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const BODIES: Readonly<Record<BodyId, Body>> = deepFreeze(
  Object.fromEntries(BODY_IDS.map(id => [id, {...PHYSICAL_CONSTANTS[id], ...MAPS[id]}])) as Record<BodyId, Body>
);

/** The credit of the raster (or plain) surface of a body, and of its constants. */
export function rasterCredit(body: Body): string {
  return `${body.rasterCredit} Constants: ${body.constantsSource}.`;
}
