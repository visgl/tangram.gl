// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {OrthographicView, WebMercatorViewport} from '@deck.gl/core';
import {HostFrame} from '@vis.gl/tangram-renderer/core';
import {createProjectedBasemapScene, getProjectedViewFrame, ProjectedBasemapLayer} from '../src/experimental/projected-basemaps';

afterEach(() => vi.restoreAllMocks());

test('projection-only property updates are deduplicated, restore the authored default and ignore disposed records', async () => {
    const scene = createProjectedBasemapScene({sources: {}, layers: {}}, {type: 'equal-earth'}, 'https://example.test/projection.js');
    vi.spyOn(Object.getPrototypeOf(ProjectedBasemapLayer.prototype), 'updateState').mockImplementation(() => {});
    const onProjectionChange = vi.fn();
    const layer = new ProjectedBasemapLayer({id: 'warm', scene, onProjectionChange});
    const record = {sceneSource: scene, owner: layer, disposed: false, loadFailed: false,
        loadPromise: Promise.resolve(), renderer: {setProjectedBasemapProjection: vi.fn().mockResolvedValue(undefined)}};
    layer.state = {tangramRecord: record};
    vi.spyOn(layer, 'setNeedsRedraw').mockImplementation(() => {});
    layer.updateState({props: {projectedProjection: {type: 'albers'}}});
    await vi.waitFor(() => expect(onProjectionChange).toHaveBeenCalledOnce());
    layer.updateState({props: {projectedProjection: {type: 'albers'}}});
    expect(record.renderer.setProjectedBasemapProjection).toHaveBeenCalledOnce();
    layer.updateState({props: {}});
    await vi.waitFor(() => expect(onProjectionChange).toHaveBeenCalledTimes(2));
    expect(record.renderer.setProjectedBasemapProjection.mock.calls[1][0].type).toBe('equal-earth');
    record.disposed = true;
    layer.updateState({props: {projectedProjection: {type: 'mercator'}}});
    await Promise.resolve();
    expect(record.renderer.setProjectedBasemapProjection).toHaveBeenCalledTimes(2);
});

test('failed projection updates report errors and allow a correction without replacing the scene', async () => {
    const scene = createProjectedBasemapScene({sources: {}, layers: {}}, {type: 'equal-earth'}, 'https://example.test/projection.js');
    vi.spyOn(Object.getPrototypeOf(ProjectedBasemapLayer.prototype), 'updateState').mockImplementation(() => {});
    const layer = new ProjectedBasemapLayer({id: 'warm', scene});
    const record = {sceneSource: scene, owner: layer, disposed: false, loadFailed: false,
        loadPromise: Promise.resolve(), renderer: {setProjectedBasemapProjection: vi.fn().mockRejectedValueOnce(new Error('build failure'))
            .mockResolvedValue(undefined)}};
    layer.state = {tangramRecord: record};
    const report = vi.spyOn(layer, '_reportSceneError').mockImplementation(() => {});
    vi.spyOn(layer, 'setNeedsRedraw').mockImplementation(() => {});
    layer.updateState({props: {projectedProjection: {type: 'mercator'}}});
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    layer.updateState({props: {projectedProjection: {type: 'mercator'}}});
    await vi.waitFor(() => expect(record.renderer.setProjectedBasemapProjection).toHaveBeenCalledTimes(2));
});

/** Actual deck.gl OrthographicViewport, not a matrix-shaped mock. */
function createViewport(target: [number, number, number] = [0, 0, 0], zoom = -1) {
    return new OrthographicView({id: 'projected', flipY: false}).makeViewport({width: 640, height: 360,
        viewState: {target, zoom}})!;
}

test('projected style, source detail and resource budgets are independent of camera zoom', () => {
    const resources = {maxConcurrentBuilds: 2, maxCachedTiles: 16, maxCachedMeshBytes: 1024};
    for (const cameraZoom of [-2, 3]) {
        const host = new HostFrame(getProjectedViewFrame(createViewport([0, 0, 0], cameraZoom), {
            projection: {type: 'equal-earth'}, visibleBounds: [-180, -80, 180, 80],
            tileZoom: 2, styleZoom: 8, maxTiles: 16, tileResources: resources}));
        expect(host.tileZoom).toBe(2);
        expect(host.geographicAnchor.zoom).toBe(8);
        expect(host.tileResources).toEqual(resources);
        expect(host.tileResources).not.toBe(resources);
    }
});

