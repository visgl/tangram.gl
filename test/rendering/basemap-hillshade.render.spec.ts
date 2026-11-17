// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, type Layer} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {webgpuAdapter} from '@luma.gl/core/webgpu';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {BasemapLayer} from '../../modules/basemap-layers/src/basemap-layer';

declare const __TEST_DEVICE__: 'webgl' | 'webgpu';

/**
 * `hillshade` style layers draw the same on the backend of the test lane as on WebGL, whose
 * shading the basemap-layers reference renders compare with MapLibre GL JS. Each case draws one
 * synthetic DEM tile, at one screen pixel per DEM pixel unless it sets a zoom, on WebGL and on the
 * lane's backend, and compares every pixel.
 */

const SIZE = 256;
/** The DEM tile drawn: 256-pixel tiles of zoom 9 are drawn 256 pixels wide at map zoom 8. */
const TILE = {x: 90, y: 190, z: 9};
const VIEW_ZOOM = 8;
const DEM_URL = 'https://dem.test/{z}/{x}/{y}.png';
const BACKGROUND = [128, 128, 128];

/** The center of `TILE`, so that the tile fills the canvas. */
function getTileCenter(): [number, number] {
  const count = 2 ** TILE.z;
  const longitude = ((TILE.x + 0.5) / count) * 360 - 180;
  const latitude =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (TILE.y + 0.5)) / count))) * 180) / Math.PI;
  return [longitude, latitude];
}

/** Elevations in meters: hills with every aspect, steep enough to use most of the 8-bit slopes. */
function getElevation(x: number, y: number): number {
  const hills = [
    [70, 80, 8000, 26],
    [175, 165, 6000, 20],
    [200, 60, 5000, 16],
    [60, 200, -4000, 22]
  ];
  let elevation = 9000 + 150 * Math.sin((x + 2 * y) / 9);
  for (const [cx, cy, height, radius] of hills) {
    elevation += height * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * radius ** 2));
  }
  return elevation;
}

/** The DEM tile, a terrarium-encoded PNG. */
async function createDemTile(): Promise<Blob> {
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Terrarium: elevation = R * 256 + G + B / 256 - 32768.
      const value = getElevation(x, y) + 32768;
      const index = (y * SIZE + x) * 4;
      image.data[index] = Math.floor(value / 256);
      image.data[index + 1] = Math.floor(value) % 256;
      image.data[index + 2] = Math.floor((value - Math.floor(value)) * 256);
      image.data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.convertToBlob({type: 'image/png'});
}

type HillshadeCase = {
  id: string;
  paint?: Record<string, unknown>;
  bearing?: number;
  /** The map zoom, `VIEW_ZOOM` by default. */
  zoom?: number;
  /**
   * Paint that WebGL must draw differently from `paint`, so that the case can tell the two apart:
   * a backend that ignored the difference would fail it.
   */
  unlike?: Record<string, unknown>;
};

const CASES: HillshadeCase[] = [
  {id: 'default paint'},
  {
    id: 'standard, colored, map-anchored',
    paint: {
      'hillshade-exaggeration': 0.8,
      'hillshade-shadow-color': '#473b24',
      'hillshade-highlight-color': 'rgba(255, 250, 220, 0.8)',
      'hillshade-accent-color': '#5a5a3c',
      'hillshade-illumination-direction': 280,
      'hillshade-illumination-anchor': 'map'
    }
  },
  {id: 'basic', paint: {'hillshade-method': 'basic', 'hillshade-illumination-altitude': 30}},
  {id: 'combined', paint: {'hillshade-method': 'combined', 'hillshade-exaggeration': 0.7}},
  {id: 'igor', paint: {'hillshade-method': 'igor', 'hillshade-illumination-direction': 100}},
  {
    id: 'multidirectional, three lights',
    paint: {
      'hillshade-method': 'multidirectional',
      'hillshade-illumination-direction': [270, 315, 0],
      'hillshade-illumination-altitude': [30, 45],
      'hillshade-highlight-color': ['#ffffff', '#ffeecc', '#ccddff'],
      'hillshade-shadow-color': ['#000000', '#331100', '#001133']
    }
  },
  // Four screen pixels per DEM pixel, so that most samples fall between texel centers, where
  // nearest and linear filtering differ.
  {
    id: 'nearest resampling, magnified',
    paint: {resampling: 'nearest'},
    zoom: VIEW_ZOOM + 2,
    unlike: {resampling: 'linear'}
  },
  // A light anchored to the viewport turns with the map; one anchored to the map does not.
  {id: 'viewport-anchored light, map turned 60°', bearing: 60},
  {
    id: 'map-anchored light, map turned 60°',
    bearing: 60,
    paint: {'hillshade-illumination-anchor': 'map'}
  },
  // Turned to a negative bearing, the light's angle plus a slope's aspect is negative for part of
  // the slopes, where GLSL's `mod` and WGSL's `%` differ.
  {
    id: 'viewport-anchored light, map turned -150°',
    bearing: -150,
    paint: {'hillshade-illumination-direction': 10}
  }
];

