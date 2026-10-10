// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Deck, OrthographicView, type Layer, type LayerProps} from '@deck.gl/core';
import {Matrix4} from '@math.gl/core';
import {HostFrame} from '@vis.gl/tangram-renderer/core';
import {submitEyeRenderPass} from '../../examples/webxr/submit-eye.js';
import {ProjectedBasemapLayer, createProjectedBasemapScene, ProjectedBasemapNavigation,
  selectProjectedTileDetail} from '@vis.gl/tangram-layers/experimental/projected-basemaps';
import {RenderingHarness, coloredPixels, readCanvasPixels, DEVICE_TYPE} from './harness';
import {createRasterScene} from './scene';
import type Scene from '../../modules/tangram-renderer/src/scene/scene';
import type {HostTileResourceOptions, ProjectedBasemapOptions, ProjectionExecutionOptions, Renderer} from '@vis.gl/tangram-renderer/core';
import type {ProjectionEngine} from '@math.gl/projection/types';
import {createProjectedExampleProjectionEngine} from '../../examples/projected/projection-engine.js';

let harness: RenderingHarness | undefined;
let deck: Deck<OrthographicView> | undefined;
/** Dynamic layer factories do not yet emit a public subclass declaration. */
type FixtureProperties = {scene: Record<string, unknown>; projectedTileZoom: number; onSceneError: (error: Error) => void;
  projectionEngine?: ProjectionEngine;
  projectionEngineExecution?: ProjectionExecutionOptions;
  projectedVisibleBounds?: readonly [number, number, number, number];
  projectedStyleZoom?: number; projectedMaxTiles?: number; tileResources?: HostTileResourceOptions;
  projectedProjection?: ProjectedBasemapOptions; onProjectionChange?: () => void; onSceneLoad?: (scene: Scene) => void};
const FixtureLayer = ProjectedBasemapLayer as unknown as new (properties: FixtureProperties & LayerProps) => Layer & Pick<ProjectedBasemapLayer, 'getFeatureAt'>;

/** Offline continental polygon, including tile boundaries and a hole in the projected surface. */
function createPolygonScene(interactive = false) {
  const fixture = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
    type: 'Polygon', coordinates: [
      [[-140, 15], [-60, 15], [-60, 60], [-140, 60], [-140, 15]],
      [[-110, 30], [-110, 45], [-90, 45], [-90, 30], [-110, 30]]
    ]
  }}]};
  return {scene: {background: {color: '#000000'}}, sources: {fixture: {type: 'GeoJSON',
    url: `data:application/json,${encodeURIComponent(JSON.stringify(fixture))}`, max_zoom: 6}},
  layers: {ground: {data: {source: 'fixture'}, draw: {polygons: {order: 0, color: '#20d0b0', interactive}}}}};
}

/** Offline bent roads cross source-tile boundaries and exercise all standard caps and joins. */
function createRoadScene(maximumSourceZoom = 6, interactive = false) {
  const features = ['round', 'square', 'butt'].map((cap, index) => ({type: 'Feature', properties: {cap}, geometry: {
    type: 'LineString', coordinates: [[-150, 20 + index * 12], [-95, 35 + index * 8], [-50, 20 + index * 12]]
  }}));
  return {scene: {background: {color: '#000000'}}, sources: {roads: {type: 'GeoJSON',
    url: `data:application/json,${encodeURIComponent(JSON.stringify({type: 'FeatureCollection', features}))}`,
    max_zoom: maximumSourceZoom}}, layers: Object.fromEntries(['round', 'square', 'butt'].map((cap, index) => [cap, {
      data: {source: 'roads'}, filter: {cap}, draw: {lines: {order: 3 + index, width: '180000m', interactive,
        color: ['#ff2020', '#20ff20', '#ff8020'][index], cap, join: ['round', 'bevel', 'miter'][index]}}
    }]))};
}

beforeEach(() => commands.startRenderingDiagnostics());

test(`${DEVICE_TYPE}: projected collision hides buffered duplicates and lower priority annotations from rendering and selection`, async () => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const engine = createProjectedExampleProjectionEngine();
  const navigation = new ProjectedBasemapNavigation(engine);
  const target = await navigation.projectPosition([-90, 40], 'equal-earth');
  const source = {type: 'FeatureCollection', features: [
    {type: 'Feature', id: 1, properties: {name: 'Priority city', rank: 1}, geometry: {type: 'Point', coordinates: [-90, 40]}},
    {type: 'Feature', id: 2, properties: {name: 'Nearby city', rank: 2}, geometry: {type: 'Point', coordinates: [-89.99, 40]}}
  ]};
  const scene = createProjectedBasemapScene({scene: {background: {color: '#000'}},
    sources: {cities: {type: 'GeoJSON', url: `data:application/json,${encodeURIComponent(JSON.stringify(source))}`, max_zoom: 6}},
    layers: Object.fromEntries([1, 2].map(rank => [`city${rank}`, {data: {source: 'cities'}, filter: {rank}, draw: {
      points: {order: 10, size: '20px', priority: rank, color: rank === 1 ? '#ff0000' : '#00ff00', interactive: true}
    }}]))}, {type: 'equal-earth'}, new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  const errors = harness.errors;
  const layer = new FixtureLayer({id: 'colliding-cities', scene, projectionEngine: engine,
    projectedTileZoom: 4, projectedStyleZoom: 6, projectedVisibleBounds: [-91, 39, -89, 41],
    onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas: harness.canvas, device: harness.device, width: 512, height: 320,
    useDevicePixels: false, views: new OrthographicView({id: 'projected', flipY: false}),
    viewState: {target, zoom: 8}, _animate: true, layers: [layer], onError: error => errors.push(error.message)});
  const count = async (channel: number) => {
    const pixels = (await readCanvasPixels(harness!.canvas)).data;
    let colored = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset + channel] > 100 && pixels[offset + 1 - channel] < 40) colored++;
    return colored;
  };
  await expect.poll(() => count(0), {timeout: 20000}).toBeGreaterThan(150);
  expect(await count(1)).toBe(0);
  expect((await layer.getFeatureAt({x: 256, y: 160}))?.feature).toMatchObject({id: 1});
  // A pixel beyond the retained red point is empty: the hidden green quad must not be pickable.
  expect((await layer.getFeatureAt({x: 271, y: 160}))?.feature).toBeFalsy();
  deck.setProps({viewState: {target, zoom: 11}});
  await expect.poll(() => count(1), {timeout: 15000}).toBeGreaterThan(150);
  // The source anchor is quantized in the worker; query an actually rendered green pixel.
  const image = await readCanvasPixels(harness.canvas);
  const greenPixel = Array.from({length: image.data.length / 4}, (_, index) => index).find(index =>
    image.data[index * 4 + 1] > 150 && image.data[index * 4] < 40);
  if (greenPixel === undefined) throw new Error('Missing reappeared annotation');
  expect((await layer.getFeatureAt({x: greenPixel % image.width, y: Math.floor(greenPixel / image.width)},
    {coordinateSpace: 'canvas', radius: 4}))?.feature).toMatchObject({id: 2});
  expect(errors).toEqual([]);
  navigation.dispose();
});