test('candidate limits reject over-budget frames and resource/style errors before installation', () => {
    const options = {projection: {type: 'equal-earth' as const}, visibleBounds: [-180, -80, 180, 80] as const, tileZoom: 2};
    expect(() => getProjectedViewFrame(createViewport(), {...options, maxTiles: 15})).toThrow('16 tiles per source');
    expect(() => getProjectedViewFrame(createViewport(), {...options, maxTiles: 16})).not.toThrow();
    for (const maxTiles of [0, -1, 1.5, Infinity, NaN]) {
        expect(() => getProjectedViewFrame(createViewport(), {...options, maxTiles})).toThrow('maxTiles');
    }
    for (const styleZoom of [-1, 1.5, 23, Infinity, NaN]) {
        expect(() => getProjectedViewFrame(createViewport(), {...options, styleZoom})).toThrow('styleZoom');
    }
    expect(() => getProjectedViewFrame(createViewport(), {...options, styleZoom: 1})).toThrow();
    expect(() => getProjectedViewFrame(createViewport(), {...options, tileResources: {maxConcurrentBuilds: 0}})).toThrow();
    const scene = createProjectedBasemapScene({sources: {}, layers: {}}, {type: 'equal-earth'}, 'https://example.test/projection.js');
    const layer = new ProjectedBasemapLayer({id: 'budget', scene, projectedTileZoom: 2, projectedStyleZoom: 5,
        projectedMaxTiles: 16, tileResources: {maxCachedTiles: 0}});
    const viewport = createViewport();
    layer.context = {viewport, deck: {getViewports: () => [viewport]}};
    layer.raiseError = vi.fn();
    const setFrame = vi.fn();
    const record = {renderer: {setFrame}, deckCanvas: {clientWidth: 0, clientHeight: 0},
        lastViewportError: null, reportedViewportError: null};
    layer._synchronizeTangramScene(record);
    expect(new HostFrame(setFrame.mock.calls[0][0])).toMatchObject({tileZoom: 2,
        geographicAnchor: {zoom: 5}, tileResources: {maxCachedTiles: 0}});
    layer.props = {...layer.props, projectedMaxTiles: 15};
    layer._synchronizeTangramScene(record);
    expect(setFrame).toHaveBeenCalledOnce();
    expect(layer.raiseError).toHaveBeenCalledOnce();
    expect(record.lastViewportError).toContain('maxTiles');
    layer.props = {...layer.props, projectedMaxTiles: 16};
    layer._synchronizeTangramScene(record);
    expect(setFrame).toHaveBeenCalledTimes(2);
    expect(record.lastViewportError).toBeNull();
});

test('orthographic host camera projects common positions exactly as deck.gl does', () => {
    for (const [target, zoom] of [[[0, 0, 0], -1], [[100, -50, 0], 1]] as const) {
        const viewport = createViewport([...target], zoom);
        const frame = getProjectedViewFrame(viewport, {projection: {type: 'equal-earth'}, tileZoom: 2, visibleBounds: [-170, -80, 170, 80]});
        const host = new HostFrame(frame);
        expect(host.projection.type).toBe('projected');
        expect(host.tileZoom).toBe(2);
        expect(host.geographicAnchor.zoom).toBe(2);
        expect([...host.getRenderView().camera.projection]).toEqual([...new Float32Array(viewport.viewProjectionMatrix)]);
    }
    expect(ProjectedBasemapLayer.layerName).toBe('ProjectedBasemapLayer');
});

test('rejects geographic cameras, automatic detail and invalid single-world footprints', () => {
    const options = {projection: {type: 'equal-earth' as const}, tileZoom: 2, visibleBounds: [-170, -80, 170, 80] as const};
    expect(() => getProjectedViewFrame(new WebMercatorViewport({width: 640, height: 360}), options)).toThrow('OrthographicView');
    const frame = getProjectedViewFrame(createViewport(), options);
    expect(() => new HostFrame({...frame, tileZoom: undefined})).toThrow('explicit tileZoom');
    expect(() => new HostFrame({...frame, tileLOD: {}})).toThrow('automatic LOD');
    for (const bounds of [[-181, -80, 170, 80], [-170, -90, 170, 80], [100, -80, -100, 80]]) {
        expect(() => HostFrame.from({...frame, projection: {type: 'projected', visibleBounds: bounds}})).toThrow();
    }
});

