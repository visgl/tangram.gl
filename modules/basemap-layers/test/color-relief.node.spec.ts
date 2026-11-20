// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {describe, expect, test} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {BasemapLayer} from '../src/basemap-layer';
import {
  ColorReliefTileLayer,
  createColorRamp,
  getColorRampTexels,
  isColorRampVisible,
  prepareColorReliefTexture,
  quantizeElevation
} from '../src/color-relief-layer';
import {getBasemapLayers, getStyleLayerRuns} from '../src/globe-layers';
import {type DemTile, HillshadeTileLayer, getDemUnpackVector} from '../src/hillshade-layer';

const TERRARIUM = getDemUnpackVector({type: 'raster-dem', encoding: 'terrarium'});
const MAPBOX = getDemUnpackVector({type: 'raster-dem', encoding: 'mapbox'});

/** The elevation of a texel of `prepareColorReliefTexture`, as its shader unpacks it. */
function unpackTexel(texture: Uint8ClampedArray, size: number, column: number, row: number) {
  const index = (row * size + column) * 4;
  return texture[index] * 256 + texture[index + 1] + texture[index + 2] / 256 - 32768;
}

function demOf(dim: number, getElevation: (x: number, y: number) => number): DemTile {
  const elevations = new Float32Array(dim * dim);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      elevations[y * dim + x] = getElevation(x, y);
    }
  }
  return {dim, elevations};
}

describe('color-relief ramp', () => {
  test("an interpolate expression's stops and colors, premultiplied", () => {
    const ramp = createColorRamp(
      [
        'interpolate',
        ['linear'],
        ['elevation'],
        -100,
        'rgba(0, 0, 255, 0.5)',
        0,
        '#000000',
        1000,
        '#ffffff'
      ],
      256
    );
    expect(ramp.elevationStops).toEqual([-100, 0, 1000]);
    expect(ramp.colorStops).toEqual([
      [0, 0, 0.5, 0.5],
      [0, 0, 0, 1],
      [1, 1, 1, 1]
    ]);
    expect(isColorRampVisible(ramp)).toBe(true);
  });

  test('every interpolation type reads its stops: the shader blends them linearly, as MapLibre', () => {
    for (const operator of ['interpolate', 'interpolate-hcl', 'interpolate-lab']) {
      const ramp = createColorRamp(
        [operator, ['exponential', 2], ['elevation'], 0, '#ff0000', 500, '#0000ff'],
        256
      );
      expect(ramp.elevationStops).toEqual([0, 500]);
      expect(ramp.colorStops).toEqual([
        [1, 0, 0, 1],
        [0, 0, 1, 1]
      ]);
    }
  });

  test('a single stop is repeated one meter higher', () => {
    const ramp = createColorRamp(['interpolate', ['linear'], ['elevation'], 10, '#ff0000'], 256);
    expect(ramp.elevationStops).toEqual([10, 11]);
    expect(ramp.colorStops).toEqual([
      [1, 0, 0, 1],
      [1, 0, 0, 1]
    ]);
  });

  test.each([
    ['unset', undefined],
    ['a constant color', '#ff0000'],
    ['a step expression', ['step', ['elevation'], '#000000', 1000, '#ffffff']],
    ['an invalid value', ['interpolate', ['linear'], ['zoom'], 0, '#000000', 10, '#ffffff']]
  ])('%s is transparent, as in MapLibre', (_, value) => {
    const ramp = createColorRamp(value, 256);
    expect(ramp.elevationStops).toEqual([0, 1]);
    expect(ramp.colorStops).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ]);
    expect(isColorRampVisible(ramp)).toBe(false);
  });

  test('a ramp longer than the texture is resampled as MapLibre resamples it', () => {
    const value = ['interpolate', ['linear'], ['elevation']];
    for (let stop = 0; stop <= 4; stop++) {
      value.push(stop * 1000 as any, `rgb(${stop * 50}, 0, 0)` as any);
    }
    expect(createColorRamp(value, 5).elevationStops).toEqual([0, 1000, 2000, 3000, 4000]);
    // MapLibre GL JS's `ColorReliefStyleLayer` test: five stops in four.
    const remapped = createColorRamp(value, 4);
    expect(remapped.elevationStops).toEqual([0, 1000, 3000, 4000]);
    expect(remapped.colorStops.map(color => Math.round(color[0] * 255))).toEqual([0, 50, 150, 200]);
  });

  test('a value edited in place is read again', () => {
    const value: any[] = ['interpolate', ['linear'], ['elevation'], 0, '#000000', 100, '#ffffff'];
    expect(createColorRamp(value, 256).elevationStops).toEqual([0, 100]);
    value[5] = 200;
    expect(createColorRamp(value, 256).elevationStops).toEqual([0, 200]);
  });
});

