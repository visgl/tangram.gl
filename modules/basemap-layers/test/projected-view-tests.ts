// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {Deck, _CustomProjectionView as CustomProjectionView, type Layer} from '@deck.gl/core';
import type {Adapter} from '@luma.gl/core';
import {BasemapLayer} from '../src/index';
import {setGeoJsonWorkerEnabled} from '../src/geojson-source';
import {
  CONUS_ALBERS_PROJ,
  getProjectedPixel,
  projectConusAlbers,
  projectUtm32N
} from '../../../test/projection-reference';

/**
 * The tests of `BasemapLayer` in a deck.gl `_CustomProjectionView`, for one GPU backend. The
 * browser suite of this module runs them on WebGL, and the rendering suite on WebGL and WebGPU.
 */
export type ProjectedViewTestOptions = {
  /** The backend the frames are drawn on. */
  deviceType: 'webgl' | 'webgpu';
  /** The luma.gl adapters deck.gl can create that backend with. */
  adapters: Adapter[];
  /** Keeps the last frame of a test, a PNG data URL, for inspection. */
  saveFrame?: (name: string, image: string) => Promise<void>;
};

// The software GPU of the test lanes draws these frames slowly, WebGPU most of all.
vi.setConfig({testTimeout: 120000});

const WIDTH = 512;
const HEIGHT = 384;
/** Raster tiles are drawn by the test, at this address. */
const TILE_URL = 'https://tiles.test/';
const TILE_SIZE = 256;

type Projection = {
  name: string;
  crs: string;
  project: (lngLat: number[]) => [number, number];
  /** A view center away from the central meridian, where the projection turns the map. */
  center: [number, number];
};

const PROJECTIONS: Projection[] = [
  {name: 'UTM zone 32N', crs: 'EPSG:32632', project: projectUtm32N, center: [10.5, 48]},
  {name: 'Conus Albers', crs: CONUS_ALBERS_PROJ, project: projectConusAlbers, center: [-80, 40]}
];

type Harness = {
  deck: Deck<CustomProjectionView>;
  canvas: HTMLCanvasElement;
  errors: string[];
  view: {center: number[]; zoom: number; width: number; height: number};
  setView: (view: {center?: number[]; zoom?: number}) => void;
  render: () => Promise<ImageData>;
  /** The frame `render` last read, as a PNG data URL. */
  getLastFrame: () => string | null;
  destroy: () => void;
};