test('prepares an inline scene without mutating authored records and deduplicates its worker URL', () => {
    const original = {scene: {background: {color: '#000000'}, scripts: ['https://example.test/other.js']},
        sources: {}, layers: {ground: {draw: {polygons: {order: 0, color: '#fff'}}}}};
    const prepared = createProjectedBasemapScene(original, {type: 'equal-earth'}, 'https://example.test/projection.js');
    expect(prepared.sources).toBe(original.sources);
    expect(prepared.scene).toEqual({...original.scene, scripts: ['https://example.test/other.js', 'https://example.test/projection.js'],
        cpu_projection: {type: 'equal-earth', maxAngularSpan: 4, maxAdditionalVertices: 65536}});
    expect(original.scene.scripts).toEqual(['https://example.test/other.js']);
    expect(createProjectedBasemapScene(prepared, {type: 'albers'}, 'https://example.test/projection.js').scene).toMatchObject({
        scripts: ['https://example.test/other.js', 'https://example.test/projection.js']});
});

test.each([
    {import: 'scene.yaml'},
    {styles: {road: {base: 'points'}}},
    {styles: {ground: {base: 'polygons', draw: {extrude: true}}}},
    {styles: {ground: {base: 'raster', draw: {z: 1}}}},
    {styles: {ground: {base: 'polygons', draw: {interactive: true}}}},
    {styles: {shape: {base: 'polygons', shaders: {blocks: {position: 'position.x += 1.;'}}}}},
    {layers: {ground: {draw: {lines: {order: 0}}}}},
    {layers: {ground: {draw: {polygons: {order: 0, extrude: true}}}}},
    {layers: {ground: {draw: {polygons: {order: 0, interactive: true}}}}},
    {scene: {scripts: 'worker.js'}}
])('rejects unsupported scene capabilities before loading: %j', scene => {
    expect(() => createProjectedBasemapScene(scene, {type: 'equal-earth'}, 'https://example.test/projection.js')).toThrow();
});

test('layer filter/data property names are not mistaken for nested draw blocks', () => {
    const scene = {styles: {ground: {base: 'polygons', draw: {extrude: false}}}, layers: {
        ground: {data: {source: 'map', draw: 'metadata'}, filter: {draw: 'fill'},
            draw: {ground: {order: 0}}, child: {filter: {draw: 'outline'}, draw: {polygons: {order: 1}}}}
    }};
    expect(() => createProjectedBasemapScene(scene, {type: 'mercator'}, 'https://example.test/projection.js')).not.toThrow();
    expect(() => createProjectedBasemapScene({...scene, layers: {ground: {child: {draw: {points: {order: 0}}}}}},
        {type: 'mercator'}, 'https://example.test/projection.js')).toThrow('flat');
});

test.each(['filter', 'data', 'draw', 'priority', 'visible', 'enabled', 'exclusive'])(
    'root layer named %s is validated before loading, even when it resembles an internal configuration key', name => {
        const scene = {layers: {[name]: {data: {source: 'map'}, draw: {polygons: {order: 0}}}}};
        expect(() => createProjectedBasemapScene(scene, {type: 'equal-earth'}, 'https://example.test/projection.js')).not.toThrow();
        const unsupported = {layers: {[name]: {data: {source: 'map'}, draw: {points: {order: 0}}}}};
        expect(() => createProjectedBasemapScene(unsupported, {type: 'equal-earth'}, 'https://example.test/projection.js')).toThrow('flat');
    });

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)('the %s layer dispatches the opt-in adapter and reports invalid views', type => {
    const scene = createProjectedBasemapScene({sources: {}, layers: {}}, {type}, 'https://example.test/projection.js');
    const onSceneError = vi.fn();
    const layer = new ProjectedBasemapLayer({id: 'fixture', scene, onSceneError});
    const viewport = createViewport();
    let viewports = [viewport];
    layer.context = {viewport, deck: {getViewports: () => viewports}};
    layer.raiseError = vi.fn();
    const setFrame = vi.fn();
    const record = {renderer: {setFrame}, deckCanvas: {clientWidth: 0, clientHeight: 0},
        lastViewportError: null, reportedViewportError: null};
    layer._synchronizeTangramScene(record);
    expect(setFrame).toHaveBeenCalledOnce();
    expect(new HostFrame(setFrame.mock.calls[0][0]).projection).toEqual({type: 'projected',
        visibleBounds: type === 'albers' ? [-170, 5, -40, 75] : [-180, -85.0511287798066, 180, 85.0511287798066]});
    viewports = [viewport, viewport];
    layer._synchronizeTangramScene(record);
    layer._synchronizeTangramScene(record);
    expect(layer.raiseError).toHaveBeenCalledOnce();
    expect(onSceneError).not.toHaveBeenCalled();
    expect(record.lastViewportError).toContain('one deck.gl viewport');
    expect(setFrame).toHaveBeenCalledOnce();
});

