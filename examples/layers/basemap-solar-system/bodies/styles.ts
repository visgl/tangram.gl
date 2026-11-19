// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The basemap style of each body, for BasemapLayer on a GlobeView.
//
// - 'vector': a vector map. Earth: the OpenFreeMap "liberty" style (OpenMapTiles vector tiles).
//   Moon, Mars, Mercury and Venus: GeoJSON built from open planetary data (see
//   data/build_data.py and README.md), with a generated graticule. Bodies with no open vector
//   data keep their raster tiles or plain colour.
// - 'imagery': raster mosaics (NASA GIBS for Earth, NASA Trek for the others), with the names of
//   the vector map on top from DETAIL_FROM.
//
// In both, a transparent "water" fill layer makes tangram.gl's north-pole cap the colour of the
// body (vector) or transparent (imagery, so the overview sphere behind the globe shows).

import type {BasemapLayer} from '@tangram.gl/basemap-layers';
import type {BodyId} from '../celestial';
import {BODIES, SHIM_HOST, rasterCredit, type Body} from './registry';

export type BasemapStyle = ConstructorParameters<typeof BasemapLayer>[0]['style'];
export type SurfaceMode = 'vector' | 'imagery';
type StyleLayer = {id: string; type: string; minzoom?: number; maxzoom?: number; paint?: Record<string, unknown>; [k: string]: unknown};
type Style = {version: 8; name?: string; sources: Record<string, unknown>; layers: StyleLayer[]; [k: string]: unknown};

/** Zoom at which the Earth imagery gives way to the vector map, and the names of other bodies show. */
export const DETAIL_FROM = 4.5;
const DETAIL_TO = 6.5;
const GIBS_BLUE_MARBLE_3857 =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';
export const EARTH_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const rampUp = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], a, 0, b, 1];
const rampDown = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], a, 1, b, 0];
const EMPTY_SOURCE = {type: 'geojson', data: {type: 'FeatureCollection', features: []}};
/** tangram.gl colours its north-pole cap as the first fill layer whose source-layer has "water". */
const poleLayer = (color: string, opacity: number): StyleLayer => ({
  id: 'pole-cap',
  type: 'fill',
  source: 'none',
  'source-layer': 'water',
  paint: {'fill-color': color, 'fill-opacity': opacity}
});

// ---------- Earth ----------

async function getLiberty(): Promise<Style> {
  const response = await fetch(EARTH_STYLE_URL);
  if (!response.ok) throw new Error(`${EARTH_STYLE_URL}: ${response.status}`);
  return (await response.json()) as Style;
}

/** Imagery: Blue Marble (the overview texture) up to DETAIL_FROM, then the vector map fades in. */
function earthImageryStyle(style: Style): Style {
  const layers: StyleLayer[] = style.layers.map((layer): StyleLayer =>
    layer.type === 'background'
      ? {...layer, paint: {...layer.paint, 'background-opacity': rampUp(DETAIL_FROM, DETAIL_TO)}}
      : {...layer, minzoom: Math.max(layer.minzoom ?? 0, layer.type === 'symbol' ? DETAIL_FROM + 1 : DETAIL_FROM)}
  );
  const firstSymbol = layers.findIndex(layer => layer.type === 'symbol');
  layers.splice(firstSymbol < 0 ? layers.length : firstSymbol, 0, {
    id: 'imagery',
    type: 'raster',
    source: 'imagery',
    maxzoom: DETAIL_TO,
    paint: {'raster-opacity': rampDown(DETAIL_FROM, DETAIL_TO)}
  });
  layers.splice(1, 0, poleLayer('#000000', 0));
  return {
    ...style,
    sources: {
      ...style.sources,
      none: EMPTY_SOURCE,
      imagery: {type: 'raster', tiles: [GIBS_BLUE_MARBLE_3857], tileSize: 256, maxzoom: 8}
    },
    layers
  };
}

export async function getEarthStyle(mode: SurfaceMode): Promise<BasemapStyle> {
  const style = await getLiberty();
  return (mode === 'vector' ? style : earthImageryStyle(style)) as unknown as BasemapStyle;
}

// ---------- Other bodies ----------

/** Vector map colours of the bodies with vector data. */
type Look = {land: string; dark: string; rim: string; grid: string; text: string; units?: Record<string, string>};
const VECTOR_LOOK: Readonly<Partial<Record<BodyId, Look>>> = Object.freeze({
  moon: {land: '#b9b6ae', dark: '#6f6d68', rim: '#4b4944', grid: '#8c8a84', text: '#1d1c1a', units: {mare: '#77746d'}},
  mars: {
    land: '#c98a5f', dark: '#8a5236', rim: '#5d3320', grid: '#a96f4c', text: '#2a1408',
    units: {noachian: '#a8673f', hesperian: '#c98a5f', amazonian: '#dfae84', other: '#b97a52'}
  },
  mercury: {land: '#aaa49c', dark: '#77716a', rim: '#4d4843', grid: '#8e8881', text: '#1e1c1a'},
  venus: {land: '#d9c38f', dark: '#b39a64', rim: '#7d6838', grid: '#c2ab76', text: '#2d220c'}
});

const dataUrl = (file: string) => new URL(`./data/${file}`, import.meta.url).href;