/** Registers the tests of `BasemapLayer` in a projected view for one GPU backend. */
export function defineProjectedViewTests({
  deviceType: DEVICE_TYPE,
  adapters,
  saveFrame
}: ProjectedViewTestOptions): void {
let harness: Harness | undefined;
const realFetch = globalThis.fetch;

afterEach(async () => {
  try {
    expect(harness?.errors ?? []).toEqual([]);
  } finally {
    if (harness && saveFrame) {
      await saveFrame(
        expect.getState().currentTestName ?? 'basemap-projected',
        harness.getLastFrame() ?? harness.canvas.toDataURL('image/png')
      );
    }
    harness?.destroy();
    harness = undefined;
    globalThis.fetch = realFetch;
  }
});

/** A `BasemapLayer` in a `_CustomProjectionView`, drawn on the backend of the test lane. */
function createHarness(
  projection: Projection,
  style: Record<string, unknown>,
  zoom: number,
  center: number[] = projection.center
): Harness {
  // The tiles are cut in the page, so that a frame does not wait for a worker.
  setGeoJsonWorkerEnabled(false);
  const canvas = document.createElement('canvas');
  canvas.id = 'rendering-fixture';
  canvas.style.cssText = `position: absolute; left: 0; top: 0; width: ${WIDTH}px; height: ${HEIGHT}px;`;
  document.body.append(canvas);
  const errors: string[] = [];
  const view = {center: [...center], zoom, width: WIDTH, height: HEIGHT};
  let capture: ((image: string) => void) | null = null;
  let lastFrame: string | null = null;
  /** Frames drawn, and the count at which the last view change has been drawn. */
  let frames = 0;
  let viewFrame = 1;
  const getViewState = () => ({
    center: [view.center[0], view.center[1], 0] as [number, number, number],
    zoom: view.zoom
  });
  const deck = new Deck<CustomProjectionView>({
    canvas,
    width: WIDTH,
    height: HEIGHT,
    useDevicePixels: false,
    deviceProps: {type: DEVICE_TYPE, adapters},
    views: new CustomProjectionView({id: 'projected', crs: projection.crs}),
    viewState: getViewState(),
    layers: [new BasemapLayer({id: 'basemap', style: style as any, labelPlacementInterval: 0})],
    onError: error => errors.push(String(error?.message ?? error)),
    onAfterRender: () => {
      frames++;
      if (capture) {
        const resolve = capture;
        capture = null;
        resolve(canvas.toDataURL('image/png'));
      }
    }
  });
  const getLayer = () =>
    (deck as any).layerManager?.getLayers({layerIds: ['basemap']})[0] as BasemapLayer | undefined;
  const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
  const start = {time: 0};
  /** Waits until the layers are loaded at several checks in a row, with nothing left to update. */
  const waitUntilLoaded = async (): Promise<void> => {
    // A tile's sublayers and labels come after its data.
    let loadedChecks = 0;
    while (loadedChecks < 6) {
      if (performance.now() - start.time > 90000) {
        const pending = ((deck as any).layerManager?.getLayers() ?? [])
          .filter((layer: any) => !layer.isLoaded)
          .map((layer: any) => layer.id);
        throw new Error(
          `The basemap did not finish loading: ${JSON.stringify({pending, redraw: deck.needsRedraw()})}`
        );
      }
      await wait(50);
      const layer = getLayer();
      const hasSubLayers = Boolean(layer?.getSubLayers().length);
      // The tiles of a new view are selected when the view is drawn.
      const isViewDrawn = frames >= viewFrame;
      // WebGPU compiles a pipeline after its layer is first drawn, and draws nothing until then.
      const pipelines = (((deck as any).layerManager?.getLayers() ?? []) as Layer[]).flatMap(
        drawn => drawn.getModels().map(model => model.pipeline)
      );
      for (const pipeline of pipelines.filter(candidate => candidate.isErrored)) {
        const message = `Pipeline ${pipeline.id} failed`;
        if (!errors.includes(message)) {
          errors.push(message);
        }
      }
      // WebGL links a pipeline when it is first drawn, and does not report it as pending.
      const isCompiled =
        DEVICE_TYPE === 'webgl' || pipelines.every(pipeline => !pipeline.isPending);
      // A loaded tile gets its sublayers at the next update of the layers.
      const needsUpdate = Boolean((deck as any).layerManager?.needsUpdate());
      const isSettled =
        isViewDrawn && isCompiled && !needsUpdate && layer?.isLoaded && hasSubLayers;
      if (isSettled && deck.needsRedraw()) {
        loadedChecks = 0;
      } else if (isSettled) {
        // Draw once more with the compiled pipelines before the frame is read.
        loadedChecks++;
        deck.redraw('settle');
      } else {
        loadedChecks = 0;
      }
    }
  };
  const captureFrame = () =>
    new Promise<string>(resolve => {
      capture = resolve;
      deck.redraw('capture');
    });
  /** The frame of the loaded view: two frames a quarter of a second apart must be the same. */
  const render = async (): Promise<ImageData> => {
    start.time = performance.now();
    let image = '';
    for (;;) {
      await waitUntilLoaded();
      const first = await captureFrame();
      await wait(250);
      await waitUntilLoaded();
      image = await captureFrame();
      if (image === first) {
        break;
      }
    }
    lastFrame = image;
    const bitmap = await createImageBitmap(await (await realFetch(image)).blob());
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = copy.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, copy.width, copy.height);
  };
  return {
    deck,
    canvas,
    errors,
    view,
    setView: next => {
      Object.assign(view, next);
      viewFrame = frames + 1;
      deck.setProps({viewState: getViewState()});
    },
    render,
    getLastFrame: () => lastFrame,
    destroy: () => {
      deck.finalize();
      canvas.remove();
      setGeoJsonWorkerEnabled(true);
    }
  };
}

function getPixel(image: ImageData, x: number, y: number): number[] {
  const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

/** The pixels a test accepts as one of its colors, and their center and bounds. */
function findPixels(image: ImageData, matches: (rgb: number[]) => boolean) {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (matches(getPixel(image, x, y))) {
        count++;
        sumX += x + 0.5;
        sumY += y + 0.5;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + 1);
        maxY = Math.max(maxY, y + 1);
      }
    }
  }
  return {count, center: [sumX / count, sumY / count], minX, minY, maxX, maxY};
}

