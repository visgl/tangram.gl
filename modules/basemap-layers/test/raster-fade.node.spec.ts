// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {describe, expect, test} from 'vitest';
import {getBasemapLayers} from '../src/index.ts';
import {
  RasterFadeExtension,
  RasterFadeTileLayer,
  getFadingAncestor,
  getRasterFadeParent,
  getRasterFadeValues
} from '../src/raster-fade.ts';

/** The tile layer that draws one raster style layer. */
function getRasterLayer(paint?: Record<string, unknown>): any {
  const layers = getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom: 5,
    styleDefinition: {
      version: 8,
      sources: {raster: {type: 'raster', tiles: ['https://tiles.example.com/{z}/{x}/{y}.png']}},
      layers: [{id: 'imagery', type: 'raster', source: 'raster', ...(paint ? {paint} : {})}]
    } as any
  });
  return layers.find(layer => layer.id === 'test-imagery');
}

/** A clock that the test moves by hand. */
function createClock(time = 0) {
  const clock = () => time;
  clock.set = (value: number) => {
    time = value;
  };
  return clock;
}

/** A stub bitmap sublayer that records its fade uniforms and redraw requests. */
function createFadeSublayer(props: Record<string, unknown>, deviceType = 'webgl') {
  const calls = {uniforms: null as any, redraws: 0};
  const layer = {
    context: {device: {type: deviceType}},
    props: {image: 'tile-texture', ...props},
    state: {},
    isLoaded: true,
    setShaderModuleProps: (moduleProps: any) => {
      calls.uniforms = moduleProps.rasterFade;
    },
    setNeedsRedraw: () => {
      calls.redraws++;
    }
  };
  return {layer, calls, draw: () => RasterFadeExtension.prototype.draw.call(layer as any)};
}

describe('getRasterFadeValues', () => {
  test('a tile with an ancestor cross-fades from it, staying opaque', () => {
    expect(getRasterFadeValues(0, 300, true)).toEqual({opacity: 1, mix: 1});
    expect(getRasterFadeValues(75, 300, true)).toEqual({opacity: 1, mix: 0.75});
    expect(getRasterFadeValues(150, 300, true)).toEqual({opacity: 1, mix: 0.5});
    expect(getRasterFadeValues(300, 300, true)).toEqual({opacity: 1, mix: 0});
    expect(getRasterFadeValues(1000, 300, true)).toEqual({opacity: 1, mix: 0});
  });

  test('a tile without an ancestor fades in from transparent', () => {
    expect(getRasterFadeValues(0, 300, false)).toEqual({opacity: 0, mix: 0});
    expect(getRasterFadeValues(75, 300, false)).toEqual({opacity: 0.25, mix: 0});
    expect(getRasterFadeValues(150, 300, false)).toEqual({opacity: 0.5, mix: 0});
    expect(getRasterFadeValues(300, 300, false)).toEqual({opacity: 1, mix: 0});
    // A clock that runs back, as a test's can, does not make the tile more than transparent.
    expect(getRasterFadeValues(-10, 300, false)).toEqual({opacity: 0, mix: 0});
  });

  test('a duration of 0 draws the tile at once', () => {
    expect(getRasterFadeValues(0, 0, true)).toEqual({opacity: 1, mix: 0});
    expect(getRasterFadeValues(0, 0, false)).toEqual({opacity: 1, mix: 0});
  });
});

describe('the ancestor a tile fades from', () => {
  test('the part of the ancestor that covers the tile', () => {
    expect(getRasterFadeParent({x: 5, y: 6, z: 3}, {x: 2, y: 3, z: 2})).toEqual({
      topLeft: [0.5, 0],
      scale: 0.5
    });
    expect(getRasterFadeParent({x: 7, y: 5, z: 3}, {x: 1, y: 1, z: 1})).toEqual({
      topLeft: [0.75, 0.25],
      scale: 0.25
    });
  });

  test('the nearest loaded ancestor, at most 5 levels up', () => {
    const tile = (z: number, parent: any, loaded = true) => ({
      index: {x: 0, y: 0, z},
      parent,
      isLoaded: loaded,
      content: loaded ? {z} : null
    });
    const root = tile(1, null);
    const unloaded = tile(2, root, false);
    expect(getFadingAncestor(tile(3, unloaded) as any)).toBe(root);
    expect(getFadingAncestor(tile(6, unloaded) as any)).toBe(root);
    expect(getFadingAncestor(tile(7, unloaded) as any)).toBeNull();
    expect(getFadingAncestor(tile(3, null) as any)).toBeNull();
  });
});