test(`${DEVICE_TYPE}: simultaneous stereo queries retain different eye cameras and independent readback targets`, async () => {
  harness = new RenderingHarness();
  const source = {type: 'FeatureCollection', features: [-100, -80].map((longitude, index) => ({
    type: 'Feature', id: index + 1, properties: {name: `Eye ${index + 1}`}, geometry: {type: 'Point', coordinates: [longitude, 40]}
  }))};
  const scene = createProjectedBasemapScene({scene: {background: {color: '#000'}},
    sources: {cities: {type: 'GeoJSON', url: `data:application/json,${encodeURIComponent(JSON.stringify(source))}`}},
    layers: {cities: {data: {source: 'cities'}, draw: {points: {order: 1, size: '30px', color: '#00ff00', interactive: true}}}}},
    {type: 'equal-earth'}, new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  await harness.initialize(scene);
  const navigation = new ProjectedBasemapNavigation(createProjectedExampleProjectionEngine());
  const targets = await Promise.all([-100, -80].map(longitude => navigation.projectPosition([longitude, 40], 'equal-earth')));
  const frame = new HostFrame({viewport: {width: 512, height: 320},
    projection: {type: 'projected', visibleBounds: [-110, 30, -70, 50]}, tileZoom: 2,
    geographicAnchor: {longitude: -90, latitude: 40, zoom: 6}, renderViews: targets.map((target, index) => ({
      id: index === 0 ? 'left' : 'right', viewport: {x: index * 256, y: 0, width: 256, height: 320},
      camera: {view: new Matrix4().translate([-target[0], -target[1], 0]),
        projection: new Matrix4().ortho({left: -2, right: 2, bottom: -2.5, top: 2.5, near: -1, far: 1}), position: [0, 0, 1]}
    }))});
  const draw = () => {
    for (const [index, eye] of frame.renderViews.entries()) {
      harness!.renderer.setFrame(frame, {renderViewId: eye.id});
      const pass = harness!.device.beginRenderPass({clearColor: index === 0 ? [0, 0, 0, 1] : false,
        clearDepth: index === 0 ? 1 : false, clearStencil: index === 0 ? 0 : false});
      pass.setParameters({viewport: [eye.viewport.x, eye.viewport.y, eye.viewport.width, eye.viewport.height],
        scissorRect: [eye.viewport.x, eye.viewport.y, eye.viewport.width, eye.viewport.height]});
      harness!.renderer.render({frame, renderPass: pass, renderViewId: eye.id, force: true});
      submitEyeRenderPass(harness!.device, pass);
    }
  };
  await expect.poll(async () => {draw(); return coloredPixels(await readCanvasPixels(harness!.canvas));},
    {timeout: 20000}).toBeGreaterThan(500);
  await expect.poll(() => Reflect.get(harness!.renderer.scene, 'selection_feature_count')).toBeGreaterThan(0);
  let completed = false;
  const queried = Promise.all([128, 384].map(x => harness!.renderer.getFeatureAt({x, y: 160}, {coordinateSpace: 'canvas'})))
    .then(results => {completed = true; return results;});
  await expect.poll(() => {draw(); return completed;}, {timeout: 20000}).toBe(true);
  const results = await queried;
  expect(results[0]).toMatchObject({renderViewId: 'left', feature: {id: 1}});
  expect(results[1]).toMatchObject({renderViewId: 'right', feature: {id: 2}});
  expect(harness.errors).toEqual([]);
  navigation.dispose();
});

test.each(['equal-earth', 'albers'] as const)(`${DEVICE_TYPE}: %s selects refined road ribbons with original properties`, async type => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const engine = createProjectedExampleProjectionEngine();
  const navigation = new ProjectedBasemapNavigation(engine);
  const target = await navigation.projectPosition([-95, 35], type);
  const scene = createProjectedBasemapScene(createRoadScene(6, true), {type},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  const errors = harness.errors;
  const layer = new FixtureLayer({id: 'selected-roads', scene, projectionEngine: engine,
    projectedTileZoom: 2, projectedStyleZoom: 6, projectedVisibleBounds: [-160, 10, -40, 65],
    onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas: harness.canvas, device: harness.device, width: 512, height: 320,
    useDevicePixels: false, views: new OrthographicView({id: 'projected', flipY: false}),
    viewState: {target, zoom: -1.5}, _animate: true, layers: [layer], onError: error => errors.push(error.message)});
  await expect.poll(async () => coloredPixels(await readCanvasPixels(harness!.canvas)), {timeout: 20000}).toBeGreaterThan(500);
  await expect.poll(async () => (await layer.getFeatureAt({x: 256, y: 160}))?.feature, {timeout: 20000})
    .toMatchObject({properties: {cap: 'round'}, source_name: 'roads'});
  expect(errors).toEqual([]);
});

test.each(['equal-earth', 'albers'] as const)(`${DEVICE_TYPE}: %s selects refined polygons, excludes holes and preserves feature identity`, async type => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const engine = createProjectedExampleProjectionEngine();
  const navigation = new ProjectedBasemapNavigation(engine);
  const target = await navigation.projectPosition([-100, 40], type);
  const authored = createPolygonScene(true);
  const scene = createProjectedBasemapScene(authored, {type, cacheProjectedMeshes: true},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  const errors = harness.errors;
  let loadedScene: Scene | undefined;
  const layer = new FixtureLayer({id: 'selected-ground', scene, projectionEngine: engine,
    projectedTileZoom: 2, projectedStyleZoom: 6, projectedVisibleBounds: [-150, 10, -50, 65],
    onSceneLoad: scene => {loadedScene = scene;}, onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas: harness.canvas, device: harness.device, width: 512, height: 320,
    useDevicePixels: false, views: new OrthographicView({id: 'projected', flipY: false}),
    viewState: {target, zoom: -1.5}, _animate: true, layers: [layer], onError: error => errors.push(error.message)});
  await expect.poll(() => loadedScene, {timeout: 20000}).toBeDefined();
  await expect.poll(async () => coloredPixels(await readCanvasPixels(harness!.canvas)), {timeout: 20000}).toBeGreaterThan(1000);
  const point = await navigation.projectPosition([-120, 50], type);
  const [x, y] = deck.getViewports()[0].project(point);
  // An off-center sample catches backend row flips; the hole must not return the surrounding polygon.
  expect(y).not.toBeCloseTo(160, 0);
  const result = await layer.getFeatureAt({x, y});
  expect(result?.error).toBeUndefined();
  expect(result?.feature).toMatchObject({source_name: 'fixture', layers: ['ground']});
  const hole = await navigation.projectPosition([-100, 40], type);
  const [holeX, holeY] = deck.getViewports()[0].project(hole);
  expect((await layer.getFeatureAt({x: holeX, y: holeY}))?.feature).toBeFalsy();
  const repeated = await layer.getFeatureAt({x, y});
  expect(repeated?.feature).toEqual(result?.feature);
  expect(errors).toEqual([]);
});

test.each([
    {lighting: 'vertex', native: true}, {lighting: 'fragment', native: true},
    {lighting: 'vertex', native: false}, {lighting: 'fragment', native: false}
] as const)(`${DEVICE_TYPE}: elevated projected roofs render $lighting lighting; native=$native`, async ({lighting, native}) => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const navigation = new ProjectedBasemapNavigation(createProjectedExampleProjectionEngine());
    const point = await navigation.projectPosition([-100, 40], 'equal-earth');
    const source = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({type: 'FeatureCollection', features: [{
        type: 'Feature', properties: {height: 100}, geometry: {type: 'Polygon', coordinates: [[
            [-100.005, 39.995], [-99.995, 39.995], [-99.995, 40.005], [-100.005, 40.005], [-100.005, 39.995]
        ]]}
    }]}))}`;
    const scene = createProjectedBasemapScene({sources: {building: {type: 'GeoJSON', url: source, max_zoom: 6}},
        lights: native ? [{type: 'directional', color: [255, 0, 0], intensity: 0.5, direction: [0, 0, -1]}] :
            {sun: {type: 'directional', diffuse: [0.5, 0, 0], ambient: 0, direction: [0, 0, -1]}},
        styles: {building: {base: 'polygons', lighting, material: {ambient: 0, diffuse: 1, specular: 0}}},
        layers: {building: {data: {source: 'building'}, draw: {building: {order: 0, color: '#fff', extrude: true}}}}},
        {type: 'equal-earth', allowElevation: true}, `${location.origin}/modules/tangram-renderer/dist/projected-basemaps-worker.js`);
    const errors: Error[] = [];
    deck = new Deck({canvas: harness.canvas, width: '100%', height: '100%', device: harness.device!, useDevicePixels: 1,
        views: new OrthographicView({id: 'projected', flipY: false}),
        initialViewState: {target: [point[0], point[1], 0.02], zoom: 12},
        layers: [new FixtureLayer({id: 'elevated', scene, projectedTileZoom: 6,
            projectedVisibleBounds: [-101, 39, -99, 41], onSceneError: error => errors.push(error)})],
        onError: error => errors.push(error)});
    await expect.poll(async () => {
        const pixels = (await readCanvasPixels(harness!.canvas)).data;
        let lit = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
            if (pixels[offset] > 115 && pixels[offset] < 140 && pixels[offset + 1] < 10 && pixels[offset + 2] < 10) lit++;
        }
        return lit;
    }, {timeout: 15000}).toBeGreaterThan(100);
    expect(errors).toEqual([]);
    navigation.dispose();
});

test.each(['vertex', 'fragment'] as const)(`${DEVICE_TYPE}: projected %s lighting uses transformed visible wall normals`, async lighting => {
    harness = new RenderingHarness();
    const navigation = new ProjectedBasemapNavigation(createProjectedExampleProjectionEngine());
    const target = await navigation.projectPosition([-130, 50], 'albers');
    // Independently derive the west wall's common-space normal perpendicular
    // to its north tangent. Albers rotates it away from the packed [-1,0,0].
    const south = await navigation.projectPosition([-130.005, 49.999999], 'albers');
    const north = await navigation.projectPosition([-130.005, 50.000001], 'albers');
    const tangent = [north[0] - south[0], north[1] - south[1]];
    const expectedRed = 127.5 * tangent[1] / Math.hypot(...tangent) / Math.hypot(1, 0.15);
    const untransformedRed = 127.5 / Math.hypot(1, 0.15);
    expect(Math.abs(expectedRed - untransformedRed)).toBeGreaterThan(6);
    const source = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {height: 1000},
        geometry: {type: 'Polygon', coordinates: [[[-130.005, 49.995], [-129.995, 49.995],
            [-129.995, 50.005], [-130.005, 50.005], [-130.005, 49.995]]]}}]};
    const scene = createProjectedBasemapScene({scene: {background: {color: '#000'}},
        sources: {building: {type: 'GeoJSON', max_zoom: 6,
            url: `data:application/json,${encodeURIComponent(JSON.stringify(source))}`}},
        lights: {sun: {type: 'directional', diffuse: [0.5, 0, 0], ambient: 0, direction: [1, 0, -0.15]}},
        styles: {building: {base: 'polygons', lighting, material: {ambient: 0, diffuse: 1, specular: 0}}},
        layers: {building: {data: {source: 'building'}, draw: {building: {order: 0, color: '#fff', extrude: true}}}}},
        {type: 'albers', allowElevation: true}, new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
    await harness.initialize(scene);
    const scale = 2 ** 12;
    const projection = new Matrix4().ortho({left: -256 / scale, right: 256 / scale,
        bottom: -160 / scale, top: 160 / scale, near: 0.1, far: 100}).multiplyRight(new Matrix4().lookAt({
        eye: [target[0] - 1, target[1] - 1, 1], center: [target[0], target[1], 0.02], up: [0, 0, 1]
    }));
    const frame = new HostFrame({viewport: {width: 512, height: 320},
        projection: {type: 'projected', visibleBounds: [-131, 49, -129, 51]},
        geographicAnchor: {longitude: -130, latitude: 50, zoom: 6}, tileZoom: 6, tileBuffer: 0,
        renderViews: [{id: 'wall', camera: {view: new Float64Array(new Matrix4()),
            projection: new Float64Array(projection), position: [0, 0, 1]}}]});
    await expect.poll(async () => {
        harness!.renderer.setFrame(frame);
        const pass = harness!.device.beginRenderPass({clearColor: [0, 0, 0, 1], clearDepth: 1, clearStencil: 0});
        harness!.renderer.render({frame, renderPass: pass, force: true});
        submitEyeRenderPass(harness!.device, pass);
        const pixels = (await readCanvasPixels(harness!.canvas)).data;
        let walls = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            if (Math.abs(pixels[index] - expectedRed) < 4 && pixels[index + 1] < 10 && pixels[index + 2] < 10) walls++;
        }
        return walls;
    }, {timeout: 15000}).toBeGreaterThan(100);
    expect(harness.errors).toEqual([]);
    navigation.dispose();
});

test(`${DEVICE_TYPE}: elevated markers and attached/standalone text retain individual heights and stereo picking`, async () => {
  harness = new RenderingHarness();
  const source = {type: 'FeatureCollection', features: [0, 2000].map((height, index) => ({
    type: 'Feature', id: index + 1, properties: {height, name: `Height ${height}`},
    geometry: {type: 'Point', coordinates: [-100, 40]}
  }))};
  const scene = createProjectedBasemapScene({scene: {background: {color: '#000'}},
    sources: {anchors: {type: 'GeoJSON', url: `data:application/json,${encodeURIComponent(JSON.stringify(source))}`}},
    layers: Object.fromEntries([0, 2000].map((height, index) => [`height${index}`, {
      data: {source: 'anchors'}, filter: {height}, draw: {
        points: {order: 1, z: height, size: '20px', color: index ? '#00ff00' : '#ff0000', collide: false, interactive: true,
          text: {text_source: 'name', collide: false, anchor: 'top', offset: [0, -12],
            font: {family: 'sans-serif', size: '18px', fill: index ? '#ffff00' : '#ffffff'}}},
        text: {order: 2, z: height, text_source: 'name', collide: false, interactive: true, offset: [0, 25],
          font: {family: 'sans-serif', size: '18px', fill: index ? '#00ffff' : '#0000ff'}}
      }
    }]))}, {type: 'equal-earth', allowElevation: true},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  await harness.initialize(scene);
  const navigation = new ProjectedBasemapNavigation(createProjectedExampleProjectionEngine());
  const target = await navigation.projectPosition([-100, 40], 'equal-earth');
  const frame = new HostFrame({viewport: {width: 512, height: 320}, tileZoom: 2,
    projection: {type: 'projected', visibleBounds: [-101, 39, -99, 41]},
    geographicAnchor: {longitude: -100, latitude: 40, zoom: 6}, renderViews: [-0.01, 0.01].map((offset, index) => ({
      id: index ? 'right' : 'left', viewport: {x: index * 256, y: 0, width: 256, height: 320},
      camera: {view: new Matrix4().lookAt({eye: [target[0] + offset, target[1] - 1, 1],
        center: [target[0] + offset, target[1], 1000 * 256 / 6378137], up: [0, 0, 1]}),
        projection: new Matrix4().ortho({left: -128 / 2048, right: 128 / 2048, bottom: -240 / 2048,
          top: 240 / 2048, near: 0.1, far: 10}), position: [0, 0, 1]}
    }))});
  const draw = () => {
    for (const [index, eye] of frame.renderViews.entries()) {
      harness!.renderer.setFrame(frame, {renderViewId: eye.id});
      const pass = harness!.device.beginRenderPass({clearColor: index ? false : [0, 0, 0, 1],
        clearDepth: index ? false : 1, clearStencil: index ? false : 0});
      pass.setParameters({viewport: [eye.viewport.x, eye.viewport.y, eye.viewport.width, eye.viewport.height],
        scissorRect: [eye.viewport.x, eye.viewport.y, eye.viewport.width, eye.viewport.height]});
      harness!.renderer.render({frame, renderPass: pass, renderViewId: eye.id, force: true});
      submitEyeRenderPass(harness!.device, pass);
    }
  };
  /** Locate actual framebuffer colors so selection tests do not assume camera/pixel rounding. */
  const samples = async () => {
    const pixels = (await readCanvasPixels(harness!.canvas)).data;
    return [0, 1].map(eye => {
      const colors: number[][] = Array.from({length: 6}, () => []);
      for (let index = 0; index < pixels.length / 4; index++) {
        if (Math.floor(index % 512 / 256) !== eye) continue;
        const color = [pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]];
        const key = [[255, 0, 0], [0, 255, 0], [255, 255, 255], [255, 255, 0], [0, 0, 255], [0, 255, 255]]
          .findIndex(expected => expected.every((value, component) => Math.abs(value - color[component]) < 30));
        if (key >= 0) colors[key].push(index);
      }
      return colors;
    });
  };
  await expect.poll(async () => {draw(); expect(harness!.errors).toEqual([]);
    return (await samples()).map(colors => colors.map(color => color.length > 20));},
    {timeout: 20000}).toEqual([[true, true, true, true, true, true], [true, true, true, true, true, true]]);
  const colors = await samples();
  for (const eye of colors) {
    const meanY = (color: number[]) => color.reduce((sum, pixel) => sum + Math.floor(pixel / 512), 0) / color.length;
    expect(Math.abs(meanY(eye[0]) - meanY(eye[1]))).toBeGreaterThan(60);
    for (const index of [0, 1]) {
      expect(Math.abs(meanY(eye[index]) - meanY(eye[index + 2]))).toBeLessThan(40);
      expect(Math.abs(meanY(eye[index]) - meanY(eye[index + 4]))).toBeLessThan(40);
    }
  }
  let completed = false;
  const requests = colors.flatMap(eye => [0, 1, 4, 5].map(index => ({pixel: eye[index][Math.floor(eye[index].length / 2)], id: index % 2 + 1})));
  const queries = Promise.all(requests.map(({pixel}) => harness!.renderer.getFeatureAt(
    {x: pixel % 512, y: Math.floor(pixel / 512)}, {coordinateSpace: 'canvas', radius: 2})))
    .then(results => {completed = true; return results;});
  await expect.poll(() => {draw(); return completed;}, {timeout: 20000}).toBe(true);
  (await queries).forEach((result, index) => expect(result).toMatchObject({renderViewId: index < 4 ? 'left' : 'right',
    feature: {id: requests[index].id, properties: {height: requests[index].id === 1 ? 0 : 2000}}}));
  expect(harness.errors).toEqual([]);
  navigation.dispose();
});

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
  `${DEVICE_TYPE}: projected %s annotations retain pixel size and render attached/standalone atlas text`, async type => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const engine = createProjectedExampleProjectionEngine();
    const navigation = new ProjectedBasemapNavigation(engine);
    const target = await navigation.projectPosition([-100, 40], type);
    const source = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {name: 'Ground label'},
      geometry: {type: 'Point', coordinates: [-100, 40]}}]};
    const scene = createProjectedBasemapScene({scene: {background: {color: '#000'}},
      styles: {markers: {base: 'points', draw: {collide: false,
        text: type === 'albers' ? false : {collide: false}}}},
      sources: {annotations: {type: 'GeoJSON',
        url: `data:application/json,${encodeURIComponent(JSON.stringify(source))}`}},
      layers: {annotations: {data: {source: 'annotations'}, draw: {
        markers: {order: 10, size: '20px', color: '#00ff00', interactive: true,
          text: {text_source: 'name', ...(type === 'albers' ? {collide: false} : {}), anchor: 'top', offset: [0, -20],
            font: {family: 'sans-serif', size: '18px', fill: '#ffffff'}}},
        text: {order: 11, text_source: 'name', collide: false, interactive: true, offset: [0, 25],
          font: {family: 'sans-serif', size: '18px', fill: '#ff0000'}}
      }}}}, {type, cacheProjectedMeshes: true},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
    const errors = harness.errors, canvas = harness.canvas;
    deck = new Deck({canvas, device: harness.device, width: 512, height: 320,
      useDevicePixels: false, views: new OrthographicView({id: 'projected', flipY: false}),
      viewState: {target, zoom: 1}, _animate: true, onError: error => errors.push(error.message),
      layers: [new FixtureLayer({id: 'annotations', scene, projectionEngine: engine,
        projectedTileZoom: 2, projectedStyleZoom: 6, projectedVisibleBounds: [-130, 20, -70, 60],
        onSceneError: error => errors.push(error.message)})]});
    const counts = async () => {
      expect(errors).toEqual([]);
      const pixels = (await readCanvasPixels(canvas)).data;
      const result = {green: 0, white: 0, red: 0};
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
        if (green > 80 && red < 40 && blue < 40) result.green++;
        if (red > 80 && green > 80 && blue > 80) result.white++;
        if (red > 80 && green < 40 && blue < 40) result.red++;
      }
      return result;
    };
    await expect.poll(async () => (await counts()).green, {timeout: 20000}).toBeGreaterThan(150);
    await expect.poll(async () => (await counts()).white, {timeout: 20000}).toBeGreaterThan(100);
    await expect.poll(async () => (await counts()).red, {timeout: 20000}).toBeGreaterThan(100);
    const selectedLayer = deck.props.layers[0];
    if (!(selectedLayer instanceof ProjectedBasemapLayer)) throw new Error('Expected the projected annotation layer');
    expect((await selectedLayer.getFeatureAt({x: 256, y: 160}))?.feature).toMatchObject({properties: {name: 'Ground label'}});
    const atlas = (await readCanvasPixels(canvas)).data;
    const firstTextPixel = Array.from({length: atlas.length / 4}, (_, index) => index).find(index =>
      atlas[index * 4] > 80 && atlas[index * 4 + 1] < 40 && atlas[index * 4 + 2] < 40);
    if (firstTextPixel === undefined) throw new Error('Missing rendered standalone text');
    expect((await selectedLayer.getFeatureAt({x: firstTextPixel % 512, y: Math.floor(firstTextPixel / 512)}, {radius: 4}))?.feature)
      .toMatchObject({properties: {name: 'Ground label'}});
    const before = await counts();
    deck.setProps({viewState: {target, zoom: 3}});
    await expect.poll(async () => Math.abs((await counts()).green - before.green)).toBeLessThan(40);
    expect(errors).toEqual([]);
  });

test(`${DEVICE_TYPE}: projected pixel roads keep CSS width across zoom, with outlines, dashes and animated traffic`, async () => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors, canvas = harness.canvas;
  const source = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
    type: 'LineString', coordinates: [[-125, 40], [-75, 40]]}}]};
  const engine = createProjectedExampleProjectionEngine();
  const navigation = new ProjectedBasemapNavigation(engine);
  const target = await navigation.projectPosition([-100, 40], 'equal-earth');
  let sceneLoads = 0;
  let loadedScene: Scene | undefined;
  const createScene = (animated: boolean, dashed: boolean) => createProjectedBasemapScene({
    scene: {background: {color: '#000000'}}, styles: {traffic: {base: 'lines', animated}},
    sources: {roads: {type: 'GeoJSON', url: `data:application/json,${encodeURIComponent(JSON.stringify(source))}`, max_zoom: 6}},
    layers: {roads: {data: {source: 'roads'}, draw: {traffic: {width: [[4, '6px'], [6, '12px'], [8, '18px']],
      offset: [[4, '1px'], [6, '2px']], color: '#20d0b0',
      order: 2, outline: {width: [[4, '1px'], [6, '2px']] , color: '#f08020'}, ...(dashed ? {dash: [3, 2]} : {})}}}}
  }, {type: 'equal-earth', maxProjectedError: 0.5},
  new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  const layer = (scene: Record<string, unknown>) => new FixtureLayer({id: 'pixel-roads', scene, projectionEngine: engine,
    projectedTileZoom: 4, projectedStyleZoom: 6, projectedVisibleBounds: [-130, 30, -70, 50],
    onSceneLoad: value => {loadedScene = value; sceneLoads++;},
    onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false}), viewState: {target, zoom: 1},
    onError: error => errors.push(error.message), _animate: true, layers: [layer(createScene(false, false))]});
  const thickness = async () => {
    const pixels = (await readCanvasPixels(canvas)).data;
    let count = 0;
    for (let row = 0; row < 320; row++) {
      const offset = (row * 512 + 256) * 4;
      if (pixels[offset] + pixels[offset + 1] + pixels[offset + 2] > 100) count++;
    }
    return count;
  };
  await expect.poll(thickness, {timeout: 20000}).toBeGreaterThan(8);
  const before = await thickness();
  expect(before).toBeLessThanOrEqual(20);
  deck.setProps({viewState: {target, zoom: 3}});
  // Thickness is deliberately zoom-invariant; polling it can accept the old
  // frame. Draw the new camera before recording the solid-area comparison.
  deck.redraw('sample projected road camera');
  await expect.poll(thickness).toBeGreaterThan(8);
  expect(Math.abs(await thickness() - before)).toBeLessThanOrEqual(2);
  const greenPixels = async () => {
    const pixels = (await readCanvasPixels(canvas)).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 1] > 80 && pixels[index + 1] > pixels[index] * 1.5) count++;
    return count;
  };
  const solidPixels = await greenPixels();
  expect(solidPixels).toBeGreaterThan(500);
  deck.setProps({layers: [layer(createScene(false, true))]});
  await expect.poll(() => sceneLoads, {timeout: 20000}).toBe(2);
  // Static gaps must remove substantial road area; animation alone cannot satisfy this.
  await expect.poll(async () => {
    const count = await greenPixels();
    return count > solidPixels * 0.1 && count < solidPixels * 0.8;
  }, {timeout: 20000, message: 'Static dashes must render visible strokes and gaps, not a loading frame'}).toBe(true);
  deck.setProps({layers: [layer(createScene(true, true))]});
  await expect.poll(() => sceneLoads, {timeout: 20000}).toBe(3);
  await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas)), {timeout: 20000}).toBeGreaterThan(100);
  await expect.poll(() => {
    const resources = loadedScene?.tile_manager.getResourceStatistics();
    return resources ? resources.activeBuilds + resources.queuedBuilds : -1;
  }, {timeout: 20000}).toBe(0);
  // Capture only after the animated scene has loaded and finished building;
  // replacing the static scene must not count as shader animation.
  const previous = (await readCanvasPixels(canvas)).data;
  await expect.poll(async () => {
    const current = (await readCanvasPixels(canvas)).data;
    let changed = 0;
    for (let index = 0; index < current.length; index++) if (current[index] !== previous[index]) changed++;
    return changed;
  }, {timeout: 10000}).toBeGreaterThan(20);
  expect(errors).toEqual([]);
  navigation.dispose();
});
afterEach(async () => {
  try {
    expect(harness?.errors || []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
  } finally {
    try {
      if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName || 'projected',
        harness.canvas.toDataURL('image/png'));
    } finally {
      deck?.finalize();
      deck = undefined;
      harness?.destroy();
      harness = undefined;
    }
  }
});

test.each(['equal-earth', 'albers'] as const)(`${DEVICE_TYPE}: %s fit, inverse probe and camera detail keep one warm scene`, async type => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const projectionEngine = createProjectedExampleProjectionEngine();
  const navigation = new ProjectedBasemapNavigation(projectionEngine);
  const bounds = [-170, 5, -40, 75] as const;
  const fitted = await navigation.fitBounds(bounds, {width: 512, height: 320}, type);
  const scene = createProjectedBasemapScene(createPolygonScene(), {type},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  let loadedScene: Scene | undefined;
  let loads = 0;
  const createLayer = (detail: number, visibleBounds: readonly [number, number, number, number] = bounds, visible = true) => new FixtureLayer({id: 'navigate-projected-fixture', scene, projectionEngine,
    projectedTileZoom: detail, projectedStyleZoom: 6, projectedMaxTiles: 256, projectedVisibleBounds: visibleBounds, visible,
    onSceneLoad: value => {loadedScene = value; loads++;}, onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false, controller: true}), viewState: fitted,
    onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer(1)]});
  try {
    const waitForGround = async () => expect.poll(async () => {
      expect(errors).toEqual([]);
      return coloredPixels(await readCanvasPixels(canvas));
    }, {timeout: 20000}).toBeGreaterThan(500);
    await waitForGround();
    if (!loadedScene) throw new Error('Projected scene did not load');
    const initialScene = loadedScene;
    const workers = Reflect.get(initialScene, 'workers');
    const viewport = deck.getViewports()[0];
    const focus = await navigation.projectPosition([-125, 35], type);
    const screen = viewport.project(focus);
    const geographic = await navigation.unprojectScreenPosition(viewport, [screen[0], screen[1]], type);
    expect(geographic?.[0]).toBeCloseTo(-125, 6);
    expect(geographic?.[1]).toBeCloseTo(35, 6);
    const options = {visibleBounds: bounds, minZoom: 1, maxZoom: 3, maxTiles: 256, targetTilePixels: 512};
    const coarse = await selectProjectedTileDetail(navigation, viewport, type, options);
    deck.setProps({viewState: {target: focus, zoom: fitted.zoom + 2}});
    await expect.poll(() => deck?.getViewports()[0].zoom).toBeCloseTo(fitted.zoom + 2);
    const fine = await selectProjectedTileDetail(navigation, deck.getViewports()[0], type, options);
    expect(fine.tileZoom).toBeGreaterThan(coarse.tileZoom);
    expect(fine.candidateCount).toBeLessThanOrEqual(256);
    const coverage = await navigation.getCameraCoverage(deck.getViewports()[0], type, bounds);
    if (!coverage.bounds) throw new Error('Expected visible projected coverage');
    expect(coverage.domainFallback).toBe(false);
    expect(coverage.bounds[2] - coverage.bounds[0]).toBeLessThan(bounds[2] - bounds[0]);
    deck.setProps({layers: [createLayer(fine.tileZoom, coverage.bounds)]});
    await waitForGround();
    // Off-domain cameras hide the layer without destroying its warm renderer and workers.
    deck.setProps({layers: [createLayer(fine.tileZoom, coverage.bounds, false)]});
    await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas))).toBe(0);
    deck.setProps({viewState: fitted, layers: [createLayer(1)]});
    await waitForGround();
    expect(loadedScene).toBe(initialScene);
    expect(Reflect.get(initialScene, 'workers')).toBe(workers);
    expect(loads).toBe(1);
  } finally {
    navigation.dispose();
  }
});

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
  `${DEVICE_TYPE}: projected %s polygons and raster use the packaged worker and OrthographicView`, async type => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const errors = harness.errors;
    const canvas = harness.canvas;
    const workerUrl = new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href;
    const createLayer = (raster: boolean) => new FixtureLayer({id: 'projected-fixture', projectedTileZoom: 2,
      scene: createProjectedBasemapScene(raster ? createRasterScene() : createPolygonScene(), {type, maxProjectedError: 2}, workerUrl),
      onSceneError: error => errors.push(error.message)});
    deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
      views: new OrthographicView({id: 'projected', flipY: false}),
      initialViewState: {target: [0, 0, 0], zoom: type === 'albers' ? -1 : -2},
      onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer(false)]});
    await expect.poll(async () => {
      expect(errors).toEqual([]);
      return coloredPixels(await readCanvasPixels(canvas));
    }, {timeout: 20000, interval: 100}).toBeGreaterThan(500);
    deck.setProps({layers: [createLayer(true)]});
    await expect.poll(async () => {
      expect(errors).toEqual([]);
      const image = await readCanvasPixels(canvas);
      let orange = 0;
      for (let offset = 0; offset < image.data.length; offset += 4) {
        if (image.data[offset] > 140 && image.data[offset + 1] < 160 && image.data[offset + 2] < 100) orange++;
      }
      return orange;
    }, {timeout: 20000, interval: 100}).toBeGreaterThan(500);
  }
);

test.each([
  {raster: false, injected: false, cached: false}, {raster: true, injected: false, cached: false},
  {raster: false, injected: true, cached: false}, {raster: true, injected: true, cached: false},
  {raster: false, injected: false, cached: true}, {raster: true, injected: true, cached: true}
])(`${DEVICE_TYPE}: projection switches retain tiles/workers (raster=$raster, injected=$injected, cached=$cached)`, async ({raster, injected, cached}) => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const scene = createProjectedBasemapScene(raster ? createRasterScene() : createPolygonScene(), {type: 'equal-earth', cacheProjectedMeshes: cached},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  let loadedScene: Scene | undefined;
  let completedProjection = '';
  let loadCount = 0;
  const engine = createProjectedExampleProjectionEngine();
  const compiledTypes: unknown[] = [];
  const projectionEngine: ProjectionEngine | undefined = injected ? {
    createProjection: options => engine.createProjection(options),
    createProjectionAsync: options => {compiledTypes.push(options); return engine.createProjectionAsync(options);}
  } : undefined;
  const projectionEngineExecution = {maxBatchPositions: 128};
  const createLayer = (type: ProjectedBasemapOptions['type']) => new FixtureLayer({id: 'warm-projected-fixture',
    scene, projectedTileZoom: 2, projectedProjection: {type, cacheProjectedMeshes: cached}, projectionEngine, projectionEngineExecution,
    onSceneLoad: value => {loadedScene = value; loadCount++;},
    onProjectionChange: () => {completedProjection = type;}, onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false}),
    initialViewState: {target: [0, 0, 0], zoom: -2},
    onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer('equal-earth')]});
  await expect.poll(async () => {
    expect(errors).toEqual([]);
    return coloredPixels(await readCanvasPixels(canvas));
  }, {timeout: 20000, interval: 100}).toBeGreaterThan(500);
  await expect.poll(() => completedProjection).toBe('equal-earth');
  if (injected) expect(compiledTypes).toHaveLength(1);
  if (!loadedScene) throw new Error('Expected a loaded projected scene');
  const initialScene = loadedScene;
  const workers = Reflect.get(initialScene, 'workers');
  await expect.poll(async () => (await initialScene.getTileSourceStatistics())
    .reduce((count, value) => count + value.loadingTiles + value.queuedTiles, 0), {timeout: 20000}).toBe(0);
  const statistics = await initialScene.getTileSourceStatistics();
  // Eight raster tiles per worker across five projections exceed the 32-entry LRU.
  // Check a short warm round trip before intentionally exercising eviction.
  const sequence = cached
    ? ['albers', 'equal-earth', 'mercator', 'web-mercator', 'equirectangular', 'equal-earth'] as const
    : ['albers', 'mercator', 'web-mercator', 'equirectangular', 'equal-earth'] as const;
  for (const type of sequence) {
    deck.setProps({layers: [createLayer(type)]});
    await expect.poll(() => completedProjection, {timeout: 20000}).toBe(type);
    await expect.poll(async () => {
      expect(errors).toEqual([]);
      return coloredPixels(await readCanvasPixels(canvas));
    }, {timeout: 20000, interval: 100}).toBeGreaterThan(500);
    expect(loadedScene).toBe(initialScene);
    expect(loadCount).toBe(1);
    expect(Reflect.get(initialScene, 'workers')).toBe(workers);
    expect((await initialScene.getTileSourceStatistics()).map(value => value.acquisitions))
      .toEqual(statistics.map(value => value.acquisitions));
    const preparation = (await initialScene.getTileSourceStatistics()).map(value => value.projectionPreparation);
    expect(preparation.every(value => value && value.entries <= 64 && value.bytes <= 16 * 1024 * 1024)).toBe(true);
    if (cached) expect(preparation.every(value => !value?.projectedResults ||
      (value.projectedResults.entries <= 32 && value.projectedResults.bytes <= 16 * 1024 * 1024))).toBe(true);
  }
  const finalStatistics = await initialScene.getTileSourceStatistics();
  expect(finalStatistics.every(value => value.projectionWork !== undefined && value.projectionWork.failedMeshes === 0)).toBe(true);
  expect(finalStatistics.reduce((count, value) => count + (value.projectionWork?.completedMeshes ?? 0), 0))
    .toBeGreaterThan(statistics.reduce((count, value) => count + (value.projectionWork?.completedMeshes ?? 0), 0));
  expect(finalStatistics.reduce((hits, value) => hits + (value.projectionPreparation?.hits ?? 0), 0))
    .toBeGreaterThan(statistics.reduce((hits, value) => hits + (value.projectionPreparation?.hits ?? 0), 0));
  if (injected) {
    expect(compiledTypes).toHaveLength(5);
    await expect.poll(() => initialScene.getProjectionEngineStatistics()?.activeRequests).toBe(0);
    const hostWork = initialScene.getProjectionEngineStatistics();
    expect(hostWork).toMatchObject({maxBatchPositions: 128, failedRequests: 0, cancelledRequests: 0});
    expect(hostWork?.yieldCount).toBeGreaterThan(0);
    expect(hostWork?.batches).toBeGreaterThan(hostWork?.completedRequests ?? 0);
  } else expect(initialScene.getProjectionEngineStatistics()).toBeUndefined();
  if (cached) expect(finalStatistics.reduce((hits, value) => hits + (value.projectionPreparation?.projectedResults?.hits ?? 0), 0),
    JSON.stringify(finalStatistics.map(value => value.projectionPreparation))).toBeGreaterThan(0);
});

test.each([false, true])(`${DEVICE_TYPE}: source detail round trips retain style zoom, workers and warm tile meshes (injected %s)`, async injected => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const scene = createProjectedBasemapScene(createPolygonScene(), {type: 'equal-earth'},
    new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
  const projectionEngine = injected ? createProjectedExampleProjectionEngine() : undefined;
  let loadedScene: Scene | undefined;
  let loads = 0;
  const createLayer = (detail: number) => new FixtureLayer({id: 'detail-fixture', scene, projectionEngine,
    projectedTileZoom: detail, projectedStyleZoom: 4, projectedMaxTiles: 16,
    projectedVisibleBounds: [-170, 5, -40, 75],
    tileResources: {maxConcurrentBuilds: 2, maxCachedTiles: 16, maxCachedMeshBytes: 32 * 1024 * 1024},
    onSceneLoad: value => {loadedScene = value; loads++;}, onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false}), initialViewState: {target: [0, 0, 0], zoom: -2},
    onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer(1)]});
  await expect.poll(() => loadedScene, {timeout: 20000}).toBeDefined();
  if (!loadedScene) throw new Error('Expected a loaded detail scene');
  const initialScene = loadedScene;
  const workers = Reflect.get(initialScene, 'workers');
  /** Observe real scene tiles without widening its public API solely for a fixture. */
  const getVisibleTiles = () => Object.values(initialScene.tile_manager.tiles).filter(tile => tile.visible);
  /** Wait for installed detail and every scheduled build, not only a fallback's first pixel. */
  const waitForDetail = async (detail: number) => {
    // Auto-tiled GeoJSON uses 512px tiles: normalized data is one level below logical detail.
    const sourceZoom = Math.max(0, detail - 1);
    await expect.poll(() => {
      const tiles = getVisibleTiles();
      return tiles.length > 0 && tiles.every(tile => Reflect.get(tile, 'coords').z === sourceZoom && tile.built && Reflect.get(tile, 'style_z') === 4);
    }, {timeout: 20000}).toBe(true);
    await expect.poll(() => {
      const resources = initialScene.tile_manager.getResourceStatistics();
      return resources.activeBuilds + resources.queuedBuilds;
    }, {timeout: 20000}).toBe(0);
    await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas)), {timeout: 20000}).toBeGreaterThan(500);
    expect(errors).toEqual([]);
    expect(initialScene.view.zoom).toBe(4);
    const resources = initialScene.tile_manager.getResourceStatistics();
    expect(resources.activeBuilds).toBeLessThanOrEqual(2);
    expect(resources.cachedTiles).toBeLessThanOrEqual(16);
    expect(resources.cachedMeshBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  };
  await waitForDetail(1);
  const coarse = getVisibleTiles().map(tile => ({tile, meshes: tile.meshes, generation: tile.generation}));
  deck.setProps({layers: [createLayer(2)]});
  await waitForDetail(2);
  expect(getVisibleTiles().every(tile => !coarse.some(value => value.tile === tile))).toBe(true);
  deck.setProps({layers: [createLayer(1)]});
  await waitForDetail(1);
  expect(getVisibleTiles()).toHaveLength(coarse.length);
  for (const {tile, meshes, generation} of coarse) {
    expect(getVisibleTiles()).toContain(tile);
    expect(tile.meshes).toBe(meshes);
    expect(tile.generation).toBe(generation);
  }
  expect(loadedScene).toBe(initialScene);
  expect(Reflect.get(initialScene, 'workers')).toBe(workers);
  expect(loads).toBe(1);
});

test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
  `${DEVICE_TYPE}: projected %s road ribbons render through packaged worker and preserve warm sources`, async type => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const errors = harness.errors;
    const canvas = harness.canvas;
    let loadedScene: Scene | undefined;
    let completed = '';
    const engine = createProjectedExampleProjectionEngine();
    let engineCompilations = 0;
    const projectionEngine: ProjectionEngine | undefined = type === 'albers' ? {
      createProjection: options => engine.createProjection(options),
      createProjectionAsync: options => {engineCompilations++; return engine.createProjectionAsync(options);}
    } : undefined;
    // Force style zoom 2 over data zoom 1 to check packed extrusion overzoom.
    const scene = createProjectedBasemapScene(createRoadScene(1), {type},
      new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href);
    const createLayer = (projection: ProjectedBasemapOptions['type']) => new FixtureLayer({id: 'projected-road-fixture',
      scene, projectedTileZoom: 2, projectedProjection: {type: projection}, projectionEngine,
      projectedVisibleBounds: [-170, 5, -40, 75],
      onSceneLoad: value => {loadedScene = value;}, onProjectionChange: () => {completed = projection;},
      onSceneError: error => errors.push(error.message)});
    deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
      views: new OrthographicView({id: 'projected', flipY: false}),
      initialViewState: {target: [0, 0, 0], zoom: type === 'albers' ? -1 : -2},
      onError: error => {errors.push(error.message);}, _animate: true, layers: [createLayer(type)]});
    const waitForRoads = async () => {
      for (const road of ['round', 'square', 'butt']) await expect.poll(async () => {
        expect(errors).toEqual([]);
        const pixels = await readCanvasPixels(canvas);
        let matchingRoad = 0;
        for (let offset = 0; offset < pixels.data.length; offset += 4) {
          const red = pixels.data[offset], green = pixels.data[offset + 1], blue = pixels.data[offset + 2];
          if (blue < 70 && (road === 'round' ? red > 150 && green < 70 :
            road === 'square' ? green > 150 && red < 70 : red > 150 && green > 70 && green < 170)) matchingRoad++;
        }
        return matchingRoad;
      }, {timeout: 20000, interval: 100, message: `${type}: ${road} road must render independently`}).toBeGreaterThan(15);
    };
    await waitForRoads();
    await expect.poll(() => completed).toBe(type);
    if (projectionEngine) expect(engineCompilations).toBe(1);
    if (!loadedScene) throw new Error('Road scene did not load');
    const firstScene = loadedScene;
    const acquisitions = (await firstScene.getTileSourceStatistics()).map(value => value.acquisitions);
    const next = type === 'equal-earth' ? 'web-mercator' : 'equal-earth';
    deck.setProps({layers: [createLayer(next)]});
    await expect.poll(() => completed, {timeout: 20000}).toBe(next);
    await waitForRoads();
    expect(loadedScene).toBe(firstScene);
    expect((await firstScene.getTileSourceStatistics()).map(value => value.acquisitions)).toEqual(acquisitions);
    if (projectionEngine) expect(engineCompilations).toBe(2);
  });

test(`${DEVICE_TYPE}: a worker refinement failure rejects and a queued projection correction renders`, async () => {
  harness = new RenderingHarness();
  await harness.initializeDevice();
  const errors = harness.errors;
  const canvas = harness.canvas;
  const layer = new FixtureLayer({id: 'recover-projected-fixture', projectedTileZoom: 2,
    scene: createProjectedBasemapScene(createRasterScene(), {type: 'equal-earth'},
      new URL('/modules/tangram-renderer/dist/projected-basemaps-worker.js', location.href).href),
    onSceneError: error => errors.push(error.message)});
  deck = new Deck({canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
    views: new OrthographicView({id: 'projected', flipY: false}),
    initialViewState: {target: [0, 0, 0], zoom: -2},
    onError: error => {errors.push(error.message);}, _animate: true, layers: [layer]});
  await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas)),
    {timeout: 20000, interval: 100}).toBeGreaterThan(500);
  const state = Reflect.get(layer, 'state') as {tangramRecord: {renderer: Renderer}};
  const renderer = state.tangramRecord.renderer;
  const failed = renderer.setProjectedBasemapProjection({type: 'equal-earth', maxAdditionalVertices: 0});
  // Queue the original configuration immediately, before the worker replies.
  // It must rebuild even though the failed update restores those same options.
  const correction = renderer.setProjectedBasemapProjection({type: 'equal-earth'});
  await expect(failed).rejects.toThrow(/budget/);
  await correction;
  await expect.poll(async () => coloredPixels(await readCanvasPixels(canvas)),
    {timeout: 20000, interval: 100}).toBeGreaterThan(500);
  expect(errors).toEqual([]);
  const diagnostics = await commands.renderingDiagnostics();
  expect(diagnostics.length).toBeGreaterThan(0);
  for (const diagnostic of diagnostics) expect(diagnostic).toMatch(/budget/);
  // Only the deliberately induced and asserted failure is cleared. Teardown
  // still checks for unrelated errors or errors emitted after recovery.
  await commands.startRenderingDiagnostics();
});
