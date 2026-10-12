// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {WebMercatorViewport, FirstPersonViewport, Viewport, _GlobeViewport} from '@deck.gl/core';
import {TerrainScreenQuery, pickTerrainSurface} from '../examples/terrain/picking';
import {createTerrainStreamFixture} from './terrain-stream-fixture';

/** Geographic grid with physical altitude; no loader, worker or network is required. */
function mesh(latitude = 0, size = 32) {
    const positions: number[] = [], indices: number[] = [];
    for (let row = 0; row <= size; row++) for (let column = 0; column <= size; column++) positions.push((column / size - 0.5) * 0.04, latitude + (row / size - 0.5) * 0.04, 50 + column / size * 20);
    for (let row = 0; row < size; row++) for (let column = 0; column < size; column++) {
        const start = row * (size + 1) + column;
        indices.push(start, start + 1, start + size + 2, start, start + size + 2, start + size + 1);
    }
    return {...createTerrainStreamFixture().mesh, attributes: {POSITION: {size: 3, value: Float32Array.from(positions)}}, indices: {size: 1, value: Uint32Array.from(indices)}};
}

test.each([-46, 0, 46])('cached picking preserves physical height across zoom/pan/resize at latitude %s', latitude => {
    const data = mesh(latitude);
    const query = new TerrainScreenQuery(data);
    const initial = new WebMercatorViewport({longitude: 0, latitude, zoom: 11.99, pitch: 45, width: 512, height: 320});
    const initialPixel = initial.project([0, latitude, 60]);
    const target = query.pick(initial, [initialPixel[0], initialPixel[1]]);
    expect(target?.coordinate[2]).toBeCloseTo(60, 2);
    expect(query.getStatistics().testedTriangles).toBeLessThan(64);
    const moved = new WebMercatorViewport({longitude: 0.001, latitude, zoom: 12.01, pitch: 40, width: 800, height: 400});
    const pixel = moved.project([0, latitude, 60]);
    const hit = query.pick(moved, [pixel[0], pixel[1]]);
    expect(hit?.coordinate[2]).toBeCloseTo(60, 2);
    expect(hit?.coordinate[0]).toBeCloseTo(0, 5);
    expect(query.getStatistics().builds).toBe(1);
    data.attributes.POSITION.value.fill(999);
    expect(query.pick(moved, [pixel[0], pixel[1]])).toEqual(hit);
    expect(query.pick(moved, [-1, 0])).toBeNull();
    expect(query.getStatistics().testedTriangles).toBe(0);
});

test.each([-46, 0, 46])('FirstPerson finite rays pick physical terrain in either offset viewport at latitude %s', latitude => {
    const query = new TerrainScreenQuery(mesh(latitude));
    for (const horizontal of [0, 512]) {
        const viewport = new FirstPersonViewport({id: horizontal ? 'right' : 'left', x: horizontal, y: 20, longitude: 0, latitude: latitude - 0.005, position: [0, 0, 300], pitch: 20, bearing: 0, width: 512, height: 320, far: 20000});
        const pixel = viewport.project([0, latitude, 60]);
        const hit = query.pick(viewport, [pixel[0] + horizontal, pixel[1] + 20]);
        expect(hit?.coordinate[0]).toBeCloseTo(0, 5); expect(hit?.coordinate[1]).toBeCloseTo(latitude, 5); expect(hit?.coordinate[2]).toBeCloseTo(60, 2);
        expect(query.pick(viewport, [horizontal + 512, pixel[1] + 20])).toBeNull();
        expect(query.pick(viewport, [horizontal + 1, 19])).toBeNull();
        const clipped = new FirstPersonViewport({longitude: 0, latitude: latitude - 0.005, position: [0, 0, 300], pitch: 20, bearing: 0, width: 512, height: 320, far: 100});
        expect(query.pick(clipped, [pixel[0], pixel[1]])).toBeNull();
    }
    expect(query.getStatistics().builds).toBe(1);
    expect(query.pick(new Viewport({width: 512, height: 320}), [256, 160])).toBeNull();
    expect(query.pick(new _GlobeViewport({longitude: 0, latitude, zoom: 0, width: 512, height: 320}), [256, 160])).toBeNull();
});

test('MapView picking uses canvas offsets and rejects the exclusive right/bottom edges', () => {
    const viewport = new WebMercatorViewport({x: 512, y: 40, longitude: 0, latitude: 0, zoom: 12, pitch: 40, width: 512, height: 320});
    const query = new TerrainScreenQuery(mesh());
    const pixel = viewport.project([0, 0, 60]);
    expect(query.pick(viewport, [pixel[0] + 512, pixel[1] + 40])?.coordinate[2]).toBeCloseTo(60, 2);
    expect(query.pick(viewport, [pixel[0], pixel[1]])).toBeNull();
    expect(query.pick(viewport, [1024, 200])).toBeNull(); expect(query.pick(viewport, [700, 360])).toBeNull();
});

test('legacy pseudo-meter scale changes rebuild only one retained index and keep physical picking', () => {
    const query = new TerrainScreenQuery(mesh(46));
    const first = new WebMercatorViewport({longitude: 0, latitude: 46, zoom: 12, width: 512, height: 320, legacyMeterSizes: true});
    const second = new WebMercatorViewport({longitude: 0, latitude: 46.002, zoom: 12, width: 512, height: 320, legacyMeterSizes: true});
    for (const viewport of [first, second]) {
        const pixel = viewport.project([0, 46, 60]);
        expect(query.pick(viewport, [pixel[0], pixel[1]])?.coordinate[2]).toBeCloseTo(60, 2);
    }
    expect(query.getStatistics().builds).toBe(2);
    expect(query.pick(null, [0, 0])).toBeNull();
    expect(query.pick(second, [NaN, 0])).toBeNull();
    expect(query.pick(second, [0, 321])).toBeNull();
    const invalid = {...mesh(), attributes: {}};
    expect(pickTerrainSurface(second, invalid, [0, 0])).toBeNull();
    expect(() => new TerrainScreenQuery(invalid)).toThrow();
});