/** A graticule, 10 deg apart (|lat| <= 80), as GeoJSON lines. */
function graticule() {
  const features = [];
  for (let lon = -180; lon < 180; lon += 10) {
    const coordinates = [];
    for (let lat = -80; lat <= 80; lat += 2) coordinates.push([lon, lat]);
    features.push({type: 'Feature', properties: {meridian: lon === 0}, geometry: {type: 'LineString', coordinates}});
  }
  for (let lat = -80; lat <= 80; lat += 10) {
    const coordinates = [];
    for (let lon = -180; lon <= 180; lon += 2) coordinates.push([lon, lat]);
    features.push({type: 'Feature', properties: {meridian: lat === 0}, geometry: {type: 'LineString', coordinates}});
  }
  return {type: 'FeatureCollection', features};
}

/** Names (points of the IAU/USGS gazetteer), largest first. */
function nameLayers(color: string, halo: string, minzoom: number): StyleLayer[] {
  return [
    {
      id: 'feature-names',
      type: 'symbol',
      source: 'features',
      minzoom,
      filter: ['==', ['geometry-type'], 'Point'],
      layout: {
        'text-field': ['get', 'name'],
        'text-size': ['interpolate', ['linear'], ['get', 'diameter_km'], 20, 11, 500, 15],
        'symbol-sort-key': ['-', 0, ['get', 'diameter_km']]
      },
      paint: {'text-color': color, 'text-halo-color': halo, 'text-halo-width': 1.5}
    }
  ];
}

/** Unit fill colour: the colour of the unit name in the look, else the dark colour. */
function unitColor(look: Look): unknown {
  const units = Object.entries(look.units ?? {});
  return units.length ? ['match', ['get', 'unit'], ...units.flat(), look.dark] : look.dark;
}

function vectorStyle(body: Body): Style {
  const look = VECTOR_LOOK[body.id];
  const vector = body.vector;
  if (!look || !vector) throw new Error(`${body.label} has no vector data`);
  return {
    version: 8,
    name: `${body.label} vector`,
    sources: {
      none: EMPTY_SOURCE,
      graticule: {type: 'geojson', data: graticule()},
      features: {type: 'geojson', data: dataUrl(vector.file)}
    },
    layers: [
      {id: 'land', type: 'background', paint: {'background-color': look.land}},
      poleLayer(look.land, 1),
      {
        id: 'units',
        type: 'fill',
        source: 'features',
        filter: ['==', ['get', 'kind'], 'unit'],
        paint: {'fill-color': unitColor(look), 'fill-opacity': 0.9}
      },
      {
        id: 'contours',
        type: 'line',
        source: 'features',
        filter: ['==', ['get', 'kind'], 'contour'],
        paint: {
          'line-color': ['case', ['<', ['get', 'elevation_m'], 0], look.dark, look.rim],
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 8, 1.4],
          'line-opacity': 0.6
        }
      },
      {
        id: 'graticule',
        type: 'line',
        source: 'graticule',
        paint: {
          'line-color': look.grid,
          'line-width': ['case', ['get', 'meridian'], 1.2, 0.6],
          'line-opacity': 0.7
        }
      },
      {
        id: 'crater-rims',
        type: 'line',
        source: 'features',
        filter: ['match', ['get', 'kind'], ['crater', 'ring'], true, false],
        paint: {
          'line-color': look.rim,
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            2, ['case', ['==', ['get', 'kind'], 'ring'], 1.2, 0.5],
            8, ['case', ['==', ['get', 'kind'], 'ring'], 2.4, 1.4]
          ],
          'line-opacity': 0.9
        }
      },
      ...nameLayers(look.text, look.land, 2.5)
    ]
  };
}

function imageryStyle(body: Body): Style {
  const maxzoom = body.source ? body.source.maxZoom + 1 + Math.log2(body.source.tileSize / 256) : 3;
  return {
    version: 8,
    name: body.label,
    sources: {
      none: EMPTY_SOURCE,
      surface: {type: 'raster', tiles: [`https://${SHIM_HOST}/${body.id}/{z}/{x}/{y}.jpg`], tileSize: 256, maxzoom},
      ...(body.vector && {features: {type: 'geojson', data: dataUrl(body.vector.file)}})
    },
    layers: [
      {id: 'space', type: 'background', paint: {'background-color': '#05070d', 'background-opacity': 0}},
      poleLayer('#000000', 0),
      {id: 'surface', type: 'raster', source: 'surface'},
      ...(body.vector ? nameLayers('#ffffff', '#000000', DETAIL_FROM) : [])
    ]
  };
}

/** The style of a body for a surface mode. A body with no vector data draws its imagery. */
export async function getBodyStyle(id: BodyId, mode: SurfaceMode): Promise<BasemapStyle> {
  if (id === 'earth') return getEarthStyle(mode);
  const body = BODIES[id];
  return (mode === 'vector' && body.vector ? vectorStyle(body) : imageryStyle(body)) as unknown as BasemapStyle;
}

/** What the globe of a body shows in a surface mode, and the credits. */
export function surfaceCredit(body: Body, mode: SurfaceMode): string {
  if (body.id === 'earth') {
    return mode === 'vector'
      ? 'OpenFreeMap "liberty" style, © OpenMapTiles, data © OpenStreetMap contributors (ODbL). Constants: WGS84.'
      : `Imagery: NASA Blue Marble (NASA GIBS); from zoom ${DETAIL_FROM}: OpenFreeMap "liberty", © OpenMapTiles, data © OpenStreetMap contributors (ODbL).`;
  }
  if (mode === 'vector' && body.vector) return `Vector map: ${body.vector.credit} Constants: ${body.constantsSource}.`;
  if (mode === 'vector') return `No open vector data: ${body.noVector ?? ''} ${rasterCredit(body)}`;
  return rasterCredit(body);
}
