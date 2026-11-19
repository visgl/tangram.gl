// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Basemaps of other worlds, exported from `@tangram.gl/basemap-layers/bodies`.
 *
 * A frozen registry of open map sources for the Moon, Mars, Mercury, Venus and the Earth: the
 * coordinate reference system and radius of each body, its raster tiles, its vector map sources,
 * and the credit and licence of each source. This entry holds data only. It imports nothing, so a
 * bundler drops it when an application does not import it.
 */

/** The bodies that have an entry in {@link BODY_BASEMAPS}. */
export type BodyBasemapId = 'mercury' | 'venus' | 'earth' | 'moon' | 'mars';

/** An open dataset that a vector map of a body uses. */
export type BodyDataset = {
  /** The name of the dataset, with its authors and year where the publisher gives them. */
  readonly label: string;
  /** The page or file of the publisher. */
  readonly url: string;
  /** The licence of the dataset, as the publisher states it. */
  readonly licence: string;
};

/**
 * A raster tile source of a body.
 *
 * `tiles` is a URL template with the `{z}`, `{x}` (column) and `{y}` (row, from the top)
 * placeholders. `grid` tells how the tiles cover the body:
 *
 * - `'web-mercator'`: the Web Mercator grid of `BasemapLayer` (1 x 1 tiles at zoom 0). A style
 *   can use the template directly.
 * - `'geographic'`: a plate carree grid with 2 x 1 tiles at zoom 0, origin at longitude -180 and
 *   latitude 90. `BasemapLayer` cannot read this grid directly. The application must resample
 *   the tiles to Web Mercator, for example in a `fetch` function of `loadOptions`.
 */
export type BodyRasterSource = {
  /** The URL template of the tiles. */
  readonly tiles: string;
  /** The tile grid of `tiles`. */
  readonly grid: 'web-mercator' | 'geographic';
  /** The highest zoom level of the tiles. */
  readonly maxZoom: number;
  /** The width and height of a tile, in pixels. */
  readonly tileSize: 256 | 512;
  /** A short description of the imagery. */
  readonly label: string;
  /** The attribution to show with the tiles. */
  readonly credit: string;
  /** The licence of the tiles. */
  readonly licence: string;
};

/**
 * The vector map source of a body. `type` tells which form it has:
 *
 * - `'style'`: a MapLibre style URL that `BasemapLayer` loads directly.
 * - `'datasets'`: open datasets that an application converts to vector data (for example GeoJSON)
 *   and styles itself. No hosted vector tiles exist for these bodies.
 */
export type BodyVectorSource =
  | {
      /** The source is a MapLibre style. */
      readonly type: 'style';
      /** The URL of the style JSON. */
      readonly url: string;
      /** The attribution to show with the map. */
      readonly credit: string;
      /** The licence of the map data. */
      readonly licence: string;
    }
  | {
      /** The source is a list of open datasets. */
      readonly type: 'datasets';
      /** The datasets, each with its URL and licence. */
      readonly datasets: readonly BodyDataset[];
      /** The attribution to show with a map made from the datasets. */
      readonly credit: string;
    };

/** The basemap description of one body. */
export type BodyBasemap = {
  /** The identifier of the body. */
  readonly id: BodyBasemapId;
  /** The English name of the body. */
  readonly label: string;
  /**
   * The geographic CRS of the map coordinates: the IAU 2015 planetocentric code of the body
   * (OGC `IAU_2015` authority), or `EPSG:4326` for the Earth.
   */
  readonly crs: string;
  /** The semi-major axis of the ellipsoid of `crs`, in metres. */
  readonly radius: number;
  /** The definition of `crs` that gives `radius`. */
  readonly radiusSource: string;
  /** Raster imagery of the body, or `undefined` if no open tile service exists. */
  readonly raster?: BodyRasterSource;
  /** The vector map source of the body. */
  readonly vector: BodyVectorSource;
};

const TREK = 'https://trek.nasa.gov/tiles';
const WMTS = '1.0.0/default/default028mm/{z}/{y}/{x}.jpg';
const NASA_NO_RESTRICTION = 'NASA, no restriction';
const IAU_2015_SOURCE = 'IAU 2015 planetocentric CRS (Archinal et al. 2018, doi:10.1007/s10569-017-9805-5)';
const NAMES = 'Names: IAU/USGS Gazetteer of Planetary Nomenclature (public domain).';
const GAZETTEER: BodyDataset = {
  label: 'IAU/USGS Gazetteer of Planetary Nomenclature',
  url: 'https://planetarynames.wr.usgs.gov/GIS_Downloads',
  licence: 'Public domain'
};