const isGreen = ([r, g, b]: number[]) => g > 160 && r < 96 && b < 96;
const isRed = ([r, g, b]: number[]) => r > 160 && g < 96 && b < 96;
const isWhite = ([r, g, b]: number[]) => r > 200 && g > 200 && b > 200;
const isYellow = ([r, g, b]: number[]) => r > 180 && g > 180 && b < 90;
const isBackground = ([r, g, b]: number[]) =>
  Math.abs(r - 16) < 12 && Math.abs(g - 32) < 12 && Math.abs(b - 48) < 12;

const BACKGROUND = {id: 'background', type: 'background', paint: {'background-color': '#102030'}};

function createVectorStyle(features: unknown[], layers: unknown[]) {
  return {
    version: 8,
    sources: {shapes: {type: 'geojson', data: {type: 'FeatureCollection', features}}},
    layers: [BACKGROUND, ...layers]
  };
}

/** The area and centroid of a polygon given by its corner pixels. */
function getPolygonCentroid(corners: number[][]): {area: number; center: [number, number]} {
  let area = 0;
  let x = 0;
  let y = 0;
  corners.forEach((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    const cross = corner[0] * next[1] - next[0] * corner[1];
    area += cross;
    x += (corner[0] + next[0]) * cross;
    y += (corner[1] + next[1]) * cross;
  });
  return {area: Math.abs(area) / 2, center: [x / (3 * area), y / (3 * area)]};
}

for (const projection of PROJECTIONS) {
  test(`${DEVICE_TYPE}: ${projection.name} draws a fill and a line at the projected place of each vertex`, async () => {
    const [lng, lat] = projection.center;
    // A quadrilateral off the view center, and a line under it.
    const ring = [[lng - 0.012, lat - 0.004], [lng + 0.006, lat - 0.006], [lng + 0.01, lat + 0.008],
      [lng - 0.008, lat + 0.006]];
    const road = [[lng - 0.015, lat - 0.012], [lng + 0.015, lat - 0.01]];
    harness = createHarness(projection, createVectorStyle([
      {type: 'Feature', properties: {kind: 'land'}, geometry: {type: 'Polygon', coordinates: [[...ring, ring[0]]]}},
      {type: 'Feature', properties: {kind: 'road'}, geometry: {type: 'LineString', coordinates: road}}
    ], [
      {id: 'land', type: 'fill', source: 'shapes', filter: ['==', ['get', 'kind'], 'land'],
        paint: {'fill-color': '#00ff00', 'fill-antialias': false}},
      {id: 'road', type: 'line', source: 'shapes', filter: ['==', ['get', 'kind'], 'road'],
        paint: {'line-color': '#ff0000', 'line-width': 6}}
    ]), 13);
    const image = await harness.render();
    const toPixel = (lngLat: number[]) => getProjectedPixel(projection.project, lngLat, harness!.view);

    // The fill: its center and area, and each corner to a pixel.
    const corners = ring.map(toPixel);
    const expected = getPolygonCentroid(corners);
    const fill = findPixels(image, isGreen);
    expect(Math.abs(fill.center[0] - expected.center[0])).toBeLessThan(1);
    expect(Math.abs(fill.center[1] - expected.center[1])).toBeLessThan(1);
    expect(Math.abs(fill.count - expected.area) / expected.area).toBeLessThan(0.02);
    for (const corner of corners) {
      const dx = expected.center[0] - corner[0];
      const dy = expected.center[1] - corner[1];
      const length = Math.hypot(dx, dy);
      // Along the line to the center: 2 pixels inside the corner is fill, 2 outside is not.
      const inside = [corner[0] + (dx / length) * 2, corner[1] + (dy / length) * 2];
      const outside = [corner[0] - (dx / length) * 2, corner[1] - (dy / length) * 2];
      expect(isGreen(getPixel(image, inside[0] - 0.5, inside[1] - 0.5))).toBe(true);
      expect(isGreen(getPixel(image, outside[0] - 0.5, outside[1] - 0.5))).toBe(false);
    }

    // The line: each of its pixels lies on the segment between its projected ends.
    const [from, to] = road.map(toPixel);
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const along = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
    let count = 0;
    let offsetSum = 0;
    let maxOffset = 0;
    let minAlong = Infinity;
    let maxAlong = -Infinity;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (isRed(getPixel(image, x, y))) {
          const dx = x + 0.5 - from[0];
          const dy = y + 0.5 - from[1];
          const offset = dx * along[1] - dy * along[0];
          count++;
          offsetSum += offset;
          maxOffset = Math.max(maxOffset, Math.abs(offset));
          minAlong = Math.min(minAlong, dx * along[0] + dy * along[1]);
          maxAlong = Math.max(maxAlong, dx * along[0] + dy * along[1]);
        }
      }
    }
    expect(count).toBeGreaterThan(length * 5);
    // The center line to half a pixel, the 6 pixel width, and both ends to a pixel.
    expect(Math.abs(offsetSum / count)).toBeLessThan(0.5);
    expect(maxOffset).toBeLessThan(4.5);
    expect(Math.abs(minAlong)).toBeLessThan(1.5);
    expect(Math.abs(maxAlong - length)).toBeLessThan(1.5);
    expect(isBackground(getPixel(image, 4, 4))).toBe(true);
  });
}

