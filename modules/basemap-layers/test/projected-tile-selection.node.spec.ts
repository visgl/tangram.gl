// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, describe, expect, test, vi} from 'vitest';
import {
  _CustomProjectionViewport as CustomProjectionViewport,
  WebMercatorViewport
} from '@deck.gl/core';
import {sharedTile2DDeckAdapter} from '@deck.gl-community/geo-layers';
import {Tileset2D} from '@deck.gl/geo-layers';
import {projectionEngine} from '@math.gl/geospatial/projection';
import {
  DEFAULT_MAX_PROJECTED_TILES,
  DEFAULT_MAX_STRETCH,
  getProjectedTileIndices,
  getProjectedTileZoom,
  type ProjectedTileIndex
} from '../src/projected-tile-selection';
import {
  basemapTilesetAdapter,
  getBasemapTilesetAdapter,
  ProjectedTileLayer,
  ProjectedTileset2D
} from '../src/projected-tileset';
import {
  getMercatorZoom,
  lngLatToMercatorWorld,
  MAX_MERCATOR_LATITUDE,
  mercatorWorldToLngLat,
  type ProjectedViewportLike
} from '../src/projected-viewport';
import {
  CONUS_ALBERS_PROJ,
  createWorldTransverseMercatorCRS
} from '../../../test/projection-reference';

type CRS = ConstructorParameters<typeof CustomProjectionViewport>[0]['crs'];

const WIDTH = 800;
const HEIGHT = 600;
let utm: CRS;
let albers: CRS;
let transverseMercator: CRS;
let southPolar: CRS;

/** EPSG:3031, Antarctic polar stereographic. */
const SOUTH_POLAR_PROJ =
  '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';

beforeAll(async () => {
  utm = await projectionEngine.getCRS('EPSG:32632');
  albers = await projectionEngine.getCRS(CONUS_ALBERS_PROJ);
  // A transverse Mercator projection of the whole world, as an application can supply one.
  transverseMercator = createWorldTransverseMercatorCRS(-99) as unknown as CRS;
  southPolar = await projectionEngine.getCRS(SOUTH_POLAR_PROJ);
});

function createViewport(
  crs: CRS,
  center: number[],
  zoom: number,
  options: {pitch?: number; bearing?: number} = {}
): CustomProjectionViewport {
  return new CustomProjectionViewport({
    crs,
    center: [center[0], center[1], 0],
    zoom,
    width: WIDTH,
    height: HEIGHT,
    ...options
  });
}

const getKey = ({x, y, z}: ProjectedTileIndex) => `${z}/${x}/${y}`;

/** The tile of zoom `z` that holds a longitude/latitude. */
function getTileAt(lngLat: number[], z: number): ProjectedTileIndex {
  // A projection can return a longitude a turn away.
  const longitude = ((((lngLat[0] + 180) % 360) + 360) % 360) - 180;
  const world = lngLatToMercatorWorld([longitude, lngLat[1]]);
  const scale = 2 ** z;
  return {
    x: Math.min(scale - 1, Math.floor((world[0] / 512) * scale)),
    y: Math.min(scale - 1, Math.floor((1 - world[1] / 512) * scale)),
    z
  };
}

/**
 * The tiles of zoom `z` under the pixels of a fine grid over the screen: every tile at least
 * `step` pixels across that the view shows. Pixels that the view does not draw back at their own
 * place show no map (outside the projection's area of use, or above the horizon).
 */
function getTilesUnderScreen(viewport: ProjectedViewportLike, z: number, step = 4): Set<string> {
  const keys = new Set<string>();
  for (let x = 0; x <= viewport.width; x += step) {
    for (let y = 0; y <= viewport.height; y += step) {
      const lngLat = viewport.unproject([x, y]);
      if (!lngLat.every(Number.isFinite) || Math.abs(lngLat[1]) > MAX_MERCATOR_LATITUDE) {
        continue;
      }
      const back = viewport.project([lngLat[0], lngLat[1], 0]);
      // In front of the camera: a pitched view also projects the ground behind it.
      const isInFront = back[2] === undefined || (back[2] >= 0 && back[2] <= 1);
      if (isInFront && Math.abs(back[0] - x) <= 1e-3 && Math.abs(back[1] - y) <= 1e-3) {
        keys.add(getKey(getTileAt(lngLat, z)));
      }
    }
  }
  return keys;
}

