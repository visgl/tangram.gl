// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, OrthographicView, type Layer, type View} from '@deck.gl/core';
import type {Adapter} from '@luma.gl/core';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {SolidPolygonLayer} from '@deck.gl/layers';
import {getBasemapLayers} from '../src/index';
import {
  DEFAULT_FILL_EXTRUSION_LIGHT,
  getFillExtrusionLightDirection
} from '../src/fill-extrusion-lighting-extension';

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

// The software GPU of the test lanes draws these frames slowly, WebGPU most of all, and some tests
// draw several.
vi.setConfig({testTimeout: 300000});

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

/** The props that a tile layer passes to each tile's sublayers. */
const TILE_PROPS = {
  pickable: false,
  visible: true,
  opacity: 1,
  modelMatrix: null,
  coordinateSystem: 'default',
  coordinateOrigin: [0, 0, 0],
  extensions: [],
  highlightedObjectIndex: -1,
  highlightColor: [0, 0, 128, 128],
  wrapLongitude: false
};

/** The sublayers that a vector style layer draws for one tile of `features`. */
export function vectorTile(
  styleLayer: Record<string, unknown>,
  features: unknown[],
  deviceType: 'webgl' | 'webgpu',
  zoom = 5
): any[] {
  const layers = getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom,
    styleDefinition: {
      version: 8,
      sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
      layers: [{id: 'style', source: 'tiles', ...styleLayer}]
    } as any
  });
  const vectorLayer: any = layers.find(layer => layer.id === 'test-tiles');
  vectorLayer.context = {device: {type: deviceType}};
  return vectorLayer.props.renderSubLayers({
    ...TILE_PROPS,
    id: 'test-tiles-tile',
    data: features,
    tile: {index: {x: 0, y: 0, z: 5}}
  });
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

/** The view and view state a frame is drawn with: an orthographic view of the origin by default. */
export type RenderView = {
  view?: View;
  viewState?: Record<string, unknown>;
};

/**
 * Returns a function that draws layers on the backend of `options`, and registers the clean-up
 * of each test: the frame's errors must be empty, and the last frame is kept.
 */
