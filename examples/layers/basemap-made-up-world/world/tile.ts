// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// One Web Mercator vector tile of a world, in OpenMapTiles source layers.

import {clipLine, clipRing, contourRings, groupRings, simplify, type Ring} from './contour';
import {encodeTile, type TileFeature, type TileLayer} from './mvt';
import {hashInts} from './noise';
import {
  LANDCOVER_CLASSES,

  classifyLandcover,
  detailElevation,
  detailMoisture,
  temperatureAt,
  toNoise
} from './terrain';
import {sampleGrid, type World} from './world';

export const EXTENT = 4096;
export const MAX_ZOOM = 12;
const BUFFER_CELLS = 2;

export const SOURCE_LAYERS = [
  'water',
  'waterway',
  'landcover',
  'landuse',
  'place',
  'water_name',
  'mountain_peak'
] as const;

const lonOf = (mx: number) => mx * 360 - 180;
const latOf = (my: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => {
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

export type TileFeatures = Record<(typeof SOURCE_LAYERS)[number], TileFeature[]>;

/** The features of tile z/x/y, in tile coordinates (extent 4096, y down). */
export function generateTileFeatures(world: World, z: number, x: number, y: number): TileFeatures {
  const n = z <= 2 ? 128 : 64; // cells across the tile
  const cell = EXTENT / n;
  const size = n + 1 + 2 * BUFFER_CELLS; // samples across, with the buffer
  const scale = 2 ** z;
  const lons = new Float64Array(size);
  const lats = new Float64Array(size);
  for (let s = 0; s < size; s++) {
    const t = (s - BUFFER_CELLS) / n;
    lons[s] = lonOf((x + t) / scale);
    lats[s] = latOf(Math.min(1, Math.max(0, (y + t) / scale)));
  }

  const height = new Float32Array(size * size);
  const lakeField = new Float32Array(size * size);
  const cover = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    const lat = lats[j];
    for (let i = 0; i < size; i++) {
      const lon = lons[i];
      const [nx, ny] = toNoise(lon, lat);
      const k = j * size + i;
      const detail = detailElevation(world.noise, nx, ny);
      const h = sampleGrid(world.elevation, lon, lat) + detail - world.seaLevel;
      height[k] = h;
      const lake = sampleGrid(world.lake, lon, lat);
      lakeField[k] = h > 0 ? lake - 0.5 + detail * 2.5 : -1;
      if (h > 0) {
        const landHeight = h / (1 - world.seaLevel);
        const m = sampleGrid(world.moisture, lon, lat) + detailMoisture(world.noise, nx, ny);
        const tn = sampleGrid(world.temperatureNoise, lon, lat);
        const t = temperatureAt(lat, landHeight, tn);
        cover[k] = classifyLandcover(-0.2 + 1.3 * landHeight, m, t);
      }
    }
  }

  const toTile = (ring: Ring): Ring =>
    ring.map(([gx, gy]) => [(gx - BUFFER_CELLS) * cell, (gy - BUFFER_CELLS) * cell]);
  const tolerance = 0.35 * cell;
  const polygons = (field: Float32Array, threshold: number): [number, number][][][] => {
    const rings = contourRings(field, size, size, threshold)
      .map(ring => finishRing(simplify(toTile(ring), tolerance)))
      .filter((ring): ring is Ring => ring !== null);
    return groupRings(rings);
  };

  const features: TileFeatures = {
    water: [],
    waterway: [],
    landcover: [],
    landuse: [],
    place: [],
    water_name: [],
    mountain_peak: []
  };

  // Water: the sea is where the full-detail height is below 0; lakes from the coarse basins.
  const sea = new Float32Array(height.length);
  for (let k = 0; k < sea.length; k++) sea[k] = -height[k];
  const ocean = polygons(sea, 0);
  if (ocean.length) features.water.push({type: 3, geometry: ocean, properties: {class: 'ocean'}});
  const lakes = polygons(lakeField, 0);
  if (lakes.length) features.water.push({type: 3, geometry: lakes, properties: {class: 'lake'}});

  // Landcover: one polygon set per class, on a smoothed indicator of the class.
  const indicator = new Float32Array(cover.length);
  for (let c = 1; c < LANDCOVER_CLASSES.length; c++) {
    let present = false;
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        let sum = 0;
        let count = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const jj = j + dj;
            const ii = i + di;
            if (jj < 0 || ii < 0 || jj >= size || ii >= size) continue;
            count++;
            if (cover[jj * size + ii] === c) sum++;
          }
        const value = sum / count;
        indicator[j * size + i] = value;
        if (value > 0.5) present = true;
      }
    if (!present) continue;
    const geometry = polygons(indicator, 0.5);
    if (geometry.length) {
      const cls = LANDCOVER_CLASSES[c];
      features.landcover.push({type: 3, geometry, properties: {class: cls, subclass: cls}});
    }
  }

  // Projection of world points into this tile; lon may be unwrapped, so try the three copies.
  const project = (lon: number, lat: number, shift: number): [number, number] => [
    (mercX(lon + shift) * scale - x) * EXTENT,
    (mercY(lat) * scale - y) * EXTENT
  ];
  const BUFFER = BUFFER_CELLS * cell;
  const inTile = (p: [number, number]) => p[0] >= 0 && p[0] < EXTENT && p[1] >= 0 && p[1] < EXTENT;

  // Rivers: smaller ones appear at higher zooms; a meander from noise is added per tile, from
  // world coordinates, so that it is the same curve at every zoom.
  const minFlow = world.riverThreshold * 2 ** (Math.max(0, 5 - z) * 0.8);
  const riverClassFlow = world.riverThreshold * 10;
  const subdivisions = Math.min(32, 2 ** Math.max(0, z - 2));
  const tileWest = lonOf(x / scale);
  const tileEast = lonOf((x + 1) / scale);
  const tileNorth = latOf(y / scale);
  const tileSouth = latOf((y + 1) / scale);
  const margin = (tileEast - tileWest) * 0.2 + 1;
  for (const river of world.rivers) {
    if (river.maxFlow < minFlow) continue;
    for (const shift of [-360, 0, 360]) {
      // Runs of points of one class, within the tile's box plus a margin.
      let run: Ring = [];
      let runClass = '';
      const flush = () => {
        if (run.length > 1) {
          for (const piece of clipLine(run, -BUFFER, EXTENT + BUFFER)) {
            const line = finishLine(simplify(piece, tolerance * 0.5));
            if (line) {
              features.waterway.push({
                type: 2,
                geometry: [line],
                properties: river.name ? {class: runClass, name: river.name} : {class: runClass}
              });
            }
          }
        }
        run = [];
      };
      for (let p = 0; p < river.points.length - 1; p++) {
        const [lon0, lat0] = river.points[p];
        const [lon1, lat1] = river.points[p + 1];
        const flow = Math.max(river.flow[p], river.flow[p + 1]);
        const lonA = lon0 + shift;
        const lonB = lon1 + shift;
        const outside =
          Math.max(lonA, lonB) < tileWest - margin ||
          Math.min(lonA, lonB) > tileEast + margin ||
          Math.max(lat0, lat1) < tileSouth - margin ||
          Math.min(lat0, lat1) > tileNorth + margin;
        if (flow < minFlow || outside) {
          flush();
          continue;
        }
        const cls = flow >= riverClassFlow ? 'river' : 'stream';
        if (cls !== runClass) {
          const last = run[run.length - 1];
          flush();
          if (last) run.push(last);
          runClass = cls;
        }
        if (!run.length) run.push(project(lon0, lat0, shift));
        const dLon = lon1 - lon0;
        const dLat = lat1 - lat0;
        const len = Math.hypot(dLon, dLat);
        for (let s = 1; s <= subdivisions; s++) {
          const t = s / subdivisions;
          let lon = lon0 + dLon * t;
          let lat = lat0 + dLat * t;
          if (s < subdivisions && len > 0) {
            const [nx, ny] = toNoise(lon, lat);
            const n =
              0.3 * world.noise.detail.noise2D(nx * 96 + 17.3, ny * 96 - 4.1) +
              0.18 * world.noise.detail.noise2D(nx * 640 - 3.7, ny * 640 + 8.9);
            const wiggle = n * len * Math.sin(Math.PI * t);
            lon += (-dLat / len) * wiggle;
            lat += (dLon / len) * wiggle;
          }
          run.push(project(lon, lat, shift));
        }
      }
      flush();
    }
  }

  // Town land use, as noisy disks around each town.
  for (const town of world.towns) {
    const minZoom = town.class === 'city' ? 6 : town.class === 'town' ? 8 : 10;
    if (z < minZoom) continue;
    const km = town.class === 'city' ? 7 : town.class === 'town' ? 3 : 1.2;
    const rLat = km / 111;
    const rLon = rLat / Math.max(0.2, Math.cos((town.lat * Math.PI) / 180));
    for (const shift of [-360, 0, 360]) {
      const lon = town.lon + shift;
      if (lon + rLon < tileWest || lon - rLon > tileEast || town.lat - rLat > tileNorth || town.lat + rLat < tileSouth)
        continue;
      const ring: Ring = [];
      const seed = hashInts(world.seed, town.rank);
      for (let a = 0; a < 24; a++) {
        const angle = (a / 24) * 2 * Math.PI;
        const r = 1 + 0.35 * world.noise.detail.noise2D(Math.cos(angle) * 1.5 + (seed % 997), Math.sin(angle) * 1.5);
        // Clockwise on screen: east, then south (y down).
        ring.push(project(lon + Math.cos(angle) * rLon * r, town.lat - Math.sin(angle) * rLat * r, 0));
      }
      const clipped = finishRing(clipRing(ring, -BUFFER, EXTENT + BUFFER));
      if (clipped) {
        features.landuse.push({type: 3, geometry: [[clipped]], properties: {class: 'residential'}});
      }
    }
  }

  // Points: each in the one tile that holds it.
  const pointIn = (lon: number, lat: number): [number, number] | null => {
    for (const shift of [-360, 0, 360]) {
      const p = project(lon, lat, shift);
      if (inTile(p)) return [Math.round(p[0]), Math.round(p[1])];
    }
    return null;
  };
  for (const town of world.towns) {
    const minZoom = town.class === 'city' ? 2 : town.class === 'town' ? 5 : 7;
    if (z < minZoom) continue;
    const p = pointIn(town.lon, town.lat);
    if (p) {
      features.place.push({
        type: 1,
        geometry: [p],
        properties: {class: town.class, name: town.name, rank: Math.min(20, 1 + Math.floor(town.rank / 20))}
      });
    }
  }
  for (const peak of world.peaks) {
    if (z < (peak.rank < 20 ? 4 : 7)) continue;
    const p = pointIn(peak.lon, peak.lat);
    if (p) {
      features.mountain_peak.push({
        type: 1,
        geometry: [p],
        properties: {class: 'peak', name: peak.name, ele: peak.ele, rank: 1 + Math.floor(peak.rank / 10)}
      });
    }
  }
  for (const water of world.waterNames) {
    if (z < (water.class === 'ocean' ? 0 : water.class === 'sea' ? 2 : 6)) continue;
    const p = pointIn(water.lon, water.lat);
    if (p) features.water_name.push({type: 1, geometry: [p], properties: {class: water.class, name: water.name}});
  }
  return features;
}