/** The length the map plane of a view gives a short step at a position, east or north, per degree. */
function getPlaneScaleAt(viewport: CustomProjectionViewport, lngLat: number[]): number {
  const step = 1e-3;
  const cosLatitude = Math.cos((lngLat[1] * Math.PI) / 180);
  try {
    const origin = viewport.projectPosition([lngLat[0], lngLat[1], 0]);
    const east = viewport.projectPosition([lngLat[0] + step / cosLatitude, lngLat[1], 0]);
    const north = viewport.projectPosition([lngLat[0], lngLat[1] + step, 0]);
    // The longer of the two: a projection that is not conformal stretches one direction more.
    const scale = Math.max(
      Math.hypot(east[0] - origin[0], east[1] - origin[1]),
      Math.hypot(north[0] - origin[0], north[1] - origin[1])
    );
    return Number.isFinite(scale) ? scale / step : Infinity;
  } catch {
    return Infinity;
  }
}

/** How many times the scale at the view center the projection stretches the map at a position. */
function getStretchAt(viewport: CustomProjectionViewport, lngLat: number[]): number {
  const center = viewport.unproject([viewport.width / 2, viewport.height / 2]);
  return getPlaneScaleAt(viewport, lngLat) / getPlaneScaleAt(viewport, center);
}

/**
 * Whether the projection draws a step along the outline of a tile, sampled densely, more than 4
 * times longer than a step at the view center: the outline is stretched, or crosses a seam.
 */
function isOutlineStretched(viewport: CustomProjectionViewport, {x, y, z}: ProjectedTileIndex): boolean {
  const scale = 2 ** z;
  const getPoint = (i: number, j: number) => {
    const lngLat = mercatorWorldToLngLat([(512 * (x + i)) / scale, 512 * (1 - (y + j) / scale)]);
    return [lngLat[0], Math.max(-85, Math.min(85, lngLat[1]))];
  };
  const center = viewport.unproject([viewport.width / 2, viewport.height / 2]);
  const limit = 4 * getPlaneScaleAt(viewport, center);
  const getStepScale = (a: number[], b: number[]) => {
    const arc = Math.hypot((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]);
    try {
      const from = viewport.projectPosition([a[0], a[1], 0]);
      const to = viewport.projectPosition([b[0], b[1], 0]);
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
      return Number.isFinite(length) ? length / arc : Infinity;
    } catch {
      return Infinity;
    }
  };
  for (let step = 0; step < 64; step++) {
    const [t, next] = [step / 64, (step + 1) / 64];
    const sides = [
      [getPoint(t, 0), getPoint(next, 0)],
      [getPoint(1, t), getPoint(1, next)],
      [getPoint(t, 1), getPoint(next, 1)],
      [getPoint(0, t), getPoint(0, next)]
    ];
    if (sides.some(([a, b]) => !(getStepScale(a, b) <= limit))) {
      return true;
    }
  }
  return false;
}

/**
 * The pixels of a grid over the screen that no selected tile holds, although they show a part
 * of the map which the projection hardly stretches, in a tile of the deepest division (`z` + 4)
 * whose outline it does not stretch either.
 */
function getUncoveredPixels(
  viewport: CustomProjectionViewport,
  indices: ProjectedTileIndex[],
  z: number,
  step = 8
): number[][] {
  const keys = new Set(indices.map(getKey));
  const zooms = [...new Set(indices.map(index => index.z))];
  const uncovered: number[][] = [];
  for (let x = 0; x <= viewport.width; x += step) {
    for (let y = 0; y <= viewport.height; y += step) {
      let lngLat: number[];
      let back: number[];
      try {
        lngLat = viewport.unproject([x, y]);
        back = viewport.project([lngLat[0], lngLat[1], 0]);
      } catch {
        continue;
      }
      if (
        !lngLat.every(Number.isFinite) ||
        Math.abs(lngLat[1]) > MAX_MERCATOR_LATITUDE ||
        !(Math.abs(back[0] - x) <= 1e-3 && Math.abs(back[1] - y) <= 1e-3) ||
        !(getStretchAt(viewport, lngLat) < 1.5)
      ) {
        continue;
      }
      if (
        !zooms.some(zoom => keys.has(getKey(getTileAt(lngLat, zoom)))) &&
        !isOutlineStretched(viewport, getTileAt(lngLat, z + 4))
      ) {
        uncovered.push([x, y]);
      }
    }
  }
  return uncovered;
}