/**
 * The most the mean color may differ from WebGL's, per channel, in 0-255, and the most the median
 * pixel may differ, as the sum of its RGB differences: the tolerances of the comparison with
 * MapLibre in `reference-render/hillshade.browser.spec.ts`. Both backends measured 0.
 */
const MEAN_TOLERANCE = 1;
const MEDIAN_PIXEL_TOLERANCE = 1;
/**
 * The most the 99th percentile pixel may differ, in the same units. The backends measured 0: they
 * differ only in a few pixels at the edges of a turned tile, where the triangles are antialiased.
 */
const P99_PIXEL_TOLERANCE = 3;

let deck: Deck<any> | null = null;
let canvas: HTMLCanvasElement | null = null;
let errors: string[] = [];

function release() {
  deck?.finalize();
  deck = null;
  canvas?.remove();
  canvas = null;
}

beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(errors).toEqual([]);
    // luma.gl logs the WebGL-only `depthTest` of every basemap tile layer on WebGPU.
    const diagnostics = await commands.renderingDiagnostics();
    expect(diagnostics.filter(message => !message.includes('Illegal parameter depthTest'))).toEqual(
      []
    );
  } finally {
    errors = [];
    release();
  }
});

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * Draws a hillshade style layer over the DEM tile on `deviceType`, and returns the first frame
 * that stays the same after the tile has loaded and, on WebGPU, after the pipelines compile.
 */
async function render(
  deviceType: 'webgl' | 'webgpu',
  demTile: Blob,
  {paint = {}, bearing = 0, zoom = VIEW_ZOOM}: HillshadeCase
): Promise<ImageData> {
  release();
  const fetches: string[] = [];
  const tileUrl = DEM_URL.replace('{z}', String(TILE.z))
    .replace('{x}', String(TILE.x))
    .replace('{y}', String(TILE.y));
  // Tiles other than `TILE` are empty: tiles without data.
  const fetchTile = async (url: string) => {
    fetches.push(url);
    return new Response(url === tileUrl ? demTile : new Blob([]));
  };
  const style = {
    version: 8,
    sources: {
      dem: {type: 'raster-dem', tiles: [DEM_URL], encoding: 'terrarium', tileSize: 256, maxzoom: 9}
    },
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': `rgb(${BACKGROUND})`}},
      {id: 'hillshade', type: 'hillshade', source: 'dem', paint}
    ]
  };
  const [longitude, latitude] = getTileCenter();
  canvas = document.createElement('canvas');
  canvas.style.cssText = `position: absolute; left: 0; top: 0; width: ${SIZE}px; height: ${SIZE}px;`;
  document.body.append(canvas);
  const target = canvas;
  let frames = 0;
  let drawnOn = '';
  let capture: ((image: string) => void) | null = null;
  const current = new Deck<any>({
    canvas,
    width: SIZE,
    height: SIZE,
    useDevicePixels: false,
    deviceProps: {
      type: deviceType,
      adapters: [webgl2Adapter, webgpuAdapter],
      webgl: {preserveDrawingBuffer: true}
    } as any,
    views: new MapView({id: 'map'}),
    viewState: {longitude, latitude, zoom, pitch: 0, bearing},
    layers: [
      new BasemapLayer({id: 'basemap', mode: 'map', style: style as any, loadOptions: {fetch: fetchTile}})
    ],
    onDeviceInitialized: device => {
      drawnOn = device.type;
    },
    onError: error => {
      errors.push(String(error?.message ?? error));
    },
    onAfterRender: () => {
      frames++;
      if (capture) {
        const resolve = capture;
        capture = null;
        resolve(target.toDataURL('image/png'));
      }
    }
  });
  deck = current;

  const isSettled = () => {
    const drawn = ((current as any).layerManager?.getLayers() ?? []) as Layer[];
    const pipelines = drawn.flatMap(layer => layer.getModels().map(model => model.pipeline));
    for (const pipeline of pipelines.filter(candidate => (candidate as any)?.isErrored)) {
      const message = `Pipeline ${pipeline.id} failed`;
      if (!errors.includes(message)) {
        errors.push(message);
      }
    }
    return (
      frames > 0 &&
      fetches.includes(tileUrl) &&
      drawn.some(layer => layer.id === 'basemap-hillshade') &&
      drawn.every(layer => layer.isLoaded) &&
      // WebGL links a pipeline when it is first drawn, and does not report it as pending.
      (deviceType === 'webgl' || pipelines.every(pipeline => !(pipeline as any)?.isPending))
    );
  };
  const captureFrame = () =>
    new Promise<string>(resolve => {
      capture = resolve;
      current.redraw('capture');
    });

  const start = performance.now();
  let image = '';
  for (;;) {
    if (performance.now() - start > 120_000) {
      throw new Error(`Timed out rendering on ${deviceType}`);
    }
    await wait(50);
    if (!isSettled()) {
      continue;
    }
    const first = await captureFrame();
    await wait(100);
    image = await captureFrame();
    if (image === first) {
      break;
    }
  }
  expect(drawnOn, 'backend drawn on').toBe(deviceType);
  const bitmap = await createImageBitmap(await (await fetch(image)).blob());
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = copy.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, copy.width, copy.height);
}