test('fixed-meter roads accept style defaults, aliases and ordinary caps/joins', () => {
    for (const width of [1000, '1000m', ' 1000 m ']) {
        const scene = {styles: {road: {base: 'lines', draw: {width}}}, layers: {
            roads: {draw: {road: {order: 1, cap: 'round', join: 'bevel'}}},
            alias: {draw: {custom: {style: 'road', order: 2}}},
            builtin: {draw: {lines: {width, order: 3}}}
        }};
        expect(() => createProjectedBasemapScene(scene, {type: 'equal-earth'}, 'https://example.test/projection.js')).not.toThrow();
    }
});

test.each([undefined, 0, -1, Infinity, '3km', [1, 2], [[2, '5m']], 'function() {return 10;}'])(
    'projected roads reject nonfixed or missing width %j before starting workers', width => {
        const scene = {layers: {roads: {draw: {lines: {width, order: 1}}}}};
        expect(() => createProjectedBasemapScene(scene, {type: 'equal-earth'}, 'https://example.test/projection.js')).toThrow('fixed-meter');
    });

test.each(['outline', 'texture', 'dash', 'animated', 'next_width', 'next_offset'])(
    'projected road %s cannot enter through draws or inherited style configuration', key => {
        const draw = {width: '1000m', order: 1, [key]: 1};
        for (const scene of [
            {layers: {roads: {draw: {lines: draw}}}},
            {styles: {road: {base: 'lines', draw}}, layers: {roads: {draw: {road: {order: 1}}}}},
            {styles: {road: {base: 'lines', [key]: 1}}, layers: {roads: {draw: {road: {width: '1000m'}}}}}
        ]) expect(() => createProjectedBasemapScene(scene, {type: 'equal-earth'}, 'https://example.test/projection.js')).toThrow();
    });

test.each(['12px', '12000m'])('static %s roads accept offsets, parent outlines, dashes and portable traffic', width => {
    const suffix = width.endsWith('px') ? 'px' : 'm';
    const scene = {styles: {traffic: {base: 'lines', animated: true, dash: [2, 1]}},
        layers: {roads: {draw: {traffic: {width, offset: `-2${suffix}`, color: '#0ff',
            outline: {width: `1${suffix}`, color: '#80f'}}}}}};
    expect(() => createProjectedBasemapScene(scene, {type: 'equal-earth'}, 'https://example.test/worker.js')).not.toThrow();
    scene.layers.roads.draw.traffic.outline.width = suffix === 'px' ? '1m' : '1px';
    expect(() => createProjectedBasemapScene(scene, {type: 'equal-earth'}, 'https://example.test/worker.js')).toThrow('width unit');
});

test('explicit draw style cannot bypass supported-style validation', () => {
    expect(() => createProjectedBasemapScene({layers: {ground: {draw: {polygons: {style: 'text'}}}}},
        {type: 'equal-earth'}, 'https://example.test/projection.js')).toThrow('flat');
});

test('road widths inherit through child layers, while unsupported child overrides fail early', () => {
    const scene = {layers: {roads: {draw: {lines: {order: 1, width: '5000m'}},
        primary: {filter: {class: 'primary'}, draw: {lines: {color: '#fff'}}}}}};
    expect(() => createProjectedBasemapScene(scene, {type: 'equal-earth'}, 'https://example.test/projection.js')).not.toThrow();
    expect(() => createProjectedBasemapScene({layers: {roads: {...scene.layers.roads,
        primary: {draw: {lines: {width: [[2, '2px']]}}}}}}, {type: 'equal-earth'}, 'https://example.test/projection.js')).toThrow('fixed-meter');
});

test('custom ground styles and explicit bounds are supported, but invalid settings and Albers footprints fail', () => {
    const scene = createProjectedBasemapScene({styles: {ground: {base: 'polygons', lighting: false}},
        layers: {ground: {draw: {ground: {order: 0, extrude: false}}}}}, {type: 'albers'}, 'https://example.test/projection.js');
    expect(scene).toHaveProperty('scene.cpu_projection.type', 'albers');
    expect(() => getProjectedViewFrame(createViewport(), {projection: {type: 'albers'}, tileZoom: 2,
        visibleBounds: [-180, -80, 180, 80]})).toThrow('Albers coverage');
    for (const invalid of [{styles: {shape: []}}, {scene: []}, {scene: {scripts: [42]}}, {layers: {draw: null}}]) {
        expect(() => createProjectedBasemapScene(invalid, {type: 'equal-earth'}, 'https://example.test/projection.js')).toThrow();
    }
    expect(() => createProjectedBasemapScene({}, {type: 'equal-earth'}, 'file:///projection.js')).toThrow('HTTP(S)');
});