/** Whether a dense sample of a tile has a point the view draws on the screen, with a margin. */
function isNearScreen(viewport: ProjectedViewportLike, {x, y, z}: ProjectedTileIndex): boolean {
  const scale = 2 ** z;
  const margin = Math.max(viewport.width, viewport.height) / 4;
  for (let i = 0; i <= 32; i++) {
    for (let j = 0; j <= 32; j++) {
      const lngLat = mercatorWorldToLngLat([
        (512 * (x + i / 32)) / scale,
        512 * (1 - (y + j / 32) / scale)
      ]);
      const [px, py, depth] = viewport.project([lngLat[0], lngLat[1], 0]);
      if (depth !== undefined && !(depth >= 0 && depth <= 1)) {
        continue;
      }
      if (px >= -margin && px <= viewport.width + margin && py >= -margin && py <= viewport.height + margin) {
        return true;
      }
    }
  }
  return false;
}

describe('getProjectedTileIndices', () => {
  test('a south polar view draws out to latitude 60N with a stretch limit of 16', () => {
    const viewport = new CustomProjectionViewport({
      crs: southPolar,
      center: [0, -90, 0],
      zoom: 0,
      width: 1600,
      height: 1600
    });
    const getTop = (options: {maxStretch?: number}) =>
      Math.max(
        ...getProjectedTileIndices(viewport, {z: 0, ...options}).map(
          ({y, z}) => mercatorWorldToLngLat([0, 512 * (1 - y / 2 ** z)])[1]
        )
      );
    // math.gl clamps the projection's positions at latitude 60N.
    expect(getTop({maxStretch: 16})).toBeGreaterThan(59);
    // The default limit, 4, stops where the projection draws the map 4 times larger.
    expect(DEFAULT_MAX_STRETCH).toBe(4);
    expect(getTop({})).toBeLessThan(23);
    expect(getTop({})).toBe(getTop({maxStretch: 4}));
  });

  const cases = [
    {name: 'UTM 32N, city zoom', crs: () => utm, center: [10.5, 48], zoom: 13, z: 12},
    {name: 'UTM 32N, at the zone edge', crs: () => utm, center: [11.95, 60], zoom: 11, z: 10},
    {name: 'UTM 32N, the whole zone', crs: () => utm, center: [9, 42], zoom: 1, z: 3},
    {name: 'UTM 32N, turned and pitched', crs: () => utm, center: [9.2, 47], zoom: 12, z: 11,
      options: {bearing: 40, pitch: 45}},
    // The horizon crosses the screen: the pixels above it show no ground.
    {name: 'UTM 32N, pitched to the horizon', crs: () => utm, center: [9.2, 47], zoom: 14, z: 13,
      options: {bearing: -20, pitch: 80}},
    {name: 'Conus Albers, city zoom', crs: () => albers, center: [-80, 40], zoom: 13, z: 12},
    {name: 'Conus Albers, a continent', crs: () => albers, center: [-96, 38], zoom: 4, z: 4},
    {name: 'Conus Albers, far from the central meridian', crs: () => albers, center: [20, 50],
      zoom: 6, z: 6, options: {bearing: -75}}
  ];

  test.each(cases)('$name: selects each tile the screen shows, and none far from it', ({crs, center, zoom, z, options}) => {
    const viewport = createViewport(crs(), center, zoom, options);
    const indices = getProjectedTileIndices(viewport, {z});
    const keys = new Set(indices.map(getKey));
    expect(keys.size).toBe(indices.length);
    expect(indices.every(index => index.z === z)).toBe(true);
    // Complete: the tile under each pixel of a fine grid is selected.
    const shown = getTilesUnderScreen(viewport, z);
    expect(shown.size).toBeGreaterThan(0);
    expect([...shown].filter(key => !keys.has(key))).toEqual([]);
    // Tight: each selected tile is on the screen or next to it.
    expect(indices.filter(index => !isNearScreen(viewport, index))).toEqual([]);
  });

  test('zooming out to the bounds of the projection and beyond keeps a finite, bounded selection', () => {
    for (const {crs, center} of [{crs: utm, center: [10.5, 48]}, {crs: albers, center: [-80, 40]}]) {
      for (let zoom = 16; zoom >= -4; zoom -= 0.5) {
        const viewport = createViewport(crs, center, zoom);
        const mercatorZoom = getMercatorZoom(viewport);
        expect(Number.isFinite(mercatorZoom)).toBe(true);
        const z = getProjectedTileZoom(viewport, {tileSize: 512, zoomOffset: -0.5, minZoom: 0, maxZoom: 14, extent: [-180, -85, 180, 85]});
        expect(z).not.toBeNull();
        const indices = getProjectedTileIndices(viewport, {z: z!});
        // The view center lies in the projection's area of use, so the view always shows tiles.
        expect(indices.length).toBeGreaterThan(0);
        expect(indices.length).toBeLessThanOrEqual(DEFAULT_MAX_PROJECTED_TILES);
        for (const index of indices) {
          expect(Number.isInteger(index.x) && Number.isInteger(index.y)).toBe(true);
          expect(index.x >= 0 && index.x < 2 ** index.z && index.y >= 0 && index.y < 2 ** index.z).toBe(true);
        }
        // Each part of the screen that the projection draws without much stretch has a tile.
        expect(getUncoveredPixels(viewport, indices, z!)).toEqual([]);
      }
    }
  });

  test('a view zoomed out past what a transverse Mercator projection can draw divides its tiles', () => {
    // The projection has no position on the equator a quarter turn from its central meridian
    // (longitudes -9 and 171), and stretches the map without bound toward those places.
    const viewport = createViewport(transverseMercator, [-92.8, 20], 0.8);
    const indices = getProjectedTileIndices(viewport, {z: 1});
    expect(indices.length).toBeGreaterThan(8);
    expect(indices.length).toBeLessThanOrEqual(DEFAULT_MAX_PROJECTED_TILES);
    // The tiles around the central meridian are drawn, from the zoom selected down to zoom 5.
    expect(indices.every(index => index.z >= 1 && index.z <= 5)).toBe(true);
    expect(Math.max(...indices.map(index => index.z))).toBeGreaterThan(1);
    expect(getUncoveredPixels(viewport, indices, 1)).toEqual([]);
    for (const index of indices) {
      const scale = 2 ** index.z;
      const [west, north] = mercatorWorldToLngLat([(512 * index.x) / scale, 512 * (1 - index.y / scale)]);
      const [east, south] = mercatorWorldToLngLat([(512 * (index.x + 1)) / scale, 512 * (1 - (index.y + 1) / scale)]);
      // No tile holds a place the projection cannot draw.
      for (const longitude of [-9, 171]) {
        expect(west < longitude && east > longitude && south < 0 && north > 0).toBe(false);
      }
      // No tile is stretched: each corner is drawn within a few times the scale at the center.
      for (const corner of [[west, north], [east, north], [east, south], [west, south]]) {
        expect(getStretchAt(viewport, [corner[0], Math.max(-85, Math.min(85, corner[1]))])).toBeLessThan(8);
      }
    }
  });

  test('a view of the whole world in a conic projection leaves out the tiles on its seam', () => {
    // The seam of Conus Albers is the meridian opposite its central meridian: 84 degrees east.
    const viewport = createViewport(albers, [-96, 40], 0);
    const indices = getProjectedTileIndices(viewport, {z: 1});
    expect(indices.length).toBeGreaterThan(8);
    const spans = indices.map(index => {
      const scale = 2 ** index.z;
      return [(index.x / scale) * 360 - 180, ((index.x + 1) / scale) * 360 - 180];
    });
    expect(spans.filter(([west, east]) => west < 84 && east > 84)).toEqual([]);
    // Both sides of the seam are drawn up to the tiles that hold it.
    expect(spans.some(([, east]) => east > 60 && east <= 84)).toBe(true);
    expect(spans.some(([west]) => west >= 84 && west < 110)).toBe(true);
    expect(getUncoveredPixels(viewport, indices, 1)).toEqual([]);
  });

  test('the edge of a polar stereographic view stays in place as the view pans', () => {
    // The tile zoom is held: only the view center moves, from the pole to the edge of the area of
    // use. The projection draws the center a little larger there, and the edge must not follow it.
    const edges = new Set<string>();
    for (let latitude = -90; latitude <= -60; latitude += 1.5) {
      const viewport = new CustomProjectionViewport({
        crs: southPolar,
        center: [30, latitude, 0],
        zoom: 0.5,
        width: 1600,
        height: 1600
      });
      edges.add(getCoveredKeys(getProjectedTileIndices(viewport, {z: 1})).join(' '));
    }
    expect(edges.size).toBe(1);
  });

  test('the edge of a polar stereographic view stays in place as the tile zoom changes', () => {
    const viewport = new CustomProjectionViewport({
      crs: southPolar,
      center: [0, -90, 0],
      zoom: 0.5,
      width: 1600,
      height: 1600
    });
    const edges = [0, 1, 2, 3].map(z => getCoveredKeys(getProjectedTileIndices(viewport, {z})));
    expect(edges[0].length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge).toEqual(edges[0]);
    }
  });

  test('stretched tiles are left out whole at the highest zoom of the source, or past maxTiles', () => {
    const viewport = createViewport(transverseMercator, [-92.8, 20], 0.8);
    const divided = getProjectedTileIndices(viewport, {z: 1});
    const whole = getProjectedTileIndices(viewport, {z: 1, maxZoom: 1});
    expect(whole.every(index => index.z === 1)).toBe(true);
    expect(whole.length).toBeLessThan(4);
    const one = getProjectedTileIndices(viewport, {z: 1, maxZoom: 2});
    expect(Math.max(...one.map(index => index.z))).toBe(2);
    // Fewer tiles than the division makes: the stretched tiles are not divided.
    const capped = getProjectedTileIndices(viewport, {z: 1, maxTiles: divided.length - 1});
    expect(capped.map(getKey).sort()).toEqual(whole.map(getKey).sort());
  });

  test('a view without a map plane does not divide tiles', () => {
    const viewport = createViewport(transverseMercator, [-92.8, 20], 0.8);
    const indices = getProjectedTileIndices(viewportLike(viewport), {z: 1});
    expect(indices.length).toBeGreaterThan(0);
    expect(indices.every(index => index.z === 1)).toBe(true);
  });

  test('a view of the whole UTM zone selects the tiles of the zone, not of the world', () => {
    const viewport = createViewport(utm, [9, 42], 1);
    const indices = getProjectedTileIndices(viewport, {z: 5});
    // Zone 32N spans longitudes 6 to 12 and latitudes 0 to 84: 2 columns and 9 rows at zoom 5.
    expect(new Set(indices.map(index => index.x))).toEqual(new Set([16, 17]));
    expect(Math.min(...indices.map(index => index.y))).toBeLessThanOrEqual(3);
    expect(Math.max(...indices.map(index => index.y))).toBe(15);
  });

  test('a view that shows no part of the area of use of the projection selects no tiles', () => {
    // A view of the ground east of UTM zone 32N: math.gl draws every position of the world on
    // the zone, so no pixel of this screen is drawn back at its own place.
    const viewport = createViewport(utm, [11.9, 48], 12);
    const shifted: ProjectedViewportLike = {
      ...viewportLike(viewport),
      project: lngLat => {
        const [x, y] = viewport.project(lngLat);
        return [x - 5000, y];
      },
      unproject: pixel => viewport.unproject([pixel[0] + 5000, pixel[1]])
    };
    expect(viewport.unproject([5000, 300])[0]).toBeGreaterThan(12.5);
    expect(getProjectedTileIndices(shifted, {z: 11})).toEqual([]);
    // A view without positions at all.
    const blank = {...viewportLike(viewport), project: () => [Number.NaN, Number.NaN], unproject: () => [Number.NaN, Number.NaN]};
    expect(getProjectedTileIndices(blank, {z: 11})).toEqual([]);
  });

  test('a projection that fails far from its area of use still selects the tiles on the screen', () => {
    // A transverse Mercator projection without an area of use has no position a quarter turn from
    // its central meridian, and deck.gl throws when it projects one.
    const viewport = createViewport(utm, [10.5, 48], 3);
    const strict: ProjectedViewportLike = {
      ...viewportLike(viewport),
      project: lngLat => {
        if (Math.abs(lngLat[0] - 9) > 60) throw new Error('assertion failed');
        return viewport.project(lngLat);
      },
      unproject: pixel => {
        if (pixel[0] < 40) throw new Error('assertion failed');
        return viewport.unproject(pixel);
      }
    };
    const indices = getProjectedTileIndices(strict, {z: 4});
    expect(indices.map(getKey).sort()).toEqual(
      getProjectedTileIndices(viewport, {z: 4}).map(getKey).sort()
    );
    expect(indices.length).toBeGreaterThan(0);
    // The zoom of a view whose center pixel fails is the zoom of the view.
    expect(getMercatorZoom({...strict, unproject: () => { throw new Error('assertion failed'); }})).toBe(3);
  });

  test('a tile drawn as a thin band across the screen, between the screen points, is selected', () => {
    // A view that draws the tiles of zoom 4 as bands 20000 pixels wide and 30 pixels high: the
    // band of tile 8/7 crosses the screen from pixel row 4 to 34, with no corner on the screen.
    const [scaleX, scaleY, centerX, centerY] = [625, 0.9375, 270, 288 - 296 / 0.9375];
    const band: ProjectedViewportLike = {
      width: WIDTH,
      height: HEIGHT,
      zoom: 4,
      project: lngLat => {
        const world = lngLatToMercatorWorld(lngLat);
        return [(world[0] - centerX) * scaleX + WIDTH / 2, (centerY - world[1]) * scaleY + HEIGHT / 2];
      },
      unproject: pixel =>
        mercatorWorldToLngLat([(pixel[0] - WIDTH / 2) / scaleX + centerX, centerY - (pixel[1] - HEIGHT / 2) / scaleY])
    };
    const keys = getProjectedTileIndices(band, {z: 4}).map(getKey);
    expect(keys).toContain('4/8/7');
    expect([...getTilesUnderScreen(band, 4)].filter(key => !keys.includes(key))).toEqual([]);
  });

  test('tiles come nearest the view center first', () => {
    const viewport = createViewport(albers, [-80, 40], 13);
    const indices = getProjectedTileIndices(viewport, {z: 13});
    expect(indices.length).toBeGreaterThan(3);
    expect(getKey(indices[0])).toBe(getKey(getTileAt([-80, 40], 13)));
  });

  test('more tiles than maxTiles: the tiles of a lower zoom stand in', () => {
    const viewport = createViewport(albers, [-96, 38], 4);
    const all = getProjectedTileIndices(viewport, {z: 7});
    expect(all.every(index => index.z === 7)).toBe(true);
    const capped = getProjectedTileIndices(viewport, {z: 7, maxTiles: all.length - 1});
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThan(all.length);
    expect(capped.every(index => index.z === 6)).toBe(true);
  });

  test('extent limits the selection', () => {
    const viewport = createViewport(albers, [-80, 40], 13);
    const all = getProjectedTileIndices(viewport, {z: 13});
    const west = getProjectedTileIndices(viewport, {z: 13, extent: [-180, -85, -80, 85]});
    expect(west.length).toBeGreaterThan(0);
    expect(west.length).toBeLessThan(all.length);
    expect(west.every(index => index.x <= getTileAt([-80.0001, 40], 13).x)).toBe(true);
  });

  test('a viewport without a size selects no tiles', () => {
    const viewport = createViewport(utm, [10.5, 48], 13);
    expect(getProjectedTileIndices({...viewportLike(viewport), width: 0}, {z: 12})).toEqual([]);
    expect(getProjectedTileIndices(viewport, {z: Number.NaN})).toEqual([]);
  });
});