describe('color-relief shader inputs', () => {
  test("elevation stops are rounded to the DEM encoding's precision, as MapLibre packs them", () => {
    expect(quantizeElevation(123.456, TERRARIUM)).toBe(123 + 117 / 256);
    expect(quantizeElevation(123.456, MAPBOX)).toBeCloseTo(123.5, 9);
    expect(quantizeElevation(-10.04, MAPBOX)).toBeCloseTo(-10, 9);
    expect(quantizeElevation(7, [2, 0, 0, 0])).toBe(8);
    expect(quantizeElevation(5, [0, 0, 0, 3])).toBe(-3);
  });

  test('rounds to the elevation the shader reads, also where factors overlap', () => {
    // The style spec's default custom factors: a pixel [100, 0, 0] is 100 meters.
    expect(quantizeElevation(100, [1, 1, 1, 0])).toBe(100);
    expect(quantizeElevation(100.4, [1, 1, 1, 0])).toBe(100);
    expect(quantizeElevation(700, [1, 1, 1, 0])).toBe(700);
    // Past the most that the three bytes hold, 3 * 255, and below the base.
    expect(quantizeElevation(1000, [1, 1, 1, 0])).toBe(765);
    expect(quantizeElevation(-5, [1, 1, 1, 0])).toBe(0);
    // The shader reads elevations in 1/256 meter steps (see `prepareColorReliefTexture`), and a
    // mapbox pixel of 0.1 meters as 26/256.
    expect(quantizeElevation(0.1, MAPBOX)).toBe(26 / 256);
    const tile = demOf(1, () => 0.1);
    expect(unpackTexel(prepareColorReliefTexture(tile), 3, 1, 1)).toBe(26 / 256);
  });

  test('colors in the first row, premultiplied in 8 bits; elevations in the second', () => {
    const ramp = createColorRamp(
      [
        'interpolate',
        ['linear'],
        ['elevation'],
        0.3,
        'rgba(255, 0, 0, 0.5)',
        100,
        'rgba(10, 200, 30, 1)',
        2000.7,
        'rgba(0, 0, 0, 0)'
      ],
      256
    );
    const texels = getColorRampTexels(ramp, TERRARIUM);
    expect(texels.length).toBe(3 * 2 * 4);
    // 255 at alpha 128/255 is premultiplied to 128.
    expect(Array.from(texels.slice(0, 12))).toEqual([128, 0, 0, 128, 10, 200, 30, 255, 0, 0, 0, 0]);
    // The elevations are encoded as the elevation texture encodes them, terrarium in RGB.
    const elevations = [0, 1, 2].map(stop => {
      const [r, g, b, a] = texels.slice(12 + stop * 4, 16 + stop * 4);
      expect(a).toBe(255);
      return r * 256 + g + b / 256 - 32768;
    });
    expect(elevations).toEqual([77 / 256, 100, 2000 + 179 / 256]);
  });

  test('the elevation texture is the tile in terrarium, with a one-pixel border', () => {
    const dem = demOf(3, (x, y) => -50.5 + x * 10 + y * 1000);
    const texture = prepareColorReliefTexture(dem);
    const size = 5;
    expect(texture.length).toBe(size * size * 4);
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const x = Math.min(Math.max(column - 1, 0), 2);
        const y = Math.min(Math.max(row - 1, 0), 2);
        expect(unpackTexel(texture, size, column, row)).toBe(-50.5 + x * 10 + y * 1000);
        expect(texture[(row * size + column) * 4 + 3]).toBe(255);
      }
    }
  });

  test("the border takes the neighbors' edge pixels", () => {
    const dem = demOf(2, () => 0);
    const east = demOf(2, x => 100 + x);
    const south = demOf(2, (_, y) => 200 + y);
    const texture = prepareColorReliefTexture(dem, (dx, dy) =>
      dx === 1 && dy === 0 ? east : dx === 0 && dy === 1 ? south : null
    );
    expect(unpackTexel(texture, 4, 3, 1)).toBe(100);
    expect(unpackTexel(texture, 4, 1, 3)).toBe(200);
    // A missing neighbor: the nearest edge pixel.
    expect(unpackTexel(texture, 4, 0, 1)).toBe(0);
  });

  test("elevations past terrarium's range are clamped to it", () => {
    const texture = prepareColorReliefTexture(demOf(1, x => (x ? 0 : -40000)));
    expect(unpackTexel(texture, 3, 1, 1)).toBe(-32768);
    const high = prepareColorReliefTexture(demOf(1, () => 1e6));
    expect(unpackTexel(high, 3, 1, 1)).toBe(32768 - 1 / 256);
  });
});

