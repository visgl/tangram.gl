// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, OrthographicView, type Layer} from '@deck.gl/core';
import type {Adapter} from '@luma.gl/core';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {SolidPolygonLayer} from '@deck.gl/layers';
import {getBasemapLayers} from '../src/index';

/**
 * Paint properties drawn by the shader extensions of this module, for one GPU backend. The
 * rendering suite runs them on WebGL and on WebGPU, so that both backends draw MapLibre GL JS's
 * formulas.
 */
export type BackendPaintTestOptions = {
  /** The backend the frames are drawn on. */
  deviceType: 'webgl' | 'webgpu';
  /** The luma.gl adapters deck.gl can create that backend with. */
  adapters: Adapter[];
  /** Keeps the last frame of a test, a PNG data URL, for inspection. */
  saveFrame?: (name: string, image: string) => Promise<void>;
};

// The software GPU of the test lanes draws these frames slowly, WebGPU most of all.
vi.setConfig({testTimeout: 120000});

/** The canvas size, in pixels. */
export const SIZE = 128;

/** A canvas filled with one color per column. */
export function createImage(columns: number[][]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = columns.length;
  canvas.height = 1;
  const context = canvas.getContext('2d')!;
  columns.forEach(([r, g, b], x) => {
    context.fillStyle = `rgb(${r}, ${g}, ${b})`;
    context.fillRect(x, 0, 1, 1);
  });
  return canvas;
}

/** The bitmap layer that a raster style layer draws for one tile covering the whole canvas. */
export function rasterTile(
  paint: Record<string, unknown>,
  image: HTMLCanvasElement,
  deviceType: 'webgl' | 'webgpu'
) {
  const layers = getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom: 5,
    styleDefinition: {
      version: 8,
      sources: {raster: {type: 'raster', tiles: ['https://tiles.example.com/{z}/{x}/{y}.png']}},
      layers: [{id: 'imagery', type: 'raster', source: 'raster', paint}]
    } as any
  });
  const rasterLayer: any = layers.find(layer => layer.id === 'test-imagery');
  const half = SIZE / 2;
  // As in `TileLayer.renderLayers`, the tile receives the layer's props and its sublayer props.
  rasterLayer.context = {device: {type: deviceType}};
  return rasterLayer.props.renderSubLayers({
    ...rasterLayer.props,
    ...rasterLayer.getSubLayerProps({id: 'tile'}),
    id: 'test-imagery-tile',
    data: image,
    tile: {index: {x: 0, y: 0, z: 5}, bbox: {west: -half, south: -half, east: half, north: half}}
  });
}

/** A polygon that covers the whole canvas, in the view's units. */
export function fullCanvasPolygon(color: number[], id = 'background') {
  const half = SIZE / 2;
  return new SolidPolygonLayer({
    id,
    data: [
      [
        [-half, -half],
        [half, -half],
        [half, half],
        [-half, half]
      ]
    ],
    getPolygon: (d: any) => d,
    getFillColor: color as [number, number, number]
  });
}

