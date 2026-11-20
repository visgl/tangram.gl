// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {SharedMVTLayer} from '@deck.gl-community/geo-layers';
import {_GlobeViewport as GlobeViewport, log} from '@deck.gl/core';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/basemap-layer';

const SOURCES = {
  tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}
};
const LAYERS = [
  {id: 'water', type: 'fill', source: 'tiles', 'source-layer': 'water'},
  {id: 'places', type: 'symbol', source: 'tiles', 'source-layer': 'place', layout: {}}
];
const STYLE: any = {version: 8, sources: SOURCES, layers: LAYERS};

/** A basemap with `props` whose style is resolved, set up as deck.gl sets up a layer. */
function basemap(props: Record<string, unknown> = {}): any {
  const layer: any = new BasemapLayer({id: 'basemap', style: STYLE, ...props} as any);
  layer.context = {layerManager: {}, viewport: new GlobeViewport({width: 256, height: 256, zoom: 1})};
  layer.initializeState();
  layer.setState = (partial: Record<string, unknown>) => Object.assign(layer.state, partial);
  layer.state.resolvedStyle = STYLE;
  layer.state.spriteAtlases = [];
  return layer;
}

/** The MVT source layers that the tileset of the vector source decodes. */
function getDecodedLayers(layer: any): string[] {
  layer.updateSourceTilesets(STYLE);
  const tileset = layer.state.tilesets.get(SOURCES.tiles);
  let layers: string[] = [];
  const spy = vi.spyOn(SharedMVTLayer.prototype, 'getTileData').mockImplementation(function (
    this: SharedMVTLayer
  ) {
    layers = (this.props.loadOptions as any)?.mvt?.layers;
    return Promise.resolve([]);
  });
  tileset.opts.getTileData({index: {x: 0, y: 0, z: 1}});
  spy.mockRestore();
  return layers;
}

/** The layer names of the sublayers that `layer` renders. */
function getSubLayerNames(layer: any): string[] {
  return layer.renderLayers().map((sublayer: any) => sublayer.constructor.layerName);
}

afterEach(() => vi.restoreAllMocks());

describe('BasemapLayer labels and atmosphere props', () => {
  test('default to labels on and atmosphere off', () => {
    expect(BasemapLayer.defaultProps.labels).toBe(true);
    expect(BasemapLayer.defaultProps.atmosphere).toBe(false);
    expect(basemap().getStyleConfig()).toEqual({
      config: {labels: true, atmosphere: false, basemap: true}
    });
  });

  test('labels: false does not decode the source layers that only labels read', () => {
    expect(getDecodedLayers(basemap())).toEqual(['place', 'water']);
    expect(getDecodedLayers(basemap({labels: false}))).toEqual(['water']);
  });

  test('labels: false applies in map mode too', () => {
    expect(getDecodedLayers(basemap({labels: false, mode: 'map'}))).toEqual(['water']);
  });

  test('atmosphere sets the atmosphere toggle of the basemap helpers', () => {
    // The atmosphere layers themselves are placeholders that draw nothing yet.
    expect(basemap({atmosphere: true}).getStyleConfig().config.atmosphere).toBe(true);
    expect(basemap().getStyleConfig().config.atmosphere).toBe(false);
  });

  test('the config keeps its identity while the props do not change', () => {
    const layer = basemap({labels: false});
    const config = layer.getStyleConfig();
    expect(layer.getStyleConfig()).toBe(config);
    layer.props = {...layer.props, labels: true};
    expect(layer.getStyleConfig()).not.toBe(config);
    expect(layer.getStyleConfig().config.labels).toBe(true);
  });
});

describe('the deprecated globe.config prop', () => {
  test('still works, and overrides the flat props for the fields it sets', () => {
    expect(getDecodedLayers(basemap({globe: {config: {labels: false}}}))).toEqual(['water']);
    expect(basemap({labels: false, globe: {config: {labels: true}}}).getStyleConfig().config.labels)
      .toBe(true);
    // A field it leaves out keeps the flat prop.
    expect(basemap({labels: false, globe: {config: {atmosphere: true}}}).getStyleConfig()).toEqual({
      config: {labels: false, atmosphere: true, basemap: true}
    });
  });

  test('basemap: false still draws no style layers', () => {
    expect(getSubLayerNames(basemap({mode: 'globe'}))).toContain('StyledMVTLayer');
    const layer = basemap({mode: 'globe', globe: {config: {basemap: false}}});
    // Only the globe's fallback background is left.
    expect(getSubLayerNames(layer)).toEqual(['SolidPolygonLayer']);
  });

  test('logs a deprecation warning, and the flat props do not', () => {
    const deprecated = vi.spyOn(log, 'deprecated');
    basemap({labels: false}).getStyleConfig();
    expect(deprecated).not.toHaveBeenCalled();
    basemap({globe: {config: {labels: false}}}).getStyleConfig();
    expect(deprecated).toHaveBeenCalledTimes(1);
    expect(deprecated.mock.calls[0][0]).toContain('globe.config');
  });
});
