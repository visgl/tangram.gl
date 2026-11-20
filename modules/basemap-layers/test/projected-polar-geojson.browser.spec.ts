// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// GeoJSON past the edges of Web Mercator tiles, at +-85.0511 degrees, in a south polar view
// (deck.gl's `_CustomProjectionView`), which shows the latitudes past them. geojson-vt clamps
// them onto the edge: a point at -89.5 degrees would draw on the -85.05 degree parallel.

import {afterEach, expect, test, vi} from 'vitest';
import {Deck, _CustomProjectionView as CustomProjectionView, _GlobeView as GlobeView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {BasemapLayer} from '../src/index';
import {setGeoJsonWorkerEnabled} from '../src/geojson-source';

vi.setConfig({testTimeout: 120000});

const WIDTH = 512;
const HEIGHT = 384;
/** deck.gl's `CustomProjectionViewport` NORMALIZATION_SCALE: 512 common units per this. */
const COMMON_WORLD_METERS = 40075016.6855;
const D = Math.PI / 180;
/** The latitude of the edges of the Web Mercator world. */
const MERCATOR_LATITUDE = Math.atan(Math.sinh(Math.PI)) / D;

type World = {
  name: string;
  crs: string;
  project: (lngLat: number[]) => [number, number];
  zoom: number;
};

/** South polar stereographic on a sphere, k0 = 1 (Snyder 1987, eq. 21-5, 21-6, lat0 = -90). */
const sphereSouthStere = (R: number) => ([lng, lat]: number[]): [number, number] => {
  const rho = 2 * R * Math.tan(Math.PI / 4 + (lat * D) / 2);
  return [rho * Math.sin(lng * D), rho * Math.cos(lng * D)];
};

/**
 * South polar stereographic on an ellipsoid, true scale at `latTs` (Snyder 1987, eq. 15-9,
 * 21-33, 21-34, 21-36, with the signs of the south polar aspect).
 */
const ellipsoidSouthStere = (a: number, f: number, latTs: number) => {
  const e = Math.sqrt(f * (2 - f));
  const t = (phi: number) =>
    Math.tan(Math.PI / 4 - phi / 2) / ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const phiC = -latTs * D;
  const mC = Math.cos(phiC) / Math.sqrt(1 - e * e * Math.sin(phiC) ** 2);
  return ([lng, lat]: number[]): [number, number] => {
    const rho = (a * mC * t(-lat * D)) / t(phiC);
    return [rho * Math.sin(lng * D), rho * Math.cos(lng * D)];
  };
};

const WORLDS: World[] = [
  {
    name: 'Moon south polar stereographic (IAU_2015:30135)',
    crs: '+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1737400 +units=m +no_defs',
    project: sphereSouthStere(1737400),
    // The scale, in degrees per pixel, of zoom 4 on the Earth.
    zoom: 4 + Math.log2(6378137 / 1737400)
  },
  {
    name: 'Earth Antarctic polar stereographic (EPSG:3031)',
    crs: '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    project: ellipsoidSouthStere(6378137, 1 / 298.257223563, -71),
    zoom: 4
  }
];

const CENTER = [0, -90];

function getProjectedPixel(world: World, lngLat: number[]): [number, number] {
  const scale = (2 ** world.zoom * 512) / COMMON_WORLD_METERS;
  const [x, y] = world.project(lngLat);
  const [cx, cy] = world.project(CENTER);
  return [WIDTH / 2 + (x - cx) * scale, HEIGHT / 2 - (y - cy) * scale];
}

let destroy: (() => void) | undefined;
let errors: string[] = [];

afterEach(() => {
  destroy?.();
  destroy = undefined;
  setGeoJsonWorkerEnabled(true);
  expect(errors).toEqual([]);
  errors = [];
});

/**
 * Renders `style` in a projected view of `world`, once its layers have loaded, with GeoJSON cut
 * on the main thread or in the worker.
 */
function render(world: World, style: Record<string, unknown>, worker = false): Promise<ImageData> {
  return renderView(
    new CustomProjectionView({id: 'projected', crs: world.crs}),
    {center: [CENTER[0], CENTER[1], 0], zoom: world.zoom},
    style,
    {worker}
  ).then(({image}) => image);
}

/** Renders `style` in `view`, once its layers have loaded; with the viewport it drew. */
async function renderView(
  view: unknown,
  viewState: Record<string, unknown>,
  style: Record<string, unknown>,
  {worker = false, mode = 'map'}: {worker?: boolean; mode?: 'map' | 'globe'}
): Promise<{image: ImageData; project: (lngLat: number[]) => number[]}> {
  setGeoJsonWorkerEnabled(worker);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position: absolute; left: 0; top: 0; width: ${WIDTH}px; height: ${HEIGHT}px;`;
  document.body.append(canvas);
  let frames = 0;
  const deck = new Deck<any>({
    canvas,
    width: WIDTH,
    height: HEIGHT,
    useDevicePixels: false,
    deviceProps: {type: 'webgl', adapters: [webgl2Adapter]},
    views: view as any,
    viewState,
    layers: [new BasemapLayer({id: 'basemap', style: style as any, labelPlacementInterval: 0, mode})],
    onError: error => errors.push(String(error?.message ?? error)),
    onAfterRender: () => {
      frames++;
    }
  });
  destroy = () => {
    deck.finalize();
    canvas.remove();
  };
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const start = performance.now();
  for (let settled = 0; settled < 6; ) {
    if (performance.now() - start > 90000) throw new Error('The basemap did not finish loading');
    await wait(50);
    const layer = (deck as any).layerManager?.getLayers({layerIds: ['basemap']})[0];
    const loaded =
      frames >= 1 &&
      !(deck as any).layerManager?.needsUpdate() &&
      layer?.isLoaded &&
      layer.getSubLayers().length > 0 &&
      !deck.needsRedraw();
    settled = loaded ? settled + 1 : 0;
    if (loaded) deck.redraw('settle');
  }
  const image = await new Promise<string>(resolve => {
    deck.setProps({onAfterRender: () => resolve(canvas.toDataURL('image/png'))});
    deck.redraw('capture');
  });
  const bitmap = await createImageBitmap(await (await fetch(image)).blob());
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = copy.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  const [viewport] = deck.getViewports();
  return {image: context.getImageData(0, 0, copy.width, copy.height), project: lngLat => viewport.project(lngLat)};
}

/** The pixels of `image` that match, with their center. */
function findPixels(image: ImageData, matches: (rgb: number[]) => boolean) {
  const pixels: number[][] = [];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4;
      if (matches([image.data[offset], image.data[offset + 1], image.data[offset + 2]])) {
        pixels.push([x + 0.5, y + 0.5]);
      }
    }
  }
  const center = [0, 1].map(axis => pixels.reduce((sum, pixel) => sum + pixel[axis], 0) / pixels.length);
  return {pixels, count: pixels.length, center};
}

const countNear = (pixels: number[][], [x, y]: number[], radius: number) =>
  pixels.filter(pixel => Math.hypot(pixel[0] - x, pixel[1] - y) < radius).length;

const isRed = ([r, g, b]: number[]) => r > 200 && g < 60 && b < 60;
const isGreen = ([r, g, b]: number[]) => g > 200 && r < 60 && b < 60;
const isWhite = ([r, g, b]: number[]) => r > 200 && g > 200 && b > 200;

const BACKGROUND = {id: 'background', type: 'background', paint: {'background-color': '#102030'}};

/** Web Mercator y, unclamped, in units of the world's height. */
const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * D) / 2)) / (2 * Math.PI);

/** Where the segment from `a` to `b`, straight in Web Mercator, crosses the south edge. */
function getSouthEdgeCrossing(a: number[], b: number[]): number[] {
  const t = (mercatorY(-MERCATOR_LATITUDE) - mercatorY(a[1])) / (mercatorY(b[1]) - mercatorY(a[1]));
  return [a[0] + t * (b[0] - a[0]), -MERCATOR_LATITUDE];
}

test('reference formulas match PROJ (cs2cs)', () => {
  // `echo "-60 -80" | cs2cs +proj=longlat +datum=WGS84 +to +proj=stere +lat_0=-90 +lat_ts=-71 +datum=WGS84`
  const [x, y] = WORLDS[1].project([-60, -80]);
  expect(x).toBeCloseTo(-943257.078, 1);
  expect(y).toBeCloseTo(544589.728, 1);
  const [, y0] = WORLDS[1].project([0, -83]);
  expect(y0).toBeCloseTo(761476.293, 1);
});

for (const [world, worker] of [[WORLDS[0], false], [WORLDS[1], false], [WORLDS[1], true]] as const) {
  const where = worker ? ', cut in the worker' : '';
  test(`${world.name}: a GeoJSON point past -85.05 degrees is not drawn on that parallel${where}`, async () => {
    const inside = [0, -83];
    const past = [90, -89.5];
    const image = await render(world, {
      version: 8,
      sources: {
        shapes: {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [
              {type: 'Feature', properties: {color: '#ff0000'}, geometry: {type: 'Point', coordinates: inside}},
              {type: 'Feature', properties: {color: '#00ff00'}, geometry: {type: 'Point', coordinates: past}}
            ]
          }
        }
      },
      layers: [
        BACKGROUND,
        {id: 'points', type: 'circle', source: 'shapes', paint: {'circle-color': ['get', 'color'], 'circle-radius': 6}}
      ]
    }, worker);
    // Inside the Web Mercator range: in place.
    const red = findPixels(image, isRed);
    const expected = getProjectedPixel(world, inside);
    expect(red.count).toBeGreaterThan(40);
    expect(Math.hypot(red.center[0] - expected[0], red.center[1] - expected[1])).toBeLessThan(1);
    // Past it: not on the -85.05 degree parallel below it, where geojson-vt clamps it.
    const clamped = getProjectedPixel(world, [past[0], -MERCATOR_LATITUDE]);
    const green = findPixels(image, isGreen);
    expect(countNear(green.pixels, clamped, 10)).toBe(0);
    expect(green.count).toBe(0);
  });
}

test('globe: a GeoJSON point past -85.05 degrees is not drawn on that parallel', async () => {
  // A globe shows the latitudes past the edge of Web Mercator tiles too.
  const inside = [-20, -80];
  const past = [20, -89.5];
  const {image, project} = await renderView(
    new GlobeView({id: 'globe'}),
    {longitude: 0, latitude: -75, zoom: 1},
    {
      version: 8,
      sources: {
        shapes: {
          type: 'geojson',
          data: {
            type: 'FeatureCollection',
            features: [
              {type: 'Feature', properties: {color: '#ff0000'}, geometry: {type: 'Point', coordinates: inside}},
              {type: 'Feature', properties: {color: '#00ff00'}, geometry: {type: 'Point', coordinates: past}}
            ]
          }
        }
      },
      layers: [
        BACKGROUND,
        {id: 'points', type: 'circle', source: 'shapes', paint: {'circle-color': ['get', 'color'], 'circle-radius': 6}}
      ]
    },
    {mode: 'globe'}
  );
  const red = findPixels(image, isRed);
  const expected = project(inside);
  expect(red.count).toBeGreaterThan(40);
  expect(Math.hypot(red.center[0] - expected[0], red.center[1] - expected[1])).toBeLessThan(2);
  const green = findPixels(image, isGreen);
  expect(countNear(green.pixels, project([past[0], -MERCATOR_LATITUDE]), 10)).toBe(0);
  expect(green.count).toBe(0);
});

test('Earth Antarctic polar stereographic (EPSG:3031): a GeoJSON line that crosses -85.05 degrees ends there', async () => {
  const world = WORLDS[1];
  const line = [[-60, -80], [60, -89]];
  const image = await render(world, {
    version: 8,
    sources: {
      shapes: {
        type: 'geojson',
        data: {type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: line}}
      }
    },
    layers: [BACKGROUND, {id: 'line', type: 'line', source: 'shapes', paint: {'line-color': '#ffffff', 'line-width': 3}}]
  });
  const white = findPixels(image, isWhite);
  expect(white.count).toBeGreaterThan(100);
  // It ends where it crosses the parallel, not at 60 degrees east on it, where geojson-vt would
  // move its last vertex, and none of it is drawn poleward of the parallel.
  const end = getProjectedPixel(world, getSouthEdgeCrossing(line[0], line[1]));
  const clamped = getProjectedPixel(world, [60, -MERCATOR_LATITUDE]);
  expect(countNear(white.pixels, end, 4)).toBeGreaterThan(0);
  expect(countNear(white.pixels, clamped, 10)).toBe(0);
  const pole = getProjectedPixel(world, CENTER);
  const edge = Math.hypot(end[0] - pole[0], end[1] - pole[1]);
  expect(countNear(white.pixels, pole, edge - 3)).toBe(0);
});