/** The pixel of a longitude/latitude in a Web Mercator tile image. */
function getTilePixel([lng, lat]: number[], x: number, y: number, z: number): [number, number] {
  const scale = 2 ** z;
  const sine = Math.sin((lat * Math.PI) / 180);
  const worldX = (lng + 180) / 360;
  const worldY = 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
  return [(worldX * scale - x) * TILE_SIZE, (worldY * scale - y) * TILE_SIZE];
}

/**
 * Serves raster tiles drawn in the page: grey, with a yellow disc of `radius` meters around each
 * of `markers`. A disc drawn on several tiles joins at their edges only where each tile image is
 * drawn at its own place.
 */
function serveMarkerTiles(markers: number[][], radius: number): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(TILE_URL)) {
      return realFetch(input, init);
    }
    requests.push(url);
    const [z, x, y] = url.slice(TILE_URL.length).replace('.png', '').split('/').map(Number);
    const tile = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const context = tile.getContext('2d')!;
    context.fillStyle = '#606060';
    context.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
    context.fillStyle = '#ffff00';
    for (const marker of markers) {
      const [px, py] = getTilePixel(marker, x, y, z);
      // Web Mercator pixels per meter at the marker.
      const scale = (TILE_SIZE * 2 ** z) / (40075016.6855 * Math.cos((marker[1] * Math.PI) / 180));
      context.beginPath();
      context.arc(px, py, radius * scale, 0, 2 * Math.PI);
      context.fill();
    }
    return new Response(await tile.convertToBlob({type: 'image/png'}), {
      headers: {'content-type': 'image/png'}
    });
  }) as typeof fetch;
  return requests;
}

function createRasterStyle() {
  return {
    version: 8,
    sources: {imagery: {type: 'raster', tiles: [`${TILE_URL}{z}/{x}/{y}.png`], tileSize: TILE_SIZE, maxzoom: 16}},
    layers: [BACKGROUND, {id: 'imagery', type: 'raster', source: 'imagery'}]
  };
}

for (const projection of PROJECTIONS) {
  // At zoom 5 a tile spans 5 degrees of latitude: an image mapped linearly in latitude, and not
  // in Web Mercator y, lies tens of pixels from its place there.
  test.each([{zoom: 13, radius: 150}, {zoom: 5, radius: 40000}])(
    `${DEVICE_TYPE}: ${projection.name} warps raster tiles to their projected place at zoom $zoom`,
    async ({zoom, radius}) => {
      const [lng, lat] = projection.center;
      const span = 0.012 * 2 ** (13 - zoom);
      // Inside UTM zone 32N at both zooms.
      const marker = [lng + span * 0.2, lat + span * 0.6];
      const requests = serveMarkerTiles([marker], radius);
      harness = createHarness(projection, createRasterStyle(), zoom);
      const image = await harness.render();
      expect(requests.length).toBeGreaterThan(0);
      const expected = getProjectedPixel(projection.project, marker, harness.view);
      const disc = findPixels(image, isYellow);
      expect(disc.count).toBeGreaterThan(200);
      expect(Math.abs(disc.center[0] - expected[0])).toBeLessThan(1);
      expect(Math.abs(disc.center[1] - expected[1])).toBeLessThan(1);
      // The tiles cover the part of the screen that the projection draws: all of it, except
      // around UTM zone 32N, 6 degrees wide, at zoom 5.
      const background = findPixels(image, isBackground);
      if (projection.crs === 'EPSG:32632' && zoom === 5) {
        expect(isBackground(getPixel(image, 8, HEIGHT / 2))).toBe(true);
        expect(isBackground(getPixel(image, WIDTH - 8, HEIGHT / 2))).toBe(true);
        expect(isBackground(getPixel(image, WIDTH / 2 - 60, HEIGHT / 2))).toBe(false);
      } else {
        expect(background.count).toBe(0);
      }
    }
  );
}