/**
 * The points of a grid north of the equator, 1 degree apart, that a selected tile holds: the
 * ground near the edge of a south polar view, which the projection stretches.
 */
function getCoveredKeys(indices: ProjectedTileIndex[]): string[] {
  const keys = new Set(indices.map(getKey));
  const zooms = [...new Set(indices.map(index => index.z))];
  const covered: string[] = [];
  for (let longitude = -179.5; longitude < 180; longitude += 1) {
    for (let latitude = 0.5; latitude < 60; latitude += 1) {
      if (zooms.some(z => keys.has(getKey(getTileAt([longitude, latitude], z))))) {
        covered.push(`${longitude},${latitude}`);
      }
    }
  }
  return covered;
}

function viewportLike(viewport: CustomProjectionViewport): ProjectedViewportLike {
  return {
    width: viewport.width,
    height: viewport.height,
    zoom: viewport.zoom,
    project: lngLat => viewport.project(lngLat),
    unproject: pixel => viewport.unproject(pixel)
  };
}

describe('getProjectedTileZoom', () => {
  test('follows the Web Mercator zoom of the same scale, not the zoom of the view', () => {
    // At latitude 60 a Web Mercator map is twice as large as the ground: one zoom less.
    const viewport = createViewport(utm, [9, 60], 13);
    expect(getMercatorZoom(viewport)).toBeCloseTo(13 + Math.log2(Math.cos((60 * Math.PI) / 180)), 2);
    expect(getProjectedTileZoom(viewport, {tileSize: 512})).toBe(12);
    expect(getProjectedTileZoom(viewport, {tileSize: 256})).toBe(13);
    expect(getProjectedTileZoom(viewport, {tileSize: 512, zoomOffset: -0.5})).toBe(12);
    expect(getProjectedTileZoom(createViewport(utm, [9, 0.5], 13), {tileSize: 512})).toBe(13);
  });

  test('applies the zoom range as deck.gl does', () => {
    const viewport = createViewport(utm, [9, 60], 13);
    expect(getProjectedTileZoom(viewport, {maxZoom: 10})).toBe(10);
    expect(getProjectedTileZoom(viewport, {minZoom: 14})).toBeNull();
    expect(getProjectedTileZoom(viewport, {minZoom: 14, extent: [-180, -85, 180, 85]})).toBe(14);
    expect(getProjectedTileZoom(createViewport(utm, [9, 60], -6), {})).toBe(0);
  });
});