describe('RasterFadeExtension', () => {
  /** Draws the extension on a stub layer and returns its uniforms and redraw requests. */
  function draw(props: Record<string, unknown>, deviceType = 'webgl') {
    const sublayer = createFadeSublayer(props, deviceType);
    sublayer.draw();
    return sublayer.calls;
  }

  const parent = {topLeft: [0.5, 0], scale: 0.5};

  test('mixes the ancestor in, read from the clock, and redraws until the fade ends', () => {
    const clock = createClock(1000);
    const props = {
      rasterFadeDuration: 300,
      rasterFadeClock: clock,
      rasterFade: {start: 1000, parent},
      rasterFadeParentImage: 'parent-texture'
    };
    const start = draw(props);
    expect(start.uniforms).toEqual({
      parentTopLeft: [0.5, 0],
      parentScale: 0.5,
      parentMix: 1,
      opacity: 1,
      rasterFadeParentTexture: 'parent-texture'
    });
    expect(start.redraws).toBe(1);
    clock.set(1150);
    const middle = draw(props);
    expect(middle.uniforms.parentMix).toBe(0.5);
    expect(middle.redraws).toBe(1);
    clock.set(1300);
    const end = draw(props);
    expect(end.uniforms.parentMix).toBe(0);
    expect(end.uniforms.opacity).toBe(1);
    expect(end.redraws).toBe(0);
  });

  test('asks the tile layer to render again when a cross-fade ends', () => {
    const clock = createClock(1000);
    let updates = 0;
    const props = {
      rasterFadeDuration: 300,
      rasterFadeClock: clock,
      rasterFade: {start: 1000, parent},
      rasterFadeParentImage: 'parent-texture'
    };
    const drawInLayer = (layerProps: Record<string, unknown>) => {
      const layer = {
        context: {device: {type: 'webgl'}},
        props: {image: 'tile-texture', ...layerProps},
        state: {},
        parent: {setNeedsUpdate: () => updates++},
        setShaderModuleProps: () => {},
        setNeedsRedraw: () => {}
      };
      RasterFadeExtension.prototype.draw.call(layer as any);
    };
    drawInLayer(props);
    expect(updates).toBe(0);
    clock.set(1300);
    drawInLayer(props);
    expect(updates).toBe(1);
    // Once the image is gone, nothing is left to release.
    drawInLayer({...props, rasterFade: {start: 1000, parent: null}, rasterFadeParentImage: null});
    expect(updates).toBe(1);
  });

  test('fades a tile without an ancestor in from transparent', () => {
    const clock = createClock(1150);
    const {uniforms, redraws} = draw({
      rasterFadeDuration: 300,
      rasterFadeClock: clock,
      rasterFade: {start: 1000, parent: null}
    });
    expect(uniforms).toMatchObject({parentMix: 0, opacity: 0.5});
    // The tile's own texture fills the unused binding.
    expect(uniforms.rasterFadeParentTexture).toBe('tile-texture');
    expect(redraws).toBe(1);
  });

  test('draws a tile without a fade, or with a duration of 0, at once', () => {
    expect(draw({rasterFadeDuration: 300, rasterFade: null}).uniforms).toMatchObject({
      parentMix: 0,
      opacity: 1
    });
    const zero = draw({
      rasterFadeDuration: 0,
      rasterFadeClock: createClock(1000),
      rasterFade: {start: 1000, parent},
      rasterFadeParentImage: 'parent-texture'
    });
    expect(zero.uniforms).toMatchObject({parentMix: 0, opacity: 1});
    expect(zero.redraws).toBe(0);
  });

  test('has no shader and draws nothing on WebGPU', () => {
    const extension = new RasterFadeExtension();
    expect(extension.getShaders.call({context: {device: {type: 'webgpu'}}} as any)).toEqual({});
    const plugins = (extension.getShaders.call({context: {device: {type: 'webgl'}}} as any) as any)
      .plugins;
    expect(plugins[0].injections[0].glsl).toContain('rasterFade.parentMix');
    expect(draw({rasterFadeDuration: 300, rasterFade: {start: 0, parent}}, 'webgpu').uniforms).toBe(
      null
    );
  });
});

