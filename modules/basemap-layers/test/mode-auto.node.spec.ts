// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {_GlobeViewport as GlobeViewport, WebMercatorViewport} from '@deck.gl/core';
import {BasemapLayer} from '../src/basemap-layer';

const camera = {width: 256, height: 256, longitude: 10, latitude: 20, zoom: 2};
const globe = new GlobeViewport(camera);
const map = new WebMercatorViewport(camera);
/** Above zoom 12, `GlobeView` draws with a Web Mercator viewport. */
const globeAboveZoom12 = new WebMercatorViewport({...camera, zoom: 13});

describe('BasemapLayer mode', () => {
  test("defaults to 'auto'", () => {
    expect(BasemapLayer.defaultProps.mode).toBe('auto');
    const layer = new BasemapLayer({id: 'basemap', style: null} as any);
    expect(layer.props.mode).toBe('auto');
  });

  test("'auto' reads the mode from the viewport", () => {
    const layer = new BasemapLayer({id: 'basemap', style: null} as any);
    expect(layer.getDrawMode(globe)).toBe('globe');
    expect(layer.getDrawMode(map)).toBe('map');
    expect(layer.getDrawMode(globeAboveZoom12)).toBe('map');
    expect(layer.getDrawMode(undefined)).toBe('map');
  });

  test("'map' draws map sublayers in a globe viewport", () => {
    const layer = new BasemapLayer({id: 'basemap', style: null, mode: 'map'} as any);
    expect(layer.getDrawMode(globe)).toBe('map');
    expect(layer.getDrawMode(map)).toBe('map');
  });

  test("'globe' keeps its globe sublayers without a viewport", () => {
    const layer = new BasemapLayer({id: 'basemap', style: null, mode: 'globe'} as any);
    expect(layer.getDrawMode(globe)).toBe('globe');
    expect(layer.getDrawMode(map)).toBe('map');
    expect(layer.getDrawMode(undefined)).toBe('globe');
  });

  test('a change of view type changes the zoom key, so the sublayers regenerate', () => {
    const layer = new BasemapLayer({id: 'basemap', style: null} as any);
    const style = {version: 8, sources: {}, layers: []} as any;
    expect(layer.getZoomKey(style, globe)).not.toBe(layer.getZoomKey(style, map));
  });
});