/** The direction of the long axis of a set of pixels, in degrees counter-clockwise from screen x. */
function getPixelAxisAngle(image: ImageData, matches: (rgb: number[]) => boolean): number {
  const {count, center} = findPixels(image, matches);
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (matches(getPixel(image, x, y))) {
        const dx = x + 0.5 - center[0];
        // Screen y points down.
        const dy = -(y + 0.5 - center[1]);
        xx += dx * dx;
        yy += dy * dy;
        xy += dx * dy;
      }
    }
  }
  return (Math.atan2((2 * xy) / count, (xx - yy) / count) * 90) / Math.PI;
}

for (const projection of PROJECTIONS) {
  test(`${DEVICE_TYPE}: ${projection.name} draws point labels upright at their projected place`, async () => {
    const [lng, lat] = projection.center;
    const place = [lng + 0.006, lat - 0.004];
    harness = createHarness(projection, createVectorStyle([
      {type: 'Feature', properties: {name: 'HHHHHH'}, geometry: {type: 'Point', coordinates: place}}
    ], [
      {id: 'place', type: 'symbol', source: 'shapes',
        layout: {'text-field': ['get', 'name'], 'text-size': 24, 'text-allow-overlap': true},
        paint: {'text-color': '#ffffff'}}
    ]), 13);
    const image = await harness.render();
    const expected = getProjectedPixel(projection.project, place, harness.view);
    const label = findPixels(image, isWhite);
    expect(label.count).toBeGreaterThan(300);
    // Centered on the anchor, to the rounding of the glyph boxes.
    expect(Math.abs((label.minX + label.maxX) / 2 - expected[0])).toBeLessThan(3);
    expect(Math.abs((label.minY + label.maxY) / 2 - expected[1])).toBeLessThan(4);
    // Upright: as tall as its capitals, and level. Turned with the map by the convergence of
    // the conic projection, 10 degrees here, the text is 14 pixels taller.
    expect(label.maxY - label.minY).toBeLessThan(22);
    expect(label.maxX - label.minX).toBeGreaterThan(3 * (label.maxY - label.minY));
    expect(Math.abs(getPixelAxisAngle(image, isWhite))).toBeLessThan(1);
  });

  test(`${DEVICE_TYPE}: ${projection.name} turns labels along a line to the projected line`, async () => {
    const [lng, lat] = projection.center;
    // A line along a parallel: level in Web Mercator, turned by the convergence in the view.
    const road = [[lng - 0.02, lat + 0.004], [lng + 0.02, lat + 0.004]];
    harness = createHarness(projection, createVectorStyle([
      {type: 'Feature', properties: {name: 'HHHHHHHH'}, geometry: {type: 'LineString', coordinates: road}}
    ], [
      {id: 'road-name', type: 'symbol', source: 'shapes',
        layout: {'symbol-placement': 'line-center', 'text-field': ['get', 'name'], 'text-size': 22,
          'text-allow-overlap': true},
        paint: {'text-color': '#ffffff'}}
    ]), 13);
    const image = await harness.render();
    const [from, to] = road.map(point => getProjectedPixel(projection.project, point, harness!.view));
    const expectedAngle = (Math.atan2(-(to[1] - from[1]), to[0] - from[0]) * 180) / Math.PI;
    // The convergence where the views are centered: 1.1 degrees in UTM, 9.6 in the conic.
    expect(Math.abs(expectedAngle)).toBeGreaterThan(1);
    const label = findPixels(image, isWhite);
    expect(label.count).toBeGreaterThan(300);
    expect(Math.abs(getPixelAxisAngle(image, isWhite) - expectedAngle)).toBeLessThan(0.75);
    // On the line, at its middle. Across the line the text is centered to its glyph boxes. Along
    // the line its place also depends on the advances of the font of the platform.
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const along = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
    const dx = label.center[0] - (from[0] + to[0]) / 2;
    const dy = label.center[1] - (from[1] + to[1]) / 2;
    expect(Math.abs(dx * along[1] - dy * along[0])).toBeLessThan(2.5);
    expect(Math.abs(dx * along[0] + dy * along[1])).toBeLessThan(8);
  });

  test(`${DEVICE_TYPE}: ${projection.name} keeps drawing from street zoom out past the bounds of the projection`, {timeout: 180000}, async () => {
    const [lng, lat] = projection.center;
    // Two degrees across: inside UTM zone 32N.
    const ring = [[lng - 1, lat - 1], [lng + 0.4, lat - 1], [lng + 0.4, lat + 1], [lng - 1, lat + 1]];
    harness = createHarness(projection, createVectorStyle([
      {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[...ring, ring[0]]]}}
    ], [{id: 'land', type: 'fill', source: 'shapes', paint: {'fill-color': '#00ff00', 'fill-antialias': false}}]), 15);
    for (const zoom of [15, 11, 8, 6, 4, 2, 0, -2, -4]) {
      harness.setView({zoom});
      const image = await harness.render();
      expect(harness.errors).toEqual([]);
      const viewport = harness.deck.getViewports()[0];
      expect(viewport.zoom).toBe(zoom);
      expect(viewport.project([lng, lat]).every(Number.isFinite)).toBe(true);
      expect(viewport.unproject([WIDTH / 2, HEIGHT / 2]).every(Number.isFinite)).toBe(true);
      // Every pixel is drawn: the fill or the background.
      const fill = findPixels(image, isGreen);
      const background = findPixels(image, isBackground);
      expect(fill.count + background.count).toBeGreaterThan(WIDTH * HEIGHT * 0.995);
      const corners = ring.map(point => getProjectedPixel(projection.project, point, harness!.view));
      const expected = getPolygonCentroid(corners);
      const isOnScreen = corners.every(([x, y]) => x > 2 && x < WIDTH - 2 && y > 2 && y < HEIGHT - 2);
      if (zoom >= 11) {
        // Inside the polygon: all fill.
        expect(fill.count).toBe(WIDTH * HEIGHT);
      } else if (isOnScreen && expected.area > 12) {
        // The whole polygon, at its place. Its edges are chords of parallels and meridians, a
        // fraction of a pixel from them at these zooms.
        expect(Math.abs(fill.center[0] - expected.center[0])).toBeLessThan(1);
        expect(Math.abs(fill.center[1] - expected.center[1])).toBeLessThan(1);
        expect(Math.abs(fill.count - expected.area)).toBeLessThan(Math.max(8, expected.area * 0.03));
      } else if (expected.area < 0.25) {
        // Smaller than a pixel: the background alone, not a blank or a smeared frame.
        expect(background.count).toBeGreaterThan(WIDTH * HEIGHT - 4);
      }
    }
  });
}

