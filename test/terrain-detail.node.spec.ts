// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {selectTerrainDetail} from '../examples/terrain/terrain-detail';
import {selectTerrainTiles} from '../examples/terrain/tile-selection';

test('tile footprint, not camera/style zoom, controls bounded source detail', () => {
    const viewport = new WebMercatorViewport({longitude: 7.8, latitude: 46, zoom: 8.5, pitch: 0, width: 512, height: 320});
    const fine = selectTerrainDetail(viewport, {targetTilePixels: 256, elevation: 0});
    const coarse = selectTerrainDetail(viewport, {targetTilePixels: 1024, elevation: 0});
    expect(fine.zoom - coarse.zoom).toBe(2);
    expect(fine.projectedTilePixels).toBeLessThanOrEqual(256);
    expect(coarse.projectedTilePixels).toBeLessThanOrEqual(1024);
    expect(viewport.zoom).toBe(8.5);
    expect(selectTerrainTiles(viewport, 9, fine.zoom).every(tile => tile.zoom === fine.zoom)).toBe(true);
    expect(selectTerrainTiles(viewport, 9, coarse.zoom).length).toBeLessThanOrEqual(9);
    expect(() => selectTerrainTiles(viewport, 9, 13)).toThrow();
});

test('hysteresis prevents threshold jitter but permits deliberate detail changes', () => {
    const camera = {longitude: 0.01, latitude: 0.01, pitch: 0, width: 512, height: 320};
    const initial = selectTerrainDetail(new WebMercatorViewport({...camera, zoom: 8}), {elevation: 0});
    for (const zoom of [7.99, 8.01, 8.05, 8.1]) expect(selectTerrainDetail(new WebMercatorViewport({...camera, zoom}), {elevation: 0, previousZoom: initial.zoom}).zoom).toBe(initial.zoom);
    expect(selectTerrainDetail(new WebMercatorViewport({...camera, zoom: 9}), {elevation: 0, previousZoom: initial.zoom}).zoom).toBeGreaterThan(initial.zoom);
    expect(selectTerrainDetail(new WebMercatorViewport({...camera, zoom: 6.5}), {elevation: 0, previousZoom: initial.zoom}).zoom).toBeLessThan(initial.zoom);
});

test.each([0, 46, -46, 85, -85])('pitched selection remains bounded near latitude %s', latitude => {
    const viewport = new WebMercatorViewport({longitude: 179.99, latitude, zoom: 15, pitch: 80, width: 1024, height: 512});
    const selection = selectTerrainDetail(viewport, {minZoom: 4, maxZoom: 10});
    expect(selection.zoom).toBeGreaterThanOrEqual(4); expect(selection.zoom).toBeLessThanOrEqual(10);
    expect(selection.limited).toBe(true);
    expect(selectTerrainTiles(viewport, 9, selection.zoom).length).toBeLessThanOrEqual(9);
});

test('invalid horizon projections have a bounded fallback and policy errors reject', () => {
    const view = {zoom: 5, longitude: 0, latitude: 0, project: () => [NaN, NaN, NaN]};
    expect(selectTerrainDetail(view)).toEqual({zoom: 5, projectedTilePixels: null, limited: true});
    expect(selectTerrainDetail(view, {previousZoom: 0}).zoom).toBe(5);
    expect(selectTerrainDetail({...view, zoom: 10}, {previousZoom: 0}).zoom).toBe(10);
    expect(selectTerrainDetail({...view, zoom: 10}, {previousZoom: 3, minZoom: 3, maxZoom: 8}).zoom).toBe(8);
    for (const options of [{targetTilePixels: 0}, {targetTilePixels: Infinity}, {hysteresis: -1}, {maxZoom: 13}, {minZoom: 5, maxZoom: 4}, {previousZoom: 0.5}, {elevation: NaN}]) expect(() => selectTerrainDetail(view, options)).toThrow();
    expect(() => selectTerrainDetail({...view, longitude: Infinity})).toThrow();
    expect(selectTerrainDetail({...view, project: () => [0, 0, 2]}).limited).toBe(true);
});
