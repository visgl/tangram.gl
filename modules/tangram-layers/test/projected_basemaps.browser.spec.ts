// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {OrthographicView, WebMercatorViewport} from '@deck.gl/core';
import {HostFrame} from '@vis.gl/tangram-renderer/core';
import {createProjectedBasemapScene, getProjectedViewFrame, ProjectedBasemapLayer} from '../src/experimental/projected-basemaps';

/** Actual deck.gl OrthographicViewport, not a matrix-shaped mock. */
function createViewport(target: [number, number, number] = [0, 0, 0], zoom = -1) {
    return new OrthographicView({id: 'projected', flipY: false}).makeViewport({width: 640, height: 360,
        viewState: {target, zoom}})!;
}

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
    {styles: {road: {base: 'lines'}}},
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
    expect(() => createProjectedBasemapScene({...scene, layers: {ground: {child: {draw: {lines: {order: 0}}}}}},
        {type: 'mercator'}, 'https://example.test/projection.js')).toThrow('flat');
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