/** Serves the requests under `TILE_URL` from the page: `respond` gets the path after it. */
function serveFiles(respond: (path: string) => Promise<Response> | Response | null): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(TILE_URL)) {
      return realFetch(input, init);
    }
    requests.push(url);
    return (await respond(url.slice(TILE_URL.length))) ?? new Response(null, {status: 404});
  }) as typeof fetch;
  return requests;
}

async function toPngResponse(canvas: OffscreenCanvas): Promise<Response> {
  return new Response(await canvas.convertToBlob({type: 'image/png'}), {
    headers: {'content-type': 'image/png'}
  });
}

// WebGL only. On WebGPU these frames show the icon turned the other way, by twice its angle from
// the line; the cause is not isolated. The text of a line label is correct on both backends.
for (const projection of DEVICE_TYPE === 'webgl' ? PROJECTIONS : []) {
  test(`${DEVICE_TYPE}: ${projection.name} turns icons along a line to the projected line`, async () => {
    const [lng, lat] = projection.center;
    // A sprite with one image: a bar four times as long as it is high.
    const requests = serveFiles(path => {
      if (path.startsWith('sprite') && path.endsWith('.json')) {
        return Response.json({bar: {x: 0, y: 0, width: 48, height: 12, pixelRatio: 1}});
      }
      if (path.startsWith('sprite') && path.endsWith('.png')) {
        const sprite = new OffscreenCanvas(48, 12);
        const context = sprite.getContext('2d')!;
        context.fillStyle = '#ffff00';
        context.fillRect(0, 0, 48, 12);
        return toPngResponse(sprite);
      }
      return null;
    });
    const road = [[lng - 0.02, lat - 0.004], [lng + 0.02, lat - 0.004]];
    harness = createHarness(projection, {
      ...createVectorStyle([
        {type: 'Feature', properties: {}, geometry: {type: 'LineString', coordinates: road}}
      ], [
        {id: 'road-shield', type: 'symbol', source: 'shapes',
          layout: {'symbol-placement': 'line-center', 'icon-image': 'bar',
            'icon-rotation-alignment': 'map', 'icon-allow-overlap': true}}
      ]),
      sprite: `${TILE_URL}sprite`
    }, 13);
    const image = await harness.render();
    expect(requests.some(url => url.endsWith('.png'))).toBe(true);
    const [from, to] = road.map(point => getProjectedPixel(projection.project, point, harness!.view));
    const expectedAngle = (Math.atan2(-(to[1] - from[1]), to[0] - from[0]) * 180) / Math.PI;
    const icon = findPixels(image, isYellow);
    // The bar, 48 by 12 pixels, at the middle of the line and along it.
    expect(icon.count).toBeGreaterThan(400);
    expect(icon.count).toBeLessThan(700);
    expect(Math.abs(getPixelAxisAngle(image, isYellow) - expectedAngle)).toBeLessThan(1);
    expect(Math.abs(icon.center[0] - (from[0] + to[0]) / 2)).toBeLessThan(2);
    expect(Math.abs(icon.center[1] - (from[1] + to[1]) / 2)).toBeLessThan(2);
  });
}

