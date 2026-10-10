// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import FeatureSelection from '../src/selection/selection';
import Texture from '../src/gl/texture';
import WorkerBroker from '../src/utils/worker_broker';
import DataSource from '../src/sources/data_source';
import {RasterSource, RasterTileSource} from '../src/sources/raster';
import Geo from '../src/utils/geo';

function createGL(pixelWriter = () => {}) {
  return {
    COLOR_ATTACHMENT0: 1,
    DEPTH_ATTACHMENT: 2,
    DEPTH_COMPONENT16: 3,
    FRAMEBUFFER: 4,
    RENDERBUFFER: 5,
    RGBA: 6,
    TEXTURE_2D: 7,
    UNSIGNED_BYTE: 8,
    bindFramebuffer: vi.fn(),
    bindRenderbuffer: vi.fn(),
    clearColor: vi.fn(),
    createFramebuffer: vi.fn(() => ({type: 'framebuffer'})),
    createRenderbuffer: vi.fn(() => ({type: 'renderbuffer'})),
    deleteFramebuffer: vi.fn(),
    deleteRenderbuffer: vi.fn(),
    framebufferRenderbuffer: vi.fn(),
    framebufferTexture2D: vi.fn(),
    readPixels: vi.fn((x, y, width, height, format, type, pixels) => pixelWriter(pixels)),
    renderbufferStorage: vi.fn(),
    viewport: vi.fn()
  };
}

describe('feature selection lifecycle', () => {
  let textureCreate;

  beforeEach(() => {
    FeatureSelection.reset();
    textureCreate = vi.spyOn(Texture, 'create').mockReturnValue({
      setData: vi.fn(),
      destroy: vi.fn(),
      texture: {type: 'texture'}
    });
  });

  afterEach(() => {
    textureCreate.mockRestore();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('initializes, binds, locks, and destroys the selection framebuffer', () => {
    const gl = createGL();
    const selection = new FeatureSelection(gl, [], () => true);
    expect(textureCreate).toHaveBeenCalledWith(gl, expect.stringMatching(/^__selection_fbo_\d+$/), {filtering: 'nearest'});
    expect(selection.locked).toBe(true);
    selection.bind();
    expect(gl.viewport).toHaveBeenCalledWith(0, 0, 256, 256);
    expect(gl.clearColor).toHaveBeenCalledWith(0, 0, 0, 1);
    selection.destroy();
    expect(gl.deleteFramebuffer).toHaveBeenCalledTimes(1);
    expect(gl.deleteRenderbuffer).toHaveBeenCalledTimes(1);
    expect(selection.fbo).toBeNull();
  });

  test('validates points and manages pending requests', async () => {
    const selection = new FeatureSelection(createGL(), []);
    await expect(selection.getFeatureAt(null, {radius: null})).resolves.toEqual({
      changed: false,
      feature: null
    });
    await expect(selection.getFeatureAt({x: -1, y: 0}, {radius: null})).resolves.toEqual({
      changed: false,
      feature: null
    });

    const pending = selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: null});
    expect(selection.hasPendingRequests()).toBe(true);
    const request = Object.values(selection.pendingRequests())[0];
    selection.finishRead({id: request.id, feature: {id: 1}});
    await expect(pending).resolves.toMatchObject({changed: true, feature: {id: 1}});
    expect(selection.hasPendingRequests()).toBe(false);

    const canceled = selection.getFeatureAt({x: 0.25, y: 0.25}, {radius: null});
    selection.clearPendingRequests();
    await expect(canceled).rejects.toBeDefined();
  });

  test('reads an empty selection buffer and resolves no feature', async () => {
    vi.useFakeTimers();
    const gl = createGL();
    const selection = new FeatureSelection(gl, []);
    const pending = selection.getFeatureAt({x: 0.5, y: 0.5}, {radius: null});
    selection.read();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({changed: false, feature: undefined});
    expect(gl.readPixels).toHaveBeenCalledTimes(1);
    expect(selection.pendingRequests()).toBeNull();
  });

  test('scans a radius and asks the owning worker for the feature', async () => {
    vi.useFakeTimers();
    const gl = createGL(pixels => {
      pixels[0] = 7;
      pixels[3] = 0;
    });
    const worker = {id: 0};
    const postMessage = vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue({
      id: 0,
      feature: {id: 'road'}
    });
    const selection = new FeatureSelection(gl, [worker]);
    const pending = selection.getFeatureAt(
      {x: 0.5, y: 0.5},
      {radius: {x: 0.02, y: 0.02}}
    );
    selection.read();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({changed: true, feature: {id: 'road'}});
    expect(postMessage).toHaveBeenCalledWith(
      worker,
      'self.getFeatureSelection',
      {id: 0, key: 7}
    );
  });

  test('creates worker-prefixed colors and clears maps by tile or source', () => {
    FeatureSelection.setPrefix(3);
    const tile = {
      coords: {x: 1, y: 2, z: 3},
      generation: 4,
      key: 'tile-a',
      source: 'roads',
      style_z: 3
    };
    const color = FeatureSelection.makeColor(
      {id: 5, properties: {name: 'Broadway'}},
      tile,
      {layer: 'road', layers: ['road'], source: 'roads'}
    );
    expect(color[3]).toBe(3 / 255);
    expect(FeatureSelection.getMapSize()).toBe(1);
    const entry = Object.values(FeatureSelection.map)[0];
    expect(entry.feature).toMatchObject({id: 5, source_layer: 'road', source_name: 'roads'});

    FeatureSelection.clearSource('other');
    expect(FeatureSelection.getMapSize()).toBe(1);
    FeatureSelection.clearTile('tile-a');
    expect(FeatureSelection.getMapSize()).toBe(0);
  });
});