/** The mean RGB of each frame, and the median and 99th percentile summed RGB differences. */
function compare(reference: ImageData, candidate: ImageData) {
  const sums = [0, 0, 0, 0, 0, 0];
  const differences: number[] = [];
  let shaded = 0;
  for (let index = 0; index < reference.data.length; index += 4) {
    let difference = 0;
    let fromBackground = 0;
    for (let channel = 0; channel < 3; channel++) {
      sums[channel] += reference.data[index + channel];
      sums[channel + 3] += candidate.data[index + channel];
      difference += Math.abs(reference.data[index + channel] - candidate.data[index + channel]);
      fromBackground += Math.abs(reference.data[index + channel] - BACKGROUND[channel]);
    }
    differences.push(difference);
    if (fromBackground > 12) {
      shaded++;
    }
  }
  const count = differences.length;
  differences.sort((a, b) => a - b);
  return {
    reference: sums.slice(0, 3).map(sum => sum / count),
    candidate: sums.slice(3).map(sum => sum / count),
    shadedShare: shaded / count,
    medianDifference: differences[Math.floor(count / 2)],
    p99Difference: differences[Math.floor(count * 0.99)],
    maxDifference: differences[count - 1]
  };
}

/** WebGL's frame, the lane's frame and their difference, amplified 8 times, side by side. */
async function saveComparison(id: string, reference: ImageData, candidate: ImageData) {
  const sheet = new OffscreenCanvas(SIZE * 3, SIZE);
  const context = sheet.getContext('2d')!;
  context.putImageData(reference, 0, 0);
  context.putImageData(candidate, SIZE, 0);
  const difference = new ImageData(SIZE, SIZE);
  for (let index = 0; index < reference.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      difference.data[index + channel] =
        Math.abs(reference.data[index + channel] - candidate.data[index + channel]) * 8;
    }
    difference.data[index + 3] = 255;
  }
  context.putImageData(difference, SIZE * 2, 0);
  const blob = await sheet.convertToBlob({type: 'image/png'});
  const url = await new Promise<string>(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
  await commands.saveRenderingArtifact(`hillshade-${id}`, url);
}

describe(`${__TEST_DEVICE__}: hillshade style layers`, () => {
  let demTile: Blob;
  beforeEach(async () => {
    demTile ??= await createDemTile();
  });

  test.each(CASES)(
    '$id draws as on WebGL',
    async hillshadeCase => {
      const reference = await render('webgl', demTile, hillshadeCase);
      const candidate =
        __TEST_DEVICE__ === 'webgl' ? reference : await render(__TEST_DEVICE__, demTile, hillshadeCase);
      const colors = compare(reference, candidate);
      await saveComparison(hillshadeCase.id, reference, candidate);
      // The reference is shaded over most of the tile, so that an empty frame cannot match it.
      expect(colors.shadedShare, 'share of shaded pixels').toBeGreaterThan(0.3);
      for (let channel = 0; channel < 3; channel++) {
        const offset = Math.abs(colors.candidate[channel] - colors.reference[channel]);
        expect(offset, `mean ${'RGB'[channel]} offset from WebGL`).toBeLessThanOrEqual(
          MEAN_TOLERANCE
        );
      }
      expect(colors.medianDifference, JSON.stringify(colors)).toBeLessThanOrEqual(
        MEDIAN_PIXEL_TOLERANCE
      );
      expect(colors.p99Difference, JSON.stringify(colors)).toBeLessThanOrEqual(P99_PIXEL_TOLERANCE);
      if (hillshadeCase.unlike) {
        const unlike = await render('webgl', demTile, {...hillshadeCase, paint: hillshadeCase.unlike});
        // More than the comparison above accepts, so that the lane's frame cannot pass for both.
        const contrast = compare(reference, unlike);
        expect(contrast.p99Difference, `unlike paint: ${JSON.stringify(contrast)}`).toBeGreaterThan(
          P99_PIXEL_TOLERANCE
        );
      }
    },
    300_000
  );
});