const BASEMAPS: Record<BodyBasemapId, BodyBasemap> = {
  mercury: {
    id: 'mercury',
    label: 'Mercury',
    crs: 'IAU_2015:19900',
    radius: 2440530,
    radiusSource: IAU_2015_SOURCE,
    raster: {
      tiles: `${TREK}/Mercury/EQ/Mercury_MESSENGER_MDIS_Basemap_EnhancedColor_Mosaic_Global_665m/${WMTS}`,
      grid: 'geographic',
      maxZoom: 5,
      tileSize: 256,
      label: 'MESSENGER MDIS enhanced colour mosaic, 665 m',
      credit: 'MESSENGER MDIS: NASA/JHUAPL/Carnegie Institution of Washington (via NASA Mercury Trek).',
      licence: NASA_NO_RESTRICTION
    },
    vector: {
      type: 'datasets',
      datasets: [
        {
          label: 'USGS MESSENGER global DEM 665 m v2',
          url: 'https://planetarymaps.usgs.gov/mosaic/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif',
          licence: 'US public domain ("please cite authors")'
        },
        GAZETTEER
      ],
      credit: `4 km contours from the USGS MESSENGER global DEM 665 m v2 (public domain); crater rims from the gazetteer centres and diameters. ${NAMES}`
    }
  },
  venus: {
    id: 'venus',
    label: 'Venus',
    crs: 'IAU_2015:29900',
    radius: 6051800,
    radiusSource: IAU_2015_SOURCE,
    vector: {
      type: 'datasets',
      datasets: [GAZETTEER],
      credit: `Crater rims from the gazetteer centres and diameters. ${NAMES}`
    }
  },
  earth: {
    id: 'earth',
    label: 'Earth',
    crs: 'EPSG:4326',
    radius: 6378137,
    radiusSource: 'WGS 84 ellipsoid (EPSG:7030)',
    raster: {
      tiles:
        'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
      grid: 'web-mercator',
      maxZoom: 8,
      tileSize: 256,
      label: 'NASA Blue Marble shaded relief and bathymetry',
      credit: 'NASA Blue Marble shaded relief and bathymetry (NASA GIBS).',
      licence: NASA_NO_RESTRICTION
    },
    vector: {
      type: 'style',
      url: 'https://tiles.openfreemap.org/styles/liberty',
      credit: 'OpenFreeMap "liberty" style, © OpenMapTiles, data © OpenStreetMap contributors (ODbL).',
      licence: 'Data © OpenStreetMap contributors (ODbL), © OpenMapTiles'
    }
  },
  moon: {
    id: 'moon',
    label: 'Moon',
    crs: 'IAU_2015:30100',
    radius: 1737400,
    radiusSource: IAU_2015_SOURCE,
    raster: {
      tiles: `${TREK}/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/${WMTS}`,
      grid: 'geographic',
      maxZoom: 8,
      tileSize: 256,
      label: 'LRO LROC WAC global mosaic, 303 ppd',
      credit: 'LROC WAC: NASA/GSFC/Arizona State University (via NASA Moon Trek).',
      licence: NASA_NO_RESTRICTION
    },
    vector: {
      type: 'datasets',
      datasets: [
        {
          label: 'USGS Unified Geologic Map of the Moon 1:5M (Fortezzo et al., 2020)',
          url: 'https://astrogeology.usgs.gov/search/map/unified_geologic_map_of_the_moon_1_5m_2020',
          licence: 'CC0 ("please cite authors")'
        },
        GAZETTEER
      ],
      credit: `Maria, crater rim crests and basin rings: USGS Unified Geologic Map of the Moon 1:5M, Fortezzo et al. 2020 (CC0). ${NAMES}`
    }
  },
  mars: {
    id: 'mars',
    label: 'Mars',
    crs: 'IAU_2015:49900',
    radius: 3396190,
    radiusSource: IAU_2015_SOURCE,
    raster: {
      tiles: `${TREK}/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/${WMTS}`,
      grid: 'geographic',
      maxZoom: 7,
      tileSize: 256,
      label: 'Viking MDIM 2.1 colour mosaic, 232 m',
      credit: 'Viking MDIM 2.1: NASA/JPL/USGS (via NASA Mars Trek).',
      licence: NASA_NO_RESTRICTION
    },
    vector: {
      type: 'datasets',
      datasets: [
        {
          label: 'USGS SIM 3292, Geologic Map of Mars (Tanaka et al., 2014)',
          url: 'https://pubs.usgs.gov/sim/3292/',
          licence: 'US public domain'
        },
        GAZETTEER
      ],
      credit: `Geologic units by age: USGS SIM 3292, Geologic Map of Mars, Tanaka et al. 2014 (public domain); crater rims from the gazetteer centres and diameters. ${NAMES}`
    }
  }
};

/** Freezes a value and every object and array in it. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** The basemap descriptions of the Moon, Mars, Mercury, Venus and the Earth. The data is frozen. */
export const BODY_BASEMAPS: Readonly<Record<BodyBasemapId, BodyBasemap>> = deepFreeze(BASEMAPS);