function createRasterTileSource(overrides = {}) {
  const config = {
    id: 'raster',
    name: 'raster',
    type: 'Raster',
    url: 'https://tiles.example/{z}/{x}/{y}.png',
    zooms: [0, 18],
    ...overrides
  };
  const sources = {};
  const source = new RasterTileSource(config, sources);
  sources.raster = source;
  return source;
}

describe('raster tile sources', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('creates tile geometry and stable texture descriptors', async () => {
    const source = createRasterTileSource({filtering: 'nearest', rasters: ['labels']});
    const tile = {
      coords: {x: 1, y: 2, z: 3, key: '1/2/3'},
      source: 'raster'
    };
    await source.load(tile);
    expect(tile.source_data.layers._default.features[0].geometry.type).toBe('Polygon');
    expect(tile.default_winding).toBe('CW');
    expect(tile.rasters).toEqual(['raster', 'labels']);

    const first = await source.tileTexture(tile);
    const second = await source.tileTexture(tile);
    expect(first).toBe(second);
    expect(first).toMatchObject({
      filtering: 'nearest',
      url: 'https://tiles.example/3/1/2.png'
    });
  });

  test('adjusts attached rasters according to relative zoom detail', () => {
    const source = createRasterTileSource();
    const detailed = {name: 'vectors', zoom_bias: -1};
    source.sources.vectors = detailed;
    source.zoom_bias = 1;
    const tile = {coords: {x: 8, y: 8, z: 5, key: '8/8/5'}, source: 'vectors'};
    const adjusted = source.adjustRasterTileZoom(tile);
    expect(adjusted.z).toBeLessThan(tile.coords.z);

    source.zoom_bias = -2;
    detailed.zoom_bias = 0;
    expect(source.adjustRasterTileZoom(tile)).toBeDefined();
  });

  test('selects tiled or bounded raster implementations from the factory', () => {
    const tiled = DataSource.create(
      {id: 'tiles', name: 'tiles', type: 'Raster', url: 'https://x/{z}/{x}/{y}.png'},
      {}
    );
    const image = DataSource.create(
      {
        bounds: [-74.1, 40.6, -73.8, 40.9],
        id: 'image',
        name: 'image',
        type: 'Raster',
        url: 'image.png'
      },
      {}
    );
    expect(tiled).toBeInstanceOf(RasterTileSource);
    expect(image).toBeInstanceOf(RasterSource);
  });

  test('validates mutually exclusive raster image configurations', () => {
    expect(
      () => new RasterSource({id: 'bad', name: 'bad', type: 'Raster', url: 'image.png'}, {})
    ).toThrow(/bounds/);
    expect(
      () =>
        new RasterSource(
          {
            bounds: [0, 0, 1, 1],
            composite: [{bounds: [0, 0, 1, 1], url: 'other.png'}],
            id: 'bad',
            name: 'bad',
            type: 'Raster',
            url: 'image.png'
          },
          {}
        )
    ).toThrow(/either/);
  });

  test('renders intersecting bounded images into a tile canvas', async () => {
    const source = new RasterSource(
      {
        alpha: 0.5,
        bounds: [-180, -85, 180, 85],
        filtering: 'nearest',
        id: 'image',
        max_display_density: 1,
        name: 'image',
        type: 'Raster',
        url: 'image.png'
      },
      {}
    );
    source.sources.image = source;
    const tile = {
      coords: {x: 0, y: 0, z: 0, key: '0/0/0'},
      min: {x: -Geo.half_circumference_meters, y: -Geo.half_circumference_meters},
      source: 'image'
    };
    const drawImage = vi.spyOn(source, 'drawImage').mockResolvedValue();
    const texture = await source.tileTexture(tile, {blend: 'translucent', generation: 2});
    expect(texture.name).toContain('raster-image-');
    expect(texture.element).toBeInstanceOf(HTMLCanvasElement);
    expect(texture.filtering).toBe('nearest');
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  test('draws cached images with alpha and reports tile inclusion', async () => {
    const source = new RasterSource(
      {
        bounds: [-180, -85, 180, 85],
        id: 'image',
        name: 'image',
        type: 'Raster',
        url: 'image.png'
      },
      {}
    );
    const image = document.createElement('canvas');
    const loadImage = vi.spyOn(source, 'loadImage').mockResolvedValue(image);
    const context = {drawImage: vi.fn(), globalAlpha: 0};
    const tile = {
      coords: {x: 0, y: 0, z: 0},
      min: {x: -Geo.half_circumference_meters, y: -Geo.half_circumference_meters}
    };
    await source.drawImage('image.png', source.bounds, 0.25, tile, 1, context);
    await source.drawImage('image.png', source.bounds, 0.25, tile, 1, context);
    expect(loadImage).toHaveBeenCalledTimes(1);
    expect(context.globalAlpha).toBe(0.25);
    expect(context.drawImage).toHaveBeenCalledTimes(2);
    expect(source.includesTile({x: 0, y: 0, z: 0}, 0)).toBe(true);
  });
});
