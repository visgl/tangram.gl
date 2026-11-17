// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {log} from '@deck.gl/core';
import {PathStyleExtension} from '@deck.gl/extensions';
import {getBasemapLayers} from '../src/globe-layers';
import {LineGradientExtension} from '../src/line-gradient-extension';
import {LinePatternExtension} from '../src/line-pattern-extension';
import type {SpriteAtlas, SpriteIconMappingEntry} from '../src/sprite';

afterEach(() => {
  vi.restoreAllMocks();
});

function entry(pixelRatio = 1): SpriteIconMappingEntry {
  return {x: 0, y: 0, width: 16, height: 8, mask: false, pixelRatio};
}

const DEFAULT_SPRITE: SpriteAtlas = {
  id: 'default',
  // An image object, not a URL: deck.gl resolves a URL prop only once the layer loads it.
  image: {name: 'default image'} as any,
  mapping: {arrow: entry(2), dots: entry(2)}
};
const BASE_SPRITE: SpriteAtlas = {
  id: 'base',
  image: {name: 'base image'} as any,
  mapping: {rail: entry(1)}
};
const SPRITES = [DEFAULT_SPRITE, BASE_SPRITE];

function line(properties: Record<string, unknown> = {}) {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1]
      ]
    },
    properties
  };
}

/** Renders one line style layer for one tile and returns all its sublayers. */
function renderLines(
  paint: Record<string, unknown>,
  features: unknown[] = [line()],
  {
    zoom = 12,
    spriteAtlases = SPRITES,
    source = {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}
  }: {zoom?: number; spriteAtlases?: SpriteAtlas[] | null; source?: Record<string, unknown>} = {}
): any[] {
  const vectorLayer: any = getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom,
    spriteAtlases,
    styleDefinition: {
      version: 8,
      sources: {tiles: source},
      layers: [{id: 'line', type: 'line', source: 'tiles', paint}]
    } as any
  }).find(layer => layer.id === 'test-tiles');
  return [
    vectorLayer.props.renderSubLayers({
      id: 'test-tile',
      data: features,
      tile: {index: {x: 0, y: 0, z: Math.floor(zoom)}}
    })
  ]
    .flat(2)
    .filter(Boolean);
}

function evaluate(accessor: unknown, feature: unknown) {
  return typeof accessor === 'function' ? accessor(feature, {index: 0}) : accessor;
}

const hasExtension = (layer: any, type: new (...args: any[]) => unknown) =>
  layer.props.extensions.some((extension: unknown) => extension instanceof type);

describe('line-pattern', () => {
  test('draws its image from the sprite, in white at line-opacity', () => {
    const [layer] = renderLines({
      'line-pattern': 'arrow',
      'line-color': '#ff0000',
      'line-opacity': 0.5
    });
    expect(hasExtension(layer, LinePatternExtension)).toBe(true);
    expect(layer.props.linePatternAtlas).toBe(DEFAULT_SPRITE.image);
    expect(layer.props.linePatternMapping).toBe(DEFAULT_SPRITE.mapping);
    expect(layer.props.getLinePattern).toBe('arrow');
    expect(layer.props.getLineColor).toEqual([255, 255, 255, 128]);
    expect(layer.props.textureParameters).toMatchObject({mipmapFilter: 'none'});
  });

  test('measures repeats at the integer zoom, in the line-width at that zoom', () => {
    const width = ['interpolate', ['linear'], ['zoom'], 12, 4, 13, 8];
    const [layer] = renderLines({'line-pattern': 'arrow', 'line-width': width}, [line()], {
      zoom: 12.75
    });
    expect(layer.props.linePatternPixelsPerUnit).toBe(2 ** 12);
    // MapLibre's `floorwidth`: the image is 4 pixels high along the line, drawn 7 wide.
    expect(evaluate(layer.props.getLinePatternWidth, line())).toBe(4);
    expect(evaluate(layer.props.getLineWidth, line())).toBe(7);
  });

  test('evaluates the image and the width per feature', () => {
    const features = [line({image: 'arrow', width: 3}), line({image: 'dots', width: 6})];
    const [layer] = renderLines(
      {'line-pattern': ['get', 'image'], 'line-width': ['get', 'width']},
      features
    );
    expect(features.map(feature => evaluate(layer.props.getLinePattern, feature))).toEqual([
      'arrow',
      'dots'
    ]);
    expect(features.map(feature => evaluate(layer.props.getLinePatternWidth, feature))).toEqual([
      3, 6
    ]);
  });

  test('draws a sublayer per sprite, and nothing for a missing image or while sprites load', () => {
    vi.spyOn(log, 'warn').mockReturnValue(() => {});
    const features = [
      line({image: 'arrow'}),
      line({image: 'base:rail'}),
      line({image: 'missing'})
    ];
    const layers = renderLines({'line-pattern': ['get', 'image']}, features);
    expect(layers.map(layer => layer.props.linePatternAtlas)).toEqual([
      DEFAULT_SPRITE.image,
      BASE_SPRITE.image
    ]);
    expect(layers.map(layer => layer.props.data.length)).toEqual([1, 1]);
    expect(new Set(layers.map(layer => layer.id)).size).toBe(2);
    expect(renderLines({'line-pattern': 'arrow'}, [line()], {spriteAtlases: null})).toEqual([]);
    expect(renderLines({'line-pattern': 'missing'})).toEqual([]);
  });

  test('draws without dashes, and replaces a gradient, as MapLibre', () => {
    const [layer] = renderLines(
      {'line-pattern': 'arrow', 'line-dasharray': [2, 1], 'line-gradient': '#00ff00'},
      [line()],
      {
        source: {
          type: 'geojson',
          data: {type: 'FeatureCollection', features: []},
          lineMetrics: true
        }
      }
    );
    expect(hasExtension(layer, PathStyleExtension)).toBe(false);
    expect(hasExtension(layer, LineGradientExtension)).toBe(false);
    expect(layer.props.getDashArray).toBeUndefined();
    expect(layer.props.lineGradientImage).toBeUndefined();
  });

  test('with an offset, drops a per-feature blur, for which there is no vertex attribute', () => {
    const [layer] = renderLines({
      'line-pattern': 'arrow',
      'line-offset': 2,
      'line-blur': ['get', 'blur']
    });
    expect(hasExtension(layer, LinePatternExtension)).toBe(true);
    expect(typeof layer.props.getBlur).not.toBe('function');
    const [unoffset] = renderLines({'line-pattern': 'arrow', 'line-blur': ['get', 'blur']});
    expect(typeof unoffset.props.getBlur).toBe('function');
  });
});
