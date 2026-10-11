// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {_GlobeViewport as GlobeViewport, WebMercatorViewport, LayerExtension, type UpdateParameters} from '@deck.gl/core';
import {GlobeTerrainLayer, getGlobeScreenRatio} from '../src/experimental/terrain';
import type {TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';

/** Marker extension exercising the deliberately unsupported vertex-extension boundary. */
class TestExtension extends LayerExtension {}

/** Hermetic single DEM centered on the prime meridian. */
function grid(height = 1000): TerrainHeightGrid {
    return {width: 2, height: 2, heights: new Float32Array(4).fill(height), valid: new Uint8Array(4).fill(1), bounds: [-1000000, -1000000, 1000000, 1000000], registration: 'grid-node', verticalDatum: 'unknown'};
}

/** Exercise authored layer policy without allocating a GPU device in the coverage lane. */
function prepare(layer: GlobeTerrainLayer, zoom = 1, changed = true): UpdateParameters<GlobeTerrainLayer> {
    Object.defineProperty(layer, 'context', {configurable: true, value: {viewport: new GlobeViewport({x: 10, y: 20, width: 512, height: 320, longitude: 0, latitude: 0, zoom})}});
    layer.state ??= {layers: [], surfaces: [], exaggeration: NaN};
    vi.spyOn(layer, 'setState').mockImplementation(update => {Object.assign(layer.state, update);});
    return {props: layer.props, oldProps: layer.props, context: layer.context, changeFlags: {dataChanged: false, propsChanged: false, updateTriggersChanged: false, extensionsChanged: false, viewportChanged: true, stateChanged: false, propsOrDataChanged: changed, somethingChanged: true}};
}

test('default 100× relief fades with actual GlobeView scale; normal Mercator is rejected', () => {
    const layer = new GlobeTerrainLayer({id: 'terrain', data: [grid()], meshResolution: 4});
    expect(layer.props.globeTerrainExaggeration).toBe(100);
    expect(new GlobeTerrainLayer({data: []}).props.meshResolution).toBe(64);
    const parameters = prepare(layer); layer.updateState(parameters);
    expect(layer.state.exaggeration).toBe(100); expect(layer.renderLayers()).toHaveLength(1);
    expect(layer.renderLayers()[0].props).toMatchObject({_instanced: false, material: false, pickable: false});
    const surfaces = layer.state.surfaces;
    layer.updateState(prepare(layer, 1, false)); expect(layer.state.surfaces).toBe(surfaces);
    layer.updateState(prepare(layer, 4, false)); expect(layer.state.exaggeration).toBeLessThan(100);
    layer.updateState(prepare(layer, 8, false)); expect(layer.state.exaggeration).toBe(1);
    expect(() => getGlobeScreenRatio(new WebMercatorViewport({width: 512, height: 320}))).toThrow('GlobeView');
    for (const dimension of ['width', 'height']) {
        const invalid = new GlobeViewport({width: 512, height: 320}); Object.defineProperty(invalid, dimension, {value: 0}); expect(() => getGlobeScreenRatio(invalid)).toThrow('GlobeView');
    }
    expect(getGlobeScreenRatio(new GlobeViewport({width: 200, height: 600, zoom: 2}))).toBeGreaterThan(getGlobeScreenRatio(new GlobeViewport({width: 600, height: 600, zoom: 2})));
    expect(layer.shouldUpdateState(parameters)).toBe(true);
    expect(layer.shouldUpdateState({...parameters, changeFlags: {...parameters.changeFlags, viewportChanged: false, propsOrDataChanged: false}})).toBe(false);
});

test('current display mesh picks physical heights, honors viewport offsets, holes and nearest-hit ordering', () => {
    const layer = new GlobeTerrainLayer({data: [grid()], meshResolution: 8});
    const parameters = prepare(layer); layer.updateState(parameters);
    const viewport = layer.context.viewport;
    expect(layer.pickTerrain(viewport, [266, 180])?.coordinate[2]).toBeCloseTo(1000);
    expect(layer.pickTerrain(viewport, [-1000, -1000])).toBeNull();
    expect(() => layer.pickTerrain(viewport, [NaN, 180])).toThrow('finite');
    const low = layer.state.surfaces[0];
    const highLayer = new GlobeTerrainLayer({data: [grid(2000)], meshResolution: 8}); highLayer.updateState(prepare(highLayer));
    layer.state.surfaces = [low, highLayer.state.surfaces[0], low];
    expect(layer.pickTerrain(viewport, [266, 180])?.coordinate[2]).toBeCloseTo(2000);
    const uninitialized = new GlobeTerrainLayer({data: []});
    expect(uninitialized.pickTerrain(viewport, [266, 180])).toBeNull();
    const missing = grid(); missing.valid.fill(0);
    const holes = new GlobeTerrainLayer({data: [missing]}); holes.updateState(prepare(holes));
    expect(holes.pickTerrain(viewport, [266, 180])).toBeNull();
});

test('explicit physical scale, empty input, custom resolution and invalid maximum are handled', () => {
    const physical = new GlobeTerrainLayer({data: [grid()], globeTerrainExaggeration: 1, meshResolution: 2, wireframe: true}); physical.updateState(prepare(physical));
    expect(physical.state.exaggeration).toBe(1); expect(physical.renderLayers()[0].props.wireframe).toBe(true);
    const empty = new GlobeTerrainLayer({data: []}); empty.updateState(prepare(empty)); expect(empty.renderLayers()).toEqual([]);
    const invalid = new GlobeTerrainLayer({data: [], globeTerrainExaggeration: Infinity}); expect(() => invalid.updateState(prepare(invalid))).toThrow('Invalid');
    const transformed = new GlobeTerrainLayer({data: [], modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}); expect(() => transformed.updateState(prepare(transformed))).toThrow('transforms');
    const extended = new GlobeTerrainLayer({data: [], extensions: [new TestExtension()]}); expect(() => extended.updateState(prepare(extended))).toThrow('extensions');
    const neighbor = {...grid(), bounds: [1000000, -1000000, 3000000, 1000000] as const};
    const adjacent = new GlobeTerrainLayer({data: [grid(), neighbor], meshResolution: 2}); adjacent.updateState(prepare(adjacent)); expect(adjacent.renderLayers()).toHaveLength(2);
});

test('zero displacement stays flat when zooming while queries preserve physical meters', () => {
    const layer = new GlobeTerrainLayer({data: [grid()], globeTerrainExaggeration: 0, meshResolution: 8});
    layer.updateState(prepare(layer));
    expect(layer.state.exaggeration).toBe(0);
    expect(layer.pickTerrain(layer.context.viewport, [266, 180])?.coordinate[2]).toBeCloseTo(1000);
    const surfaces = layer.state.surfaces;
    layer.updateState(prepare(layer, 8, false));
    expect(layer.state.exaggeration).toBe(0);
    expect(layer.state.surfaces).toBe(surfaces);
});