describe('basemapTilesetAdapter', () => {
  const context = {tileSize: 512, zoomOffset: -0.5, minZoom: 0, maxZoom: 14, extent: null};

  test('selects projected tiles in a projected view', () => {
    const viewport = createViewport(utm, [10.5, 48], 13);
    const indices = basemapTilesetAdapter.getTileIndices({...context, viewState: viewport});
    expect(indices).toEqual(getProjectedTileIndices(viewport, {z: 12}));
    expect(basemapTilesetAdapter.getTileIndices({...context, minZoom: 13, viewState: viewport})).toEqual([]);
  });

  test('selects with the stretch limit it is made for', () => {
    const viewport = new CustomProjectionViewport({
      crs: southPolar,
      center: [0, -65, 0],
      zoom: 2,
      width: 1600,
      height: 1600
    });
    const z = getProjectedTileZoom(viewport, context)!;
    const getKeys = (adapter: typeof basemapTilesetAdapter) =>
      adapter.getTileIndices({...context, viewState: viewport}).map(getKey).sort();
    expect(getBasemapTilesetAdapter()).toBe(basemapTilesetAdapter);
    expect(getBasemapTilesetAdapter(16)).toBe(getBasemapTilesetAdapter(16));
    expect(getKeys(getBasemapTilesetAdapter(16))).toEqual(
      getProjectedTileIndices(viewport, {z, maxZoom: 14, maxStretch: 16}).map(getKey).sort()
    );
    expect(getKeys(getBasemapTilesetAdapter(16))).not.toEqual(getKeys(basemapTilesetAdapter));
  });

  test('selects as deck.gl does in a Web Mercator view', () => {
    const viewport = new WebMercatorViewport({longitude: 10.5, latitude: 48, zoom: 12.4, width: WIDTH, height: HEIGHT});
    expect(basemapTilesetAdapter.getTileIndices({...context, viewState: viewport})).toEqual(
      sharedTile2DDeckAdapter.getTileIndices({...context, viewState: viewport})
    );
    expect(basemapTilesetAdapter.getTileBoundingBox({viewState: viewport, tileSize: 512}, {x: 1, y: 1, z: 1})).toEqual(
      sharedTile2DDeckAdapter.getTileBoundingBox({viewState: viewport, tileSize: 512}, {x: 1, y: 1, z: 1})
    );
  });
});