test(`${DEVICE_TYPE}: UTM zone 32N shows style layers by the zoom of the Web Mercator map of the same scale`, async () => {
  const projection = PROJECTIONS[0];
  const [lng, lat] = projection.center;
  const ring = [[lng - 0.02, lat - 0.02], [lng + 0.02, lat - 0.02], [lng + 0.02, lat + 0.02],
    [lng - 0.02, lat + 0.02]];
  // One polygon in two style layers: yellow below zoom 12, green from zoom 12.
  harness = createHarness(projection, createVectorStyle([
    {type: 'Feature', properties: {}, geometry: {type: 'Polygon', coordinates: [[...ring, ring[0]]]}}
  ], [
    {id: 'far', type: 'fill', source: 'shapes', maxzoom: 12, paint: {'fill-color': '#ffff00'}},
    {id: 'near', type: 'fill', source: 'shapes', minzoom: 12, paint: {'fill-color': '#00ff00'}}
  ]), 12.5);
  // At latitude 48 a Web Mercator map of this scale has the zoom 12.5 + log2(cos(48)) = 11.92.
  let image = await harness.render();
  expect(findPixels(image, isYellow).count).toBeGreaterThan(5000);
  expect(findPixels(image, isGreen).count).toBe(0);
  // Zoom 12.7 of the view is zoom 12.12 of that map.
  harness.setView({zoom: 12.7});
  image = await harness.render();
  expect(findPixels(image, isGreen).count).toBeGreaterThan(5000);
  expect(findPixels(image, isYellow).count).toBe(0);
});