/** Rounds a ring to integers and drops it if it has no area. */
function finishRing(ring: Ring): Ring | null {
  const out: Ring = [];
  for (const [x, y] of ring) {
    const p: [number, number] = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  if (out.length < 3) return null;
  let area = 0;
  for (let i = 0, j = out.length - 1; i < out.length; j = i++) area += out[j][0] * out[i][1] - out[i][0] * out[j][1];
  return Math.abs(area) < 2 ? null : out;
}

function finishLine(line: Ring): Ring | null {
  const out: Ring = [];
  for (const [x, y] of line) {
    const p: [number, number] = [Math.round(x), Math.round(y)];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out.length > 1 ? out : null;
}

/** Tile z/x/y of a world as Mapbox Vector Tile bytes. */
export function generateTile(world: World, z: number, x: number, y: number): Uint8Array {
  const features = generateTileFeatures(world, z, x, y);
  const layers: TileLayer[] = SOURCE_LAYERS.map(name => ({name, extent: EXTENT, features: features[name]}));
  return encodeTile(layers);
}

/** The TileJSON of a world source. */
export function getTileJSON(tilesUrl: string) {
  return {
    tilejson: '3.0.0',
    name: 'Generated world',
    tiles: [tilesUrl],
    minzoom: 0,
    maxzoom: MAX_ZOOM,
    bounds: [-180, -85.0511, 180, 85.0511],
    attribution: 'Generated in the browser',
    vector_layers: SOURCE_LAYERS.map(id => ({id, fields: {}}))
  };
}
