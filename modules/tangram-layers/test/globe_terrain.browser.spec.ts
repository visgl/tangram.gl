// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {_GlobeViewport as GlobeViewport, WebMercatorViewport, LayerExtension, type UpdateParameters} from '@deck.gl/core';
import {GlobeTerrainLayer, GlobeTerrainDisplayPreparation, getGlobeScreenRatio} from '../src/experimental/terrain';
import {GlobeTerrainPreparation, getPreparedGlobeTerrainTemplate, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';

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
    layer.updateState(prepare(layer, 8, false)); expect(layer.state.exaggeration).toBe(0);
    const flatSurfaces = layer.state.surfaces;
    layer.updateState(prepare(layer, 9, false)); expect(layer.state.surfaces).toBe(flatSurfaces);
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

test('radial elevation and finite sightlines query admitted relief and preserve physical meters', () => {
    const layer = new GlobeTerrainLayer({data: [grid()], meshResolution: 8, globeTerrainExaggeration: 100}); layer.updateState(prepare(layer));
    const target = layer.sampleElevation([0, 0])!;
    expect(target.coordinate[2]).toBeCloseTo(1000); expect(Math.hypot(...target.position)).toBeGreaterThan(256);
    expect(layer.intersectTerrainSegment([0, -400, 0], target.position)?.position).toEqual(target.position.map(value => expect.closeTo(value)));
    expect(layer.intersectTerrainSegment([0, -400, 0], target.position, {endInset: 1e-4})).toBeNull();
    // Looking across the globe to an opposite target is blocked by the loaded near-side top triangles.
    expect(layer.intersectTerrainSegment([0, -400, 0], [0, 400, 0])?.coordinate[2]).toBeCloseTo(1000);
    expect(layer.sampleElevation([180, 0])).toBeNull();
    const bytes = layer.getStatistics().displayBytes, surface = layer.state.surfaces[0];
    const limited = new GlobeTerrainLayer({data: [grid(2000)], meshResolution: 8, globeTerrainExaggeration: 100, maxDisplayBytes: bytes}); limited.state = layer.state; limited.updateState(prepare(limited));
    expect(limited.getStatistics().error).toContain('previous terrain retained'); expect(limited.state.surfaces[0]).toBe(surface);
    expect(limited.sampleElevation([0, 0])?.coordinate[2]).toBeCloseTo(1000);
    const empty = new GlobeTerrainLayer({data: []}); expect(empty.sampleElevation([0, 0])).toBeNull();
    expect(empty.intersectTerrainSegment([0, -400, 0], [0, 400, 0])).toBeNull();
    expect(() => layer.sampleElevation([0, 91])).toThrow('probe');
    expect(() => empty.intersectTerrainSegment([0, NaN, 0], [0, 0, 0])).toThrow('endpoints');
    const missing = grid(); missing.valid.fill(0);
    const holes = new GlobeTerrainLayer({data: [missing]}); holes.updateState(prepare(holes)); expect(holes.sampleElevation([0, 0])).toBeNull();
    expect(layer.getStatistics().queryMs).toBeGreaterThanOrEqual(0);
});

test('explicit physical scale, empty input, custom resolution and invalid maximum are handled', () => {
    const defaults = new GlobeTerrainLayer({data: [grid()], meshResolution: 2, maxDisplayBytes: undefined, maxQueryIndexBytes: undefined}); defaults.updateState(prepare(defaults));
    expect(defaults.getStatistics().tileCount).toBe(1); expect(defaults.getStatistics().error).toBeUndefined();
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

test('camera exaggeration reuses detached sampling templates, and display-only props retain query/mesh buffers', () => {
    const source = grid(), layer = new GlobeTerrainLayer({id: 'terrain', data: [source], meshResolution: 8});
    layer.updateState(prepare(layer));
    const template = layer.state.prepared?.[0].template, surface = layer.state.surfaces[0];
    const firstMesh = layer.renderLayers()[0].props.mesh;
    const wireframe = new GlobeTerrainLayer({id: 'terrain', data: [source], meshResolution: 8, wireframe: true});
    wireframe.state = layer.state; wireframe.updateState(prepare(wireframe));
    expect(wireframe.state.prepared?.[0].template).toBe(template);
    expect(wireframe.state.surfaces[0]).toBe(surface); expect(wireframe.renderLayers()[0].props.mesh).toBe(firstMesh);
    wireframe.updateState(prepare(wireframe, 4, false));
    expect(wireframe.state.prepared?.[0].template).toBe(template);
    expect(wireframe.state.surfaces[0]).not.toBe(surface);
    expect(wireframe.pickTerrain(wireframe.context.viewport, [266, 180])?.coordinate[2]).toBeCloseTo(1000);
});

test('tile replacement invalidates only touching neighborhoods, and evicted/resolution-changed templates are released', () => {
    const source = grid(), distant: TerrainHeightGrid = {...grid(), bounds: [5000000, -1000000, 7000000, 1000000]};
    let layer = new GlobeTerrainLayer({id: 'terrain', data: [source, distant], meshResolution: 4});
    layer.updateState(prepare(layer));
    const first = layer.state.prepared!;
    const neighbor: TerrainHeightGrid = {...grid(3000), bounds: [1000000, -1000000, 3000000, 1000000]};
    const changed = new GlobeTerrainLayer({id: 'terrain', data: [source, distant, neighbor], meshResolution: 4});
    changed.state = layer.state; changed.updateState(prepare(changed)); layer = changed;
    expect(layer.state.prepared?.[0].template).not.toBe(first[0].template);
    expect(layer.state.prepared?.[1]).toBe(first[1]);
    expect(layer.state.prepared?.[0].neighbors).toEqual([neighbor]);
    const distantLayer = layer.renderLayers()[1];
    const reordered = new GlobeTerrainLayer({id: 'terrain', data: [distant, source, neighbor], meshResolution: 4});
    reordered.state = layer.state; reordered.updateState(prepare(reordered));
    expect(reordered.renderLayers()[0].id).toBe(distantLayer.id);
    expect(reordered.renderLayers()[0].props.mesh).toBe(distantLayer.props.mesh);
    const removed = new GlobeTerrainLayer({id: 'terrain', data: [distant], meshResolution: 4});
    removed.state = layer.state; removed.updateState(prepare(removed));
    expect(removed.state.prepared).toEqual([first[1]]);
    const refined = new GlobeTerrainLayer({id: 'terrain', data: [distant], meshResolution: 8});
    refined.state = removed.state; refined.updateState(prepare(refined));
    expect(refined.state.prepared?.[0].template).not.toBe(first[1].template);
    const incompatible = new GlobeTerrainLayer({data: [source, {...distant, verticalDatum: 'ellipsoidal'}]});
    expect(() => incompatible.updateState(prepare(incompatible))).toThrow('datum');
    const duplicate = new GlobeTerrainLayer({data: [source, {...source}]});
    expect(() => duplicate.updateState(prepare(duplicate))).toThrow('distinct footprints');
});

test('wrapped corner and edge neighbors participate in cache invalidation', () => {
    const edge = Math.PI * 6378137;
    const west: TerrainHeightGrid = {...grid(), bounds: [-edge, -1000000, -edge + 2000000, 1000000]};
    const east: TerrainHeightGrid = {...grid(3000), bounds: [edge - 2000000, -1000000, edge, 1000000]};
    const layer = new GlobeTerrainLayer({data: [west, east], meshResolution: 4});
    layer.updateState(prepare(layer));
    expect(layer.state.prepared?.[0].neighbors).toEqual([east]);
    expect(layer.state.prepared?.[1].neighbors).toEqual([west]);
    const retained = layer.state.prepared?.[0].template;
    const replacement = {...east, heights: east.heights.slice()};
    const changed = new GlobeTerrainLayer({data: [west, replacement], meshResolution: 4});
    changed.state = layer.state; changed.updateState(prepare(changed));
    expect(changed.state.prepared?.[0].template).not.toBe(retained);
});

test('completed cooperative snapshots render and pick identically without synchronous preparation', () => {
    const source = grid(), preparation = new GlobeTerrainPreparation();
    preparation.request([source], 8);
    while (preparation.isPending()) preparation.advance(1000);
    const snapshot = preparation.getSnapshot()!;
    const synchronous = new GlobeTerrainLayer({data: [source], meshResolution: 8}); synchronous.updateState(prepare(synchronous));
    const prepared = new GlobeTerrainLayer({data: snapshot.grids, preparedTerrain: snapshot, meshResolution: 8}); prepared.updateState(prepare(prepared));
    expect(prepared.state.prepared?.[0].template).toBe(getPreparedGlobeTerrainTemplate(snapshot, source));
    expect(prepared.renderLayers()[0].props.mesh).toEqual(synchronous.renderLayers()[0].props.mesh);
    expect(prepared.pickTerrain(prepared.context.viewport, [266, 180])).toEqual(synchronous.pickTerrain(synchronous.context.viewport, [266, 180]));
    for (const layer of [new GlobeTerrainLayer({data: [grid()], preparedTerrain: snapshot, meshResolution: 8}), new GlobeTerrainLayer({data: [source], preparedTerrain: snapshot, meshResolution: 4})]) expect(() => layer.updateState(prepare(layer))).toThrow('must match');
    const forged = new GlobeTerrainLayer({data: [source], preparedTerrain: {grids: [source], resolution: 8, byteLength: 0}, meshResolution: 8});
    expect(() => forged.updateState(prepare(forged))).toThrow('completed snapshot');
    preparation.destroy();
});

test('complete cooperative displays adopt identical meshes/queries and never rescale implicitly with the camera', () => {
    const source = grid(), preparation = new GlobeTerrainPreparation(); preparation.request([source], 8);
    while (preparation.isPending()) preparation.advance(1000);
    const terrain = preparation.getSnapshot()!, display = new GlobeTerrainDisplayPreparation(); display.request(terrain, 100);
    while (display.isPending()) display.advance(1000);
    const snapshot = display.getSnapshot()!;
    const synchronous = new GlobeTerrainLayer({data: [source], meshResolution: 8}); synchronous.updateState(prepare(synchronous));
    const layer = new GlobeTerrainLayer({data: terrain.grids, meshResolution: 8, preparedTerrain: terrain, preparedDisplay: snapshot}); layer.updateState(prepare(layer));
    expect(layer.renderLayers()[0].props.mesh).toEqual(synchronous.renderLayers()[0].props.mesh);
    expect(layer.pickTerrain(layer.context.viewport, [266, 180])).toEqual(synchronous.pickTerrain(synchronous.context.viewport, [266, 180]));
    const surface = layer.state.surfaces[0], mesh = layer.renderLayers()[0].props.mesh;
    layer.updateState(prepare(layer, 4, false)); expect(layer.state.exaggeration).toBe(100); expect(layer.state.surfaces[0]).toBe(surface);
    const wireframe = new GlobeTerrainLayer({data: terrain.grids, meshResolution: 8, preparedDisplay: snapshot, wireframe: true}); wireframe.state = layer.state; wireframe.updateState(prepare(wireframe));
    expect(wireframe.renderLayers()[0].props.mesh).toBe(mesh); expect(wireframe.state.surfaces[0]).toBe(surface);
    for (const invalid of [new GlobeTerrainLayer({data: [grid()], meshResolution: 8, preparedDisplay: snapshot}), new GlobeTerrainLayer({data: [source], meshResolution: 4, preparedDisplay: snapshot}), new GlobeTerrainLayer({data: [source], meshResolution: 8, preparedDisplay: snapshot, preparedTerrain: {...terrain}})]) expect(() => invalid.updateState(prepare(invalid))).toThrow('must match');
    for (const field of ['maxDisplayBytes', 'maxQueryIndexBytes']) {const invalid = new GlobeTerrainLayer({data: [source], meshResolution: 8, preparedDisplay: snapshot, [field]: 0}); expect(() => invalid.updateState(prepare(invalid))).toThrow('budgets');}
    const forged = new GlobeTerrainLayer({data: [source], meshResolution: 8, preparedDisplay: {...snapshot}}); expect(() => forged.updateState(prepare(forged))).toThrow('library snapshot');
});

test('prepared-display adoption enforces layer retention even if an external controller did not own its old mesh', () => {
    const source = grid(), layer = new GlobeTerrainLayer({data: [source], meshResolution: 4}); layer.updateState(prepare(layer));
    const bytes = layer.getStatistics().displayBytes, surface = layer.state.surfaces[0];
    const replacement = grid(2000), preparation = new GlobeTerrainPreparation(); preparation.request([replacement], 4); while (preparation.isPending()) preparation.advance(1000);
    const display = new GlobeTerrainDisplayPreparation({maxDisplayBytes: bytes}); display.request(preparation.getSnapshot()!, 100); while (display.isPending()) display.advance(1000);
    const next = new GlobeTerrainLayer({data: [replacement], meshResolution: 4, preparedDisplay: display.getSnapshot(), maxDisplayBytes: bytes}); next.state = layer.state; next.updateState(prepare(next));
    expect(next.getStatistics().error).toContain('previous terrain retained'); expect(next.state.surfaces[0]).toBe(surface);
    expect(next.pickTerrain(next.context.viewport, [266, 180])?.coordinate[2]).toBeCloseTo(1000);
});

test('display preflight rejects replacements atomically while zero query budget preserves exact picking', () => {
    const source = grid(), layer = new GlobeTerrainLayer({id: 'bounded', data: [source], meshResolution: 8, maxQueryIndexBytes: 0});
    layer.updateState(prepare(layer));
    const initial = layer.getStatistics(), surfaces = layer.state.surfaces, mesh = layer.renderLayers()[0].props.mesh;
    const template = layer.state.prepared![0].template;
    expect(initial.displayBytes).toBe(template.vertexCount * 56 + template.triangleCount * 24);
    expect(layer.pickTerrain(layer.context.viewport, [266, 180])?.coordinate[2]).toBeCloseTo(1000);
    expect(layer.getStatistics().queryIndexBytes).toBe(0);
    const replacement = new GlobeTerrainLayer({id: 'bounded', data: [grid(2000)], meshResolution: 8, maxDisplayBytes: initial.displayBytes, maxQueryIndexBytes: 0});
    replacement.state = layer.state; replacement.updateState(prepare(replacement));
    expect(replacement.getStatistics().error).toContain('previous terrain retained');
    expect(replacement.state.surfaces).toBe(surfaces);
    expect(replacement.renderLayers()[0].props.mesh).toBe(mesh);
    expect(replacement.pickTerrain(replacement.context.viewport, [266, 180])?.coordinate[2]).toBeCloseTo(1000);
    const admitted = new GlobeTerrainLayer({id: 'bounded', data: replacement.props.data, meshResolution: 8, maxDisplayBytes: initial.displayBytes * 2, maxQueryIndexBytes: 0});
    admitted.state = replacement.state; admitted.updateState(prepare(admitted));
    expect(admitted.getStatistics().error).toBeUndefined();
    expect(admitted.pickTerrain(admitted.context.viewport, [266, 180])?.coordinate[2]).toBeCloseTo(2000);
    const removed = new GlobeTerrainLayer({id: 'bounded', data: [], maxDisplayBytes: 0}); removed.state = admitted.state; removed.updateState(prepare(removed));
    expect(removed.getStatistics().displayBytes).toBe(0); expect(removed.renderLayers()).toEqual([]);
});

test('unchanged geometry fits an exact display cap; current per-tile acceleration cannot exceed the shared cap', () => {
    const source = grid(), layer = new GlobeTerrainLayer({data: [source], meshResolution: 8, maxQueryIndexBytes: 1}); layer.updateState(prepare(layer));
    const bytes = layer.getStatistics().displayBytes;
    const unchanged = new GlobeTerrainLayer({data: [source], meshResolution: 8, maxDisplayBytes: bytes, maxQueryIndexBytes: 1, wireframe: true});
    unchanged.state = layer.state; unchanged.updateState(prepare(unchanged));
    expect(unchanged.getStatistics().error).toBeUndefined(); expect(unchanged.state.surfaces[0]).toBe(layer.state.surfaces[0]);
    unchanged.pickTerrain(unchanged.context.viewport, [266, 180]); expect(unchanged.getStatistics().queryIndexBytes).toBeLessThanOrEqual(1);
    const empty = new GlobeTerrainLayer({data: [source], maxDisplayBytes: 0}); empty.updateState(prepare(empty));
    expect(empty.renderLayers()).toEqual([]); expect(empty.getStatistics().displayBytes).toBe(0);
    for (const limit of [-1, 0.5, Infinity, NaN]) for (const key of ['maxDisplayBytes', 'maxQueryIndexBytes']) {
        const invalid = new GlobeTerrainLayer({data: [], [key]: limit}); expect(() => invalid.updateState(prepare(invalid))).toThrow('byte limits');
    }
});