export function pixel(image: ImageData, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

export function expectColor(actual: number[], expected: number[], tolerance = 2) {
  for (let i = 0; i < 3; i++) {
    expect(
      Math.abs(actual[i] - expected[i]),
      `channel ${i} of [${actual}] against [${expected.map(Math.round)}]`
    ).toBeLessThanOrEqual(tolerance);
  }
}

type RasterPaint = {
  opacity?: number;
  brightnessMin?: number;
  brightnessMax?: number;
  saturation?: number;
  contrast?: number;
  hueRotate?: number;
};

/**
 * An independent port of MapLibre GL JS's raster program and fragment shader: the color it draws
 * for an opaque texel of `color` (0-255), composited on a gray `background` (0-255).
 */
export function referenceRasterColor(
  color: number[],
  paint: RasterPaint,
  background = 255
): number[] {
  const {opacity = 1, brightnessMin = 0, brightnessMax = 1} = paint;
  const {saturation = 0, contrast = 0, hueRotate = 0} = paint;
  const angle = (hueRotate * Math.PI) / 180;
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const w = [(2 * c + 1) / 3, (-Math.sqrt(3) * s - c + 1) / 3, (Math.sqrt(3) * s - c + 1) / 3];
  const saturationFactor = saturation > 0 ? 1 - 1 / (1.001 - saturation) : -saturation;
  const contrastFactor = contrast > 0 ? 1 / (1 - contrast) : 1 + contrast;

  const [r, g, b] = color.map(value => value / 255);
  const dot = (x: number, y: number, z: number) => r * x + g * y + b * z;
  let rgb = [dot(w[0], w[1], w[2]), dot(w[2], w[0], w[1]), dot(w[1], w[2], w[0])];
  const average = (r + g + b) / 3;
  rgb = rgb.map(value => value + (average - value) * saturationFactor);
  rgb = rgb.map(value => (value - 0.5) * contrastFactor + 0.5);
  rgb = rgb.map(value => brightnessMin + (brightnessMax - brightnessMin) * value);
  // Premultiplied output, clamped by the framebuffer, then blended over the background.
  return rgb.map(
    value => Math.min(Math.max(value * opacity, 0), 1) * 255 + background * (1 - opacity)
  );
}

const RASTER_PROPERTY_NAMES: Record<keyof RasterPaint, string> = {
  opacity: 'raster-opacity',
  brightnessMin: 'raster-brightness-min',
  brightnessMax: 'raster-brightness-max',
  saturation: 'raster-saturation',
  contrast: 'raster-contrast',
  hueRotate: 'raster-hue-rotate'
};

/** The color of the raster test image. */
const RASTER_COLOR = [200, 80, 40];

/** Registers the paint tests for one GPU backend. */
export function defineBackendPaintTests({
  deviceType,
  adapters,
  saveFrame
}: BackendPaintTestOptions): void {
  let deck: Deck<any> | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let lastFrame: string | null = null;
  let errors: string[] = [];

  afterEach(async () => {
    try {
      expect(errors).toEqual([]);
    } finally {
      if (lastFrame && saveFrame) {
        await saveFrame(expect.getState().currentTestName ?? 'basemap-paint', lastFrame);
      }
      deck?.finalize();
      deck = null;
      canvas?.remove();
      canvas = null;
      lastFrame = null;
      errors = [];
    }
  });

  const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

  /**
   * Renders layers on a white page and returns the first stable frame after they load and, on
   * WebGPU, after their pipelines compile.
   */
  async function render(
    layers: unknown[],
    view: Record<string, unknown> = {target: [0, 0, 0], zoom: 0}
  ): Promise<ImageData> {
    canvas = document.createElement('canvas');
    canvas.style.cssText = `position: absolute; left: 0; top: 0; width: ${SIZE}px; height: ${SIZE}px;`;
    document.body.append(canvas);
    let frames = 0;
    let capture: ((image: string) => void) | null = null;
    const target = canvas;
    deck = new Deck({
      canvas,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {type: deviceType, adapters, webgl: {preserveDrawingBuffer: true}} as any,
      views: new OrthographicView({id: 'flat'}),
      initialViewState: view as any,
      layers: layers as any,
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
    const current = deck;
    const start = performance.now();
    const isSettled = () => {
      const drawn = ((current as any).layerManager?.getLayers() ?? []) as Layer[];
      const pipelines = drawn.flatMap(layer => layer.getModels().map(model => model.pipeline));
      for (const pipeline of pipelines.filter(candidate => candidate?.isErrored)) {
        const message = `Pipeline ${pipeline.id} failed`;
        if (!errors.includes(message)) {
          errors.push(message);
        }
      }
      return (
        frames > 0 &&
        drawn.length > 0 &&
        drawn.every(layer => layer.isLoaded) &&
        // WebGL links a pipeline when it is first drawn, and does not report it as pending.
        (deviceType === 'webgl' || pipelines.every(pipeline => !pipeline?.isPending))
      );
    };
    const captureFrame = () =>
      new Promise<string>(resolve => {
        capture = resolve;
        current.redraw('capture');
      });
    let image = '';
    for (;;) {
      if (performance.now() - start > 90000) {
        throw new Error('Timed out rendering');
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
    lastFrame = image;
    const bitmap = await createImageBitmap(await (await fetch(image)).blob());
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = copy.getContext('2d')!;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, copy.width, copy.height);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, copy.width, copy.height);
  }

  const center = (image: ImageData) => pixel(image, SIZE / 2, SIZE / 2);

  describe(`${deviceType}: raster color adjustments`, () => {
    const tile = (paint: Record<string, unknown>) =>
      rasterTile(paint, createImage([RASTER_COLOR]), deviceType);

    test('draws the image unchanged by default', async () => {
      expectColor(center(await render([tile({})])), RASTER_COLOR);
    });

    test('raster-saturation -1 draws gray', async () => {
      const gray = (RASTER_COLOR[0] + RASTER_COLOR[1] + RASTER_COLOR[2]) / 3;
      expectColor(center(await render([tile({'raster-saturation': -1})])), [gray, gray, gray]);
    });

    test('raster-hue-rotate 120 turns red to green, green to blue and blue to red', async () => {
      const [r, g, b] = RASTER_COLOR;
      expectColor(center(await render([tile({'raster-hue-rotate': 120})])), [b, r, g]);
    });

    test.each<[string, RasterPaint]>([
      ['brightness', {brightnessMin: 0.2, brightnessMax: 0.6}],
      ['positive saturation', {saturation: 0.6}],
      ['negative saturation', {saturation: -0.4}],
      ['positive contrast', {contrast: 0.5}],
      ['negative contrast', {contrast: -0.5}],
      ['hue rotation', {hueRotate: 47}],
      [
        'all adjustments with opacity',
        {
          opacity: 0.6,
          brightnessMin: 0.1,
          brightnessMax: 0.9,
          saturation: 0.3,
          contrast: 0.4,
          hueRotate: -70
        }
      ]
    ])('matches MapLibre for %s', async (_, paint) => {
      const style: Record<string, number> = {};
      for (const [key, value] of Object.entries(paint)) {
        style[RASTER_PROPERTY_NAMES[key as keyof RasterPaint]] = value;
      }
      expectColor(center(await render([tile(style)])), referenceRasterColor(RASTER_COLOR, paint));
    });

    test('clamps an adjusted color after applying the opacity, as MapLibre does', async () => {
      // Contrast pushes red past 1; at half opacity MapLibre still draws it nearly at full red.
      const image = await render([
        fullCanvasPolygon([0, 0, 0]),
        tile({'raster-opacity': 0.5, 'raster-contrast': 0.8})
      ]);
      expectColor(
        center(image),
        referenceRasterColor(RASTER_COLOR, {opacity: 0.5, contrast: 0.8}, 0)
      );
    });
  });
}