describe('ProjectedTileset2D', () => {
  const createTileset = () =>
    new ProjectedTileset2D({getTileData: () => null, tileSize: 256, maxZoom: 16, minZoom: 0});

  /** Selects the tiles of a view, and waits for their data, here none: a loaded tile is visible. */
  async function loadSelectedTiles(tileset: ProjectedTileset2D, viewport: CustomProjectionViewport) {
    tileset.update(viewport);
    await vi.waitFor(() => {
      expect(tileset.selectedTiles!.every(tile => tile.isLoaded)).toBe(true);
    });
    tileset.update(viewport);
  }

  test('selects projected tiles in a projected view, and does not cull them by the screen box', async () => {
    const tileset = createTileset();
    const viewport = createViewport(albers, [-80, 40], 13);
    await loadSelectedTiles(tileset, viewport);
    const selected = tileset.selectedTiles!.map(tile => getKey(tile.index));
    // 256 pixel tiles: one zoom above the Web Mercator zoom of the view, 12.6, rounded.
    expect(new Set(selected)).toEqual(
      new Set(getProjectedTileIndices(viewport, {z: 14}).map(getKey))
    );
    const cullRect = {x: 0, y: 0, width: WIDTH, height: HEIGHT};
    expect(tileset.selectedTiles!.every(tile => tileset.isTileVisible(tile, cullRect))).toBe(true);
    tileset.finalize();
  });

  test('keeps the tiles of a view whose corners lie outside the projection', async () => {
    // The corners of this screen have no longitude and latitude in the conic projection.
    const tileset = createTileset();
    const viewport = createViewport(albers, [-96, 40], -1);
    expect(viewport.getBounds().every(Number.isFinite)).toBe(false);
    await loadSelectedTiles(tileset, viewport);
    expect(tileset.selectedTiles!.length).toBeGreaterThan(0);
    const cullRect = {x: 0, y: 0, width: WIDTH, height: HEIGHT};
    expect(tileset.selectedTiles!.every(tile => tileset.isTileVisible(tile, cullRect))).toBe(true);
    // `Tileset2D` hides them all: the box of the screen corners has no numbers.
    const isVisible = Tileset2D.prototype.isTileVisible;
    expect(tileset.selectedTiles!.some(tile => isVisible.call(tileset, tile, cullRect))).toBe(false);
    tileset.finalize();
  });

  test('selects with the stretch limit of its options, which ProjectedTileLayer passes', async () => {
    const viewport = new CustomProjectionViewport({
      crs: southPolar,
      center: [0, -65, 0],
      zoom: 2,
      width: 1600,
      height: 1600
    });
    const layer = new ProjectedTileLayer({id: 'raster', data: [], maxStretch: 16});
    const options = (layer as any)._getTilesetOptions();
    expect(options.maxStretch).toBe(16);
    expect(new ProjectedTileLayer({id: 'raster', data: []}).props.maxStretch).toBe(DEFAULT_MAX_STRETCH);
    const tileset = new ProjectedTileset2D({...options, getTileData: () => null, maxZoom: 14});
    await loadSelectedTiles(tileset, viewport);
    const z = getProjectedTileZoom(viewport, {tileSize: 512})!;
    const selected = tileset.selectedTiles!.map(tile => getKey(tile.index)).sort();
    expect(selected).toEqual(
      getProjectedTileIndices(viewport, {z, maxZoom: 14, maxStretch: 16}).map(getKey).sort()
    );
    expect(selected).not.toEqual(getProjectedTileIndices(viewport, {z, maxZoom: 14}).map(getKey).sort());
    tileset.finalize();
  });

  test('selects as Tileset2D does in a Web Mercator view', () => {
    const tileset = createTileset();
    const viewport = new WebMercatorViewport({longitude: -80, latitude: 40, zoom: 12.4, width: WIDTH, height: HEIGHT});
    tileset.update(viewport);
    expect(tileset.selectedTiles!.length).toBeGreaterThan(0);
    expect(tileset.selectedTiles!.every(tile => tile.index.z === 13)).toBe(true);
    tileset.finalize();
  });
});