describe('RasterFadeTileLayer', () => {
  /** A tile layer with stub tiles, on a WebGL device. */
  function createLayer(duration: number, clock: () => number, tiles: any[]) {
    const layer = new RasterFadeTileLayer({
      id: 'fade',
      data: 'https://tiles.example.com/{z}/{x}/{y}.png',
      rasterFadeDuration: duration,
      rasterFadeClock: clock
    });
    (layer as any).context = {
      device: {
        type: 'webgl',
        createTexture: (props: {id: string}) => ({
          id: props.id,
          destroyed: false,
          destroy() {
            this.destroyed = true;
          }
        })
      }
    };
    (layer as any).internalState = {};
    (layer as any).state = {tileset: {selectedTiles: tiles}};
    return layer;
  }

  const root = {index: {x: 0, y: 0, z: 0}, parent: null, isLoaded: true, content: 'root-image'};
  const child = (x = 1) => ({
    index: {x, y: 0, z: 1},
    parent: root,
    isLoaded: true,
    content: 'child-image',
    layers: [] as ReturnType<typeof createFadeSublayer>['layer'][]
  });

  /** Attaches a tile's drawing sublayer and starts its fade. */
  function addFadeSublayer(layer: RasterFadeTileLayer, tile: ReturnType<typeof child>) {
    const sublayer = createFadeSublayer({
      ...layer.props,
      ...layer.getSubLayerPropsByTile(tile as any),
      image: tile.content
    });
    tile.layers.push(sublayer.layer);
    return sublayer;
  }

  test('a tile fades from the ancestor loaded when it is first drawn, once', () => {
    const clock = createClock(500);
    const tile = child();
    const layer = createLayer(300, clock, [tile]);
    const props = layer.getSubLayerPropsByTile(tile as any) as any;
    expect(props).toEqual({
      rasterFade: {start: 500, parent: {topLeft: [0.5, 0], scale: 0.5}},
      rasterFadeParentImage: 'root-image'
    });
    clock.set(700);
    // The same object, so that `TileLayer` does not clone the tile's layers at every render.
    expect(layer.getSubLayerPropsByTile(tile as any)).toBe(props);
  });

  test('a tile lets go of the ancestor image when its fade ends', () => {
    const clock = createClock(500);
    const tile = child();
    const layer = createLayer(300, clock, [tile]);
    expect((layer.getSubLayerPropsByTile(tile as any) as any).rasterFadeParentImage).toBe(
      'root-image'
    );
    clock.set(799);
    expect((layer.getSubLayerPropsByTile(tile as any) as any).rasterFadeParentImage).toBe(
      'root-image'
    );
    clock.set(800);
    const done = layer.getSubLayerPropsByTile(tile as any) as any;
    // Not `null`: deck.gl's `image` prop type fails on `null` after an image. The tile's layer
    // takes the tile layer's 1 by 1 texture, and releases the texture of the ancestor's image.
    expect(done).toEqual({
      rasterFade: {start: 500, parent: null},
      rasterFadeParentImage: {id: 'fade-released-parent-image', destroyed: false, destroy: expect.any(Function)}
    });
    // The fade's own record keeps no ancestor image either.
    expect((layer.state as any).tileFades.get(tile)).toBe(done);
    expect(layer.getSubLayerPropsByTile(tile as any)).toBe(done);
    addFadeSublayer(layer, tile).draw();
    expect(layer.isLoaded).toBe(true);
  });

  test('all tiles share one released image, which the tile layer deletes', () => {
    const clock = createClock(500);
    const tiles = [child(0), child(1)];
    const layer = createLayer(300, clock, tiles);
    tiles.forEach(tile => layer.getSubLayerPropsByTile(tile as any));
    clock.set(800);
    const [first, second] = tiles.map(
      tile => (layer.getSubLayerPropsByTile(tile as any) as any).rasterFadeParentImage
    );
    expect(second).toBe(first);
    (layer.state as any).tileset.finalize = () => {};
    layer.finalizeState();
    expect(first.destroyed).toBe(true);
    expect(layer.state.releasedParentImage).toBeUndefined();
  });

  test('finalizeState works before the tile layer is initialized', () => {
    const layer = new RasterFadeTileLayer({id: 'uninitialized'});
    expect(layer.state).toBeUndefined();
    expect(() => layer.finalizeState()).not.toThrow();
  });

  test('a tile without an ancestor keeps a null image to the end of its fade', () => {
    const clock = createClock(500);
    const tile = {...child(), parent: null};
    const layer = createLayer(300, clock, [tile]);
    const props = layer.getSubLayerPropsByTile(tile as any);
    clock.set(800);
    expect(layer.getSubLayerPropsByTile(tile as any)).toBe(props);
    expect((props as any).rasterFadeParentImage).toBeNull();
  });

  test('is loaded once its selected tiles have been drawn faded in', () => {
    const clock = createClock(500);
    const tile = child();
    const otherTile = child(0);
    const layer = createLayer(300, clock, [tile, otherTile]);
    // Neither tile has a fade record yet.
    expect(layer.isLoaded).toBe(true);
    const first = addFadeSublayer(layer, tile);
    const second = addFadeSublayer(layer, otherTile);
    clock.set(799);
    first.draw();
    second.draw();
    expect(layer.isLoaded).toBe(false);
    clock.set(800);
    first.draw();
    expect(layer.isLoaded).toBe(false);
    second.draw();
    expect(layer.isLoaded).toBe(true);
  });

  test('stays loading when the clock reaches the end of a fade between draws', () => {
    const clock = createClock(500);
    const tile = child();
    const layer = createLayer(300, clock, [tile]);
    const sublayer = addFadeSublayer(layer, tile);
    clock.set(750);
    sublayer.draw();
    expect(sublayer.calls.uniforms.parentMix).toBeCloseTo(1 - 250 / 300);
    clock.set(800);
    expect(layer.isLoaded).toBe(false);
    sublayer.draw();
    expect(sublayer.calls.uniforms).toMatchObject({opacity: 1, parentMix: 0});
    expect(layer.isLoaded).toBe(true);
  });

  test('a duration of 0 adds no fade', () => {
    const tile = child();
    const layer = createLayer(0, createClock(500), [tile]);
    expect(layer.getSubLayerPropsByTile(tile as any)).toBeNull();
    expect(layer.isLoaded).toBe(true);
  });
});

