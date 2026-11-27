// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  _CustomProjectionViewport as CustomProjectionViewport,
  _GlobeViewport as GlobeViewport,
  log,
  WebMercatorViewport
} from '@deck.gl/core';
import {projectionEngine} from '@math.gl/geospatial/projection';
import {testLayer} from '@deck.gl/test-utils/vitest';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer, getStyleView, type ResolvedBasemapStyle} from '../src/index';
import {getStyleView as getMapStyleView, resolveBasemapStyle} from '../src/map-style';
import {getStyleProjection} from '../src/style-view';

const EMPTY_STYLE: ResolvedBasemapStyle = {version: 8, sources: {}, layers: []};
const GLOBE_STYLE = {...EMPTY_STYLE, projection: {type: 'globe'}};
const MERCATOR_STYLE = {...EMPTY_STYLE, projection: {type: 'mercator'}};
const DEFAULT_VIEW_STATE = {longitude: 0, latitude: 0, zoom: 0, bearing: 0, pitch: 0};
const STYLE_CAMERA = {center: [-122.4, 37.8], zoom: 4.5, bearing: 25, pitch: 35};
const STYLE_VIEW_STATE = {longitude: -122.4, latitude: 37.8, zoom: 4.5, bearing: 25, pitch: 35};
const camera = {width: 256, height: 256, longitude: 10, latitude: 20, zoom: 2};
const map = new WebMercatorViewport(camera);
const globe = new GlobeViewport(camera);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('getStyleView', () => {
  test('is also exported from map-style', () => {
    expect(getMapStyleView).toBe(getStyleView);
  });

  test.each([
    {type: 'globe', expected: 'globe'},
    {type: 'vertical-perspective', expected: 'globe'},
    {type: 'mercator', expected: 'mercator'}
  ])('reads the $type projection as $expected', ({type, expected}) => {
    const style = {...EMPTY_STYLE, projection: {type}};
    expect(getStyleProjection(style)).toBe(expected);
    expect(getStyleView(style).projection).toBe(expected);
  });

  test('defaults to mercator when no projection is declared', () => {
    expect(getStyleProjection(EMPTY_STYLE)).toBeNull();
    expect(getStyleView(EMPTY_STYLE).projection).toBe('mercator');
  });

  test('chooses globe for an expression with a vertical-perspective stop', () => {
    const projection = {
      type: ['interpolate', ['linear'], ['zoom'], 10, 'vertical-perspective', 12, 'mercator']
    };
    expect(getStyleView({...EMPTY_STYLE, projection}).projection).toBe('globe');
  });

  test('finds globe inside a nested projection expression', () => {
    const projection = {type: ['case', true, ['literal', 'globe'], 'mercator']};
    expect(getStyleView({...EMPTY_STYLE, projection}).projection).toBe('globe');
  });

  test('chooses mercator for a mercator-only expression', () => {
    const projection = {type: ['step', ['zoom'], 'mercator', 12, 'mercator']};
    const style = {...EMPTY_STYLE, projection};
    expect(getStyleProjection(style)).toBe('mercator');
    expect(getStyleView(style).projection).toBe('mercator');
  });

  test('defaults to mercator for an unknown projection type', () => {
    const style = {...EMPTY_STYLE, projection: {type: 'unknown'}};
    expect(getStyleProjection(style)).toBeNull();
    expect(getStyleView(style).projection).toBe('mercator');
  });

  test('rejects a projection that is not an object', () => {
    expect(getStyleProjection({...EMPTY_STYLE, projection: 'globe'})).toBeNull();
  });

  test('reads the five camera values', () => {
    expect(getStyleView({...EMPTY_STYLE, ...STYLE_CAMERA}).viewState).toEqual(STYLE_VIEW_STATE);
  });

  test('defaults missing camera values to zero', () => {
    expect(getStyleView({...EMPTY_STYLE, roll: 15, centerAltitude: 500}).viewState).toEqual(
      DEFAULT_VIEW_STATE
    );
  });

  test('defaults both coordinates to zero for an invalid center', () => {
    expect(getStyleView({...EMPTY_STYLE, ...STYLE_CAMERA, center: [1]}).viewState).toEqual({
      ...STYLE_VIEW_STATE,
      longitude: 0,
      latitude: 0
    });
  });

  test('defaults non-finite or non-numeric camera values to zero', () => {
    const style = {...EMPTY_STYLE, center: [1, Infinity], zoom: NaN, bearing: Infinity, pitch: '3'};
    expect(getStyleView(style).viewState).toEqual(DEFAULT_VIEW_STATE);
  });

  test('preserves finite camera values without clamping them', () => {
    const style = {...EMPTY_STYLE, center: [200, 95], zoom: -3, bearing: 400, pitch: 100};
    expect(getStyleView(style).viewState).toEqual({
      longitude: 200,
      latitude: 95,
      zoom: -3,
      bearing: 400,
      pitch: 100
    });
  });

  test('reads the projection and camera after resolving a style URL', async () => {
    const fetch = vi.fn(async () =>
      Response.json({version: 8, layers: [], projection: {type: 'globe'}, ...STYLE_CAMERA})
    );
    vi.stubGlobal('fetch', fetch);

    const style = await resolveBasemapStyle('https://styles.example.com/globe.json');
    expect(getStyleView(style)).toEqual({projection: 'globe', viewState: STYLE_VIEW_STATE});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('BasemapLayer projection warning', () => {
  beforeEach(() => {
    vi.spyOn(log, 'warn').mockReturnValue(() => {});
  });

  function initializeLayer(mode: 'auto' | 'map' | 'globe' = 'auto'): BasemapLayer {
    const layer = new BasemapLayer({mode});
    layer.initializeState();
    return layer;
  }

  test('warns once when a globe style draws in a flat view at zoom 2', () => {
    const layer = initializeLayer();
    layer.warnProjectionMismatch(GLOBE_STYLE, map);
    layer.warnProjectionMismatch(GLOBE_STYLE, map);
    layer.warnProjectionMismatch(GLOBE_STYLE, map);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"globe"'));
  });

  test('warns when a mercator style draws in a globe view', () => {
    initializeLayer().warnProjectionMismatch(MERCATOR_STYLE, globe);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('"mercator"'));
  });

  test('accepts a globe style in a globe view', () => {
    initializeLayer().warnProjectionMismatch(GLOBE_STYLE, globe);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('accepts a globe style in a Web Mercator viewport above zoom 12', () => {
    initializeLayer().warnProjectionMismatch(
      GLOBE_STYLE,
      new WebMercatorViewport({...camera, zoom: 13})
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('does not warn in a projected view', async () => {
    const crs = await projectionEngine.getCRS('EPSG:32632');
    const projected = new CustomProjectionViewport({
      crs,
      center: [9, 50, 0],
      zoom: 4,
      width: 256,
      height: 256
    });
    initializeLayer().warnProjectionMismatch(GLOBE_STYLE, projected);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('does not warn when the style has no declared projection', () => {
    initializeLayer().warnProjectionMismatch(EMPTY_STYLE, globe);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test.each(['map', 'globe'] as const)('does not warn with mode %s', mode => {
    initializeLayer(mode).warnProjectionMismatch(GLOBE_STYLE, map);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('warns during renderLayers and keeps the warning across prop updates', async () => {
    const style = await resolveBasemapStyle(GLOBE_STYLE);
    const nextStyle = await resolveBasemapStyle({...GLOBE_STYLE, name: 'Next style'});
    testLayer({
      Layer: BasemapLayer,
      viewport: map,
      draw: false,
      testCases: [
        {title: 'renders a globe style in a flat view', props: {id: 'basemap', style}},
        {title: 'renders the replacement style', updateProps: {style: nextStyle}}
      ]
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('style projection is "globe"'));
  });

  test('auto mode follows the flat view even when a globe style is loaded', () => {
    const layer = initializeLayer();
    layer.state.resolvedStyle = GLOBE_STYLE;
    expect(layer.getDrawMode(map)).toBe('map');
  });
});