describe('color-relief layers', () => {
  const SOURCES = {
    terrain: {
      type: 'raster-dem',
      tiles: ['https://dem.example.com/{z}/{x}/{y}.png'],
      tileSize: 256,
      encoding: 'terrarium'
    },
    relief: {type: 'raster', tiles: ['https://relief.example.com/{z}/{x}/{y}.png']},
    tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}
  };
  const style = (layers: unknown[], sources: object = SOURCES) =>
    ({version: 8, sources, layers}) as any;
  const RAMP = ['interpolate', ['linear'], ['elevation'], 0, '#000000', 1000, '#ffffff'];

  test('draws in style order between vector layers, with its paint', () => {
    const layers = [
      {id: 'water', type: 'fill', source: 'tiles', 'source-layer': 'water'},
      {
        id: 'relief',
        type: 'color-relief',
        source: 'terrain',
        paint: {
          'color-relief-color': RAMP,
          'color-relief-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.2, 15, 0.8]
        }
      },
      {id: 'roads', type: 'line', source: 'tiles', 'source-layer': 'road'}
    ];
    const runs = getStyleLayerRuns(layers as any, style(layers));
    expect(runs.map(run => [run.type, run.id])).toEqual([
      ['vector', 'tiles'],
      ['color-relief', 'relief'],
      ['vector', 'tiles-"roads"']
    ]);
    const deckLayers = getBasemapLayers({
      idPrefix: 'test',
      mode: 'map',
      zoom: 10,
      styleDefinition: style(layers)
    });
    const relief = deckLayers[1] as any;
    expect(relief).toBeInstanceOf(ColorReliefTileLayer);
    expect(relief.id).toBe('test-relief');
    expect(relief.props.visible).toBe(true);
    expect(relief.props.tileSize).toBe(256);
    expect(relief.props.colorReliefColor).toBe(RAMP);
    expect(relief.props.colorReliefOpacity).toBeCloseTo(0.5, 9);
    expect(relief.props.colorReliefUnpack).toEqual(TERRARIUM);
    expect(relief.props.colorReliefSubLayerProps.textureParameters).toEqual({
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'none'
    });
  });

  test("the ramp's elevations are rounded with the source's encoding", () => {
    const layers = [{id: 'relief', type: 'color-relief', source: 'terrain', paint: {'color-relief-color': RAMP}}];
    const sources = {terrain: {...SOURCES.terrain, encoding: 'mapbox'}};
    const [relief] = getBasemapLayers({styleDefinition: style(layers, sources)}) as any[];
    expect(relief.props.colorReliefUnpack).toEqual(MAPBOX);
  });

  test('resampling: nearest filters the elevations with the nearest texel', () => {
    const layers = [
      {
        id: 'relief',
        type: 'color-relief',
        source: 'terrain',
        paint: {'color-relief-color': RAMP, resampling: 'nearest'}
      }
    ];
    const [relief] = getBasemapLayers({styleDefinition: style(layers)}) as any[];
    expect(relief.props.colorReliefSubLayerProps.textureParameters).toEqual({
      minFilter: 'nearest',
      magFilter: 'nearest',
      mipmapFilter: 'none'
    });
  });

  test.each([
    ['without color-relief-color', {}],
    ['with a step ramp', {'color-relief-color': ['step', ['elevation'], '#000000', 0, '#ffffff']}],
    ['at color-relief-opacity 0', {'color-relief-color': RAMP, 'color-relief-opacity': 0}]
  ])('draws nothing %s, as MapLibre', (_, paint) => {
    const layers = [{id: 'relief', type: 'color-relief', source: 'terrain', paint}];
    const [relief] = getBasemapLayers({styleDefinition: style(layers)}) as any[];
    expect(relief.props.visible).toBe(false);
  });

  test('a color relief over a source that is not raster-dem draws nothing', () => {
    const layers = [{id: 'relief', type: 'color-relief', source: 'relief'}];
    expect(getStyleLayerRuns(layers as any, style(layers))).toEqual([]);
  });

  test("shares the source's decoded tiles with its hillshade layers", () => {
    const layers = [
      {id: 'relief', type: 'color-relief', source: 'terrain', paint: {'color-relief-color': RAMP}},
      {id: 'hills', type: 'hillshade', source: 'terrain'}
    ];
    const [relief, hills] = getBasemapLayers({styleDefinition: style(layers)}) as any[];
    expect(relief).toBeInstanceOf(ColorReliefTileLayer);
    expect(hills).toBeInstanceOf(HillshadeTileLayer);
    expect(relief.props.data).toBe(hills.props.data);
    expect(relief.props.demTilesetOwner).toBe(hills.props.demTilesetOwner);
    for (const layer of [relief, hills]) {
      layer.context = {viewport: new WebMercatorViewport({width: 64, height: 64})} as any;
      layer.initializeState();
    }
    relief.finalizeState();
    hills.finalizeState();
  });

  test('a basemap draws its color-relief layers from the tileset it owns', () => {
    const layers = [{id: 'relief', type: 'color-relief', source: 'terrain', paint: {'color-relief-color': RAMP}}];
    const definition = style(layers);
    const basemap = new BasemapLayer({id: 'test', style: definition});
    basemap.initializeState();
    basemap.state.resolvedStyle = definition;
    basemap.context = {viewport: new WebMercatorViewport({width: 64, height: 64})} as any;
    const [relief] = basemap.renderLayers() as any[];
    expect(relief).toBeInstanceOf(ColorReliefTileLayer);
    expect(relief.props.data).toBe(basemap.state.tilesets.get(definition.sources.terrain));
    expect(relief.props.demTilesetOwner).toBeUndefined();
    basemap.finalizeState();
  });
});