describe('raster-fade-duration in a style', () => {
  function renderTile(rasterLayer: any) {
    rasterLayer.context = {device: {type: 'webgl'}};
    return rasterLayer.props.renderSubLayers({
      ...rasterLayer.props,
      ...rasterLayer.getSubLayerProps({id: 'tile'}),
      id: 'test-imagery-tile',
      data: null,
      tile: {index: {x: 0, y: 0, z: 5}, bbox: {west: 0, south: 0, east: 1, north: 1}}
    });
  }

  test("defaults to MapLibre's 300 ms, with the fade on each tile's layer", () => {
    const layer = getRasterLayer();
    expect(layer).toBeInstanceOf(RasterFadeTileLayer);
    expect(layer.props.rasterFadeDuration).toBe(300);
    const tile = renderTile(layer);
    expect(tile.props.extensions.some((e: any) => e instanceof RasterFadeExtension)).toBe(true);
  });

  test('a duration of 0 leaves the tiles without the fade', () => {
    const layer = getRasterLayer({'raster-fade-duration': 0});
    expect(layer.props.rasterFadeDuration).toBe(0);
    const tile = renderTile(layer);
    expect(
      (tile.props.extensions || []).some((e: any) => e instanceof RasterFadeExtension)
    ).toBe(false);
  });
});