export function createBackendRenderer({deviceType, adapters, saveFrame}: BackendPaintTestOptions) {
  let deck: Deck<any> | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let lastFrame: string | null = null;
  let errors: string[] = [];

  const release = () => {
    deck?.finalize();
    deck = null;
    canvas?.remove();
    canvas = null;
  };

  afterEach(async () => {
    try {
      expect(errors).toEqual([]);
    } finally {
      if (lastFrame && saveFrame) {
        await saveFrame(expect.getState().currentTestName ?? 'basemap-paint', lastFrame);
      }
      release();
      lastFrame = null;
      errors = [];
    }
  });

  const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

  /**
   * Renders layers on a white page and returns the first stable frame after they load and, on
   * WebGPU, after their pipelines compile. The layers of an earlier call are released.
   */
  return async function render(
    layers: unknown[],
    {
      view = new OrthographicView({id: 'flat'}),
      viewState = {target: [0, 0, 0], zoom: 0}
    }: RenderView = {}
  ): Promise<ImageData> {
    release();
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
      views: view,
      initialViewState: viewState as any,
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
      if (performance.now() - start > 120000) {
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
  };
}

/** Registers the paint tests for one GPU backend. */
export function defineBackendPaintTests(options: BackendPaintTestOptions): void {
  const {deviceType} = options;
  const render = createBackendRenderer(options);

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

  describe(`${deviceType}: circle-blur`, () => {
    const point = {type: 'Feature', geometry: {type: 'Point', coordinates: [0, 0]}, properties: {}};
    const circles = (paint: Record<string, unknown>) =>
      vectorTile({type: 'circle', paint: {'circle-color': '#000000', ...paint}}, [point], deviceType);

    /**
     * MapLibre GL JS's circle opacity at the center of the pixel `offset` pixels right of the
     * circle's center (which is on a pixel corner), for a circle of `radius` pixels, stroke
     * included.
     */
    const referenceAlpha = (offset: number, radius: number, blur: number) => {
      const distance = Math.hypot(offset + 0.5, 0.5) / radius;
      const t = Math.min(Math.max((distance - (1 - blur)) / blur, 0), 1);
      return 1 - t * t * (3 - 2 * t);
    };

    /** Checks the pixels right of the center of a black circle drawn over white. */
    const expectFade = (image: ImageData, radius: number, blur: number) => {
      for (let offset = 0; offset < radius - 2; offset += 3) {
        const expected = 255 * (1 - referenceAlpha(offset, radius, blur));
        const actual = pixel(image, SIZE / 2 + offset, SIZE / 2);
        expect(
          Math.abs(actual[0] - expected),
          `${offset} px from the center: ${actual[0]}, against ${expected.toFixed(1)}`
        ).toBeLessThanOrEqual(3);
      }
    };

    test.each([0.25, 0.5, 1])('fades the outer %s of the circle as MapLibre does', async blur => {
      expectFade(await render(circles({'circle-radius': 40, 'circle-blur': blur})), 40, blur);
    });

    test('fades the stroke as part of the circle', async () => {
      const image = await render(
        circles({
          'circle-radius': 28,
          'circle-stroke-width': 12,
          'circle-stroke-color': '#000000',
          'circle-blur': 0.5
        })
      );
      // The circle ends at the outer edge of the stroke, 40 pixels out.
      expectFade(image, 40, 0.5);
    });
  });

  describe(`${deviceType}: fill-extrusion lighting`, () => {
    const ZOOM = 15;
    const COLOR = [192, 128, 96];
    const HEIGHT = 150;
    const SQUARE = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-0.0003, -0.0003],
            [0.0003, -0.0003],
            [0.0003, 0.0003],
            [-0.0003, 0.0003],
            [-0.0003, -0.0003]
          ]
        ]
      },
      properties: {}
    };
    const VIEW: RenderView = {
      view: new MapView({id: 'extrusion-test'}),
      viewState: {longitude: 0, latitude: 0.0008, zoom: ZOOM, pitch: 55, bearing: 30}
    };
    const buildings = (paint: Record<string, unknown> = {}) =>
      vectorTile(
        {
          type: 'fill-extrusion',
          paint: {
            'fill-extrusion-color': `rgb(${COLOR.join(', ')})`,
            'fill-extrusion-height': HEIGHT,
            ...paint
          }
        },
        [SQUARE],
        deviceType,
        ZOOM
      );

    /** The light vector of the style spec's default light, at bearing 30. */
    const LIGHT = getFillExtrusionLightDirection(DEFAULT_FILL_EXTRUSION_LIGHT, 30);

    /** MapLibre GL JS's fill-extrusion color for a face normal and a wall gradient factor. */
    const referenceShade = (normal: number[], gradient = 1): number[] => {
      const {intensity, color: lightColor} = DEFAULT_FILL_EXTRUSION_LIGHT;
      const color = COLOR.map(value => value / 255);
      const colorValue = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
      const angle = Math.min(Math.max(normal.reduce((sum, n, i) => sum + n * LIGHT[i], 0), 0), 1);
      const directional =
        (1 - intensity + (Math.max(1 - colorValue + intensity, 1) - (1 - intensity)) * angle) *
        gradient;
      return color.map((value, i) => {
        const shaded = (value + 0.03) * directional * lightColor[i];
        const low = 0.3 * (1 - lightColor[i]);
        return Math.min(Math.max(shaded, low), 1) * 255;
      });
    };
    const ROOF = [0, 0, 1];
    const WALLS = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0]
    ];

    /** The colors that cover at least `share` of the pixels that are not white. */
    const getFaceColors = (image: ImageData, share = 0.05): number[][] => {
      const counts = new Map<number, number>();
      let total = 0;
      for (let i = 0; i < image.data.length; i += 4) {
        const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
        if (r + g + b < 750) {
          const key = (r << 16) | (g << 8) | b;
          counts.set(key, (counts.get(key) || 0) + 1);
          total++;
        }
      }
      return [...counts]
        .filter(([, count]) => count >= share * total)
        .map(([key]) => [key >> 16, (key >> 8) & 255, key & 255]);
    };
    const isNear = (a: number[], b: number[], tolerance = 2) =>
      a.every((value, i) => Math.abs(value - b[i]) <= tolerance);

    test('shades the roof and walls as MapLibre does, without the vertical gradient', async () => {
      const image = await render(buildings({'fill-extrusion-vertical-gradient': false}), VIEW);
      const expected = [ROOF, ...WALLS].map(normal => referenceShade(normal));
      const faces = getFaceColors(image);
      const message = JSON.stringify({faces, expected: expected.map(c => c.map(Math.round))});
      // The roof and two walls face the camera.
      expect(faces.length, message).toBeGreaterThanOrEqual(3);
      for (const face of faces) {
        expect(
          expected.some(color => isNear(face, color)),
          message
        ).toBe(true);
      }
      expect(
        faces.some(face => isNear(face, referenceShade(ROOF))),
        message
      ).toBe(true);
    });

    test('darkens the walls toward the ground as MapLibre does', async () => {
      const image = await render(buildings(), VIEW);
      // A wall's gradient factor runs from clamp(0, mix(0.7, 0.98, 0.5), 1) = 0.84 at the ground to
      // 1 at the top, for a building on the ground 150 m high.
      const colors = new Set<string>();
      for (let i = 0; i < image.data.length; i += 4) {
        colors.add(`${image.data[i]},${image.data[i + 1]},${image.data[i + 2]}`);
      }
      const isDrawn = (expected: number[], tolerance: number) =>
        [...colors].some(color => isNear(color.split(',').map(Number), expected, tolerance));
      const walls = WALLS.filter(normal => isDrawn(referenceShade(normal), 2));
      const message = JSON.stringify({
        walls,
        bottoms: walls.map(normal => referenceShade(normal, 0.84).map(Math.round))
      });
      // Two walls face the camera. Each shades from its top color down to its bottom color.
      expect(walls.length, message).toBe(2);
      for (const normal of walls) {
        expect(isDrawn(referenceShade(normal, 0.84), 3), message).toBe(true);
      }
    });
  });
}