if (DEVICE_TYPE === 'webgl') {
  // Terrarium elevation tiles of a plane that rises to the east: 20 meters for each kilometer.
  const serveEastwardSlope = () =>
    serveFiles(path => {
      const [z, x] = path.replace('.png', '').split('/').map(Number);
      const tile = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
      const context = tile.getContext('2d')!;
      const pixels = context.createImageData(TILE_SIZE, TILE_SIZE);
      for (let column = 0; column < TILE_SIZE; column++) {
        const longitude = ((x + column / TILE_SIZE) / 2 ** z) * 360 - 180;
        const elevation = 32768 + Math.max(0, Math.min(30000, (longitude - 4) * 1500));
        for (let row = 0; row < TILE_SIZE; row++) {
          const offset = (row * TILE_SIZE + column) * 4;
          pixels.data[offset] = Math.floor(elevation / 256);
          pixels.data[offset + 1] = Math.floor(elevation) % 256;
          pixels.data[offset + 2] = Math.floor((elevation % 1) * 256);
          pixels.data[offset + 3] = 255;
        }
      }
      context.putImageData(pixels, 0, 0);
      return toPngResponse(tile);
    });

  // Hillshade and color-relief layers are drawn on WebGL only.
  test(`${DEVICE_TYPE}: UTM zone 32N draws a hillshade on the tiles of the zone`, async () => {
    const projection = PROJECTIONS[0];
    const requests = serveEastwardSlope();
    harness = createHarness(projection, {
      version: 8,
      sources: {
        dem: {type: 'raster-dem', tiles: [`${TILE_URL}{z}/{x}/{y}.png`], tileSize: TILE_SIZE,
          encoding: 'terrarium', maxzoom: 10}
      },
      layers: [
        BACKGROUND,
        {id: 'relief', type: 'hillshade', source: 'dem',
          paint: {'hillshade-shadow-color': '#ff0000', 'hillshade-highlight-color': '#ff0000',
            'hillshade-accent-color': '#ff0000', 'hillshade-exaggeration': 1}}
      ]
    }, 5);
    const image = await harness.render();
    expect(requests.length).toBeGreaterThan(0);
    // The slope is shaded in the zone, 6 degrees wide: red is added to the background there.
    const isShaded = ([r, g, b]: number[]) => r > 60 && r > g + 30 && r > b + 20;
    const shaded = findPixels(image, isShaded);
    const zoneEdges = [6, 12].map(
      longitude => getProjectedPixel(projection.project, [longitude, 48], harness!.view)[0]
    );
    expect(isShaded(getPixel(image, (zoneEdges[0] + zoneEdges[1]) / 2, HEIGHT / 2))).toBe(true);
    expect(shaded.count).toBeGreaterThan((zoneEdges[1] - zoneEdges[0]) * HEIGHT * 0.8);
    // Each tile image lies in the zone: its west and east edges, at the middle row, to 3 pixels.
    const row = Math.round(HEIGHT / 2);
    const columns = Array.from({length: WIDTH}, (_, x) => x).filter(x => isShaded(getPixel(image, x, row)));
    expect(Math.abs(columns[0] - zoneEdges[0])).toBeLessThan(3);
    expect(Math.abs(columns[columns.length - 1] + 1 - zoneEdges[1])).toBeLessThan(3);
    // Outside the zone the background shows.
    expect(isBackground(getPixel(image, 8, HEIGHT / 2))).toBe(true);
    expect(isBackground(getPixel(image, WIDTH - 8, HEIGHT / 2))).toBe(true);
  });

  test(`${DEVICE_TYPE}: UTM zone 32N colors the elevations of the zone by a ramp`, async () => {
    const projection = PROJECTIONS[0];
    const requests = serveEastwardSlope();
    harness = createHarness(projection, {
      version: 8,
      sources: {
        dem: {type: 'raster-dem', tiles: [`${TILE_URL}{z}/{x}/{y}.png`], tileSize: TILE_SIZE,
          encoding: 'terrarium', maxzoom: 10}
      },
      layers: [
        BACKGROUND,
        {id: 'relief', type: 'color-relief', source: 'dem',
          paint: {'color-relief-color':
            ['interpolate', ['linear'], ['elevation'], 0, '#0000ff', 12000, '#ff0000']}}
      ]
    }, 5);
    const image = await harness.render();
    expect(requests.length).toBeGreaterThan(0);
    // At 9°E the plane is 7500 meters high: 5/8 of the way from blue to red.
    const middle = getProjectedPixel(projection.project, [9, 48], harness.view);
    const [r, g, b] = getPixel(image, middle[0], middle[1]);
    expect(Math.abs(r - 159)).toBeLessThanOrEqual(8);
    expect(g).toBeLessThanOrEqual(2);
    expect(Math.abs(b - 96)).toBeLessThanOrEqual(8);
    // Red grows to the east across the zone.
    const west = getProjectedPixel(projection.project, [7, 48], harness.view);
    const east = getProjectedPixel(projection.project, [11, 48], harness.view);
    expect(getPixel(image, east[0], east[1])[0]).toBeGreaterThan(getPixel(image, west[0], west[1])[0] + 60);
    // Outside the zone the background shows.
    expect(isBackground(getPixel(image, 8, HEIGHT / 2))).toBe(true);
    expect(isBackground(getPixel(image, WIDTH - 8, HEIGHT / 2))).toBe(true);
  });
}
}
