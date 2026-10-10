// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {_GlobeViewport as GlobeViewport} from '@deck.gl/core';
import {Buffer} from '@luma.gl/core';
import {TerrainMeshSurface} from '@vis.gl/tangram-renderer/core';
import pointsVertexGLSL from '../../modules/tangram-renderer/src/styles/points/points_vertex.glsl?raw';
import {GLOBE_VISIBILITY_WGSL} from '../../modules/tangram-renderer/src/styles/globe_visibility_wgsl';
import {GLOBE_PROJECTION_WGSL, GLOBE_PROJECTION_GLSL} from '../../modules/tangram-renderer/src/scene/projection_shaders';
import {submitEyeRenderPass} from '../../examples/webxr/submit-eye.js';
import {RenderingHarness, readCanvasPixels, DEVICE_TYPE} from './harness';

let harness: RenderingHarness | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors || []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
  } finally {
    if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName || 'labels',
      harness.canvas.toDataURL('image/png'));
    harness?.destroy();
    harness = undefined;
  }
});

/** Cover circles, point-attached atlas labels, and standalone/curved text's shader. */
type LabelKind = 'points' | 'attached-text' | 'text';

/** Keep overlay labels visible to the CPU; only the actual per-eye shader may occlude them. */
function createLabelDraw(kind: LabelKind, color: string, height = 0) {
  const font = {family: 'sans-serif', size: '24px', fill: color};
  const draw = {order: 1, color, z: height, collide: false, cull: false, interactive: true};
  return kind === 'text'
    ? {text: {...draw, text_source: 'name', font}}
    : {points: {...draw, size: '28px', ...(kind === 'attached-text' ? {
      text: {text_source: 'name', font, collide: false, anchor: 'top'}
    } : {})}};
}

/** One coarse offline world tile forces front- and far-side anchors to share the same mesh. */
function createLabelScene(kind: LabelKind, height = 0, longitude = -160, latitude = 20) {
  const data = {type: 'FeatureCollection', features: [
    {type: 'Feature', properties: {name: 'near'}, geometry: {type: 'Point', coordinates: [10, 20]}},
    {type: 'Feature', properties: {name: 'far'}, geometry: {type: 'Point', coordinates: [longitude, latitude]}}
  ]};
  return {
    scene: {background: {color: '#000000'}},
    sources: {labels: {type: 'GeoJSON', max_zoom: 0,
      url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data))}`}},
    layers: {
      near: {data: {source: 'labels'}, filter: {name: 'near'}, draw: createLabelDraw(kind, '#ff0000')},
      far: {data: {source: 'labels'}, filter: {name: 'far'}, draw: createLabelDraw(kind, '#00ff00', height)}
    }
  };
}

/** Count opaque red/green label pixels, without depending on font rasterization or exact glyph shapes. */
function countLabelPixels(image: ImageData, channel: 0 | 1, start = 0, end = image.width) {
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = start; x < end; x++) {
      const offset = (y * image.width + x) * 4;
      if (image.data[offset + channel] > 120 && image.data[offset + 1 - channel] < 60) count++;
    }
  }
  return count;
}

for (const kind of ['flat', 'globe'] as const) {
  test(`${DEVICE_TYPE}: ${kind} terrain picking uses the camera submitted to the real renderer`, async () => {
    harness = new RenderingHarness(kind);
    await harness.initialize();
    await harness.settle();
    const surface = kind === 'globe'
      ? new TerrainMeshSurface({projection: 'globe', positions: [-20, -256, -20, 20, -256, -20, 0, -256, 20], indices: [0, 1, 2]})
      : new TerrainMeshSurface({projection: 'web-mercator', positions: [-10000, -10000, 100, 10000, -10000, 100, 0, 10000, 100], indices: [0, 1, 2]});
    const hit = harness.renderer.getTerrainAt({x: 256, y: 160}, surface, {coordinateSpace: 'canvas'});
    expect(hit?.coordinate[0]).toBeCloseTo(0, 5);
    expect(hit?.coordinate[1]).toBeCloseTo(0, 5);
    expect(hit?.coordinate[2]).toBeCloseTo(kind === 'globe' ? 0 : 100, 5);
    expect(hit?.renderViewId).toBeDefined();
  });

  test(`${DEVICE_TYPE}: ${kind} collision uses host cameras and restores labels after zooming`, async () => {
    harness = new RenderingHarness(kind, 'stereo-preview');
    const longitude = kind === 'globe' ? 1 : 0.5;
    harness.presentation.setViewState({longitude: longitude / 2, latitude: 0, zoom: kind === 'globe' ? 0 : 5});
    const data = {type: 'FeatureCollection', features: [
      {type: 'Feature', properties: {name: 'priority'}, geometry: {type: 'Point', coordinates: [0, 0]}},
      {type: 'Feature', properties: {name: 'other'}, geometry: {type: 'Point', coordinates: [longitude, 0]}}
    ]};
    await harness.initialize({scene: {background: {color: '#000000'}}, sources: {labels: {type: 'GeoJSON', max_zoom: 0,
      url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data))}`}}, layers: {
      priority: {data: {source: 'labels'}, filter: {name: 'priority'}, draw: {points: {
        color: '#ff0000', size: '40px', priority: 1, collide: true, repeat_group: 'shared', repeat_distance: 32, order: 1}}},
      other: {data: {source: 'labels'}, filter: {name: 'other'}, draw: {points: {
        color: '#00ff00', size: '40px', priority: 10, collide: true, repeat_group: 'shared', repeat_distance: 32, order: 1}}}
    }});
    await harness.settle();
    const colliding = await harness.pixels();
    expect(countLabelPixels(colliding, 0)).toBeGreaterThan(30);
    expect(countLabelPixels(colliding, 1)).toBe(0);
    harness.presentation.setViewState({zoom: kind === 'globe' ? 5 : 8});
    await harness.settle();
    const separated = await harness.pixels();
    expect(countLabelPixels(separated, 0)).toBeGreaterThan(30);
    expect(countLabelPixels(separated, 1)).toBeGreaterThan(30);
  });
}

/** Analytical segment cases in sphere-radius units, not geographic ground-normal tests. */
const occlusionSamples = [
  {eye: [0, 0, 2], position: [0, 0, 1], hidden: false},
  {eye: [0, 0, 2], position: [0, 0, -1], hidden: true},
  // A tangent segment, and small f32 surface noise, must not self-occlude.
  {eye: [1, 0, 2], position: [1, 0, 0], hidden: false},
  {eye: [0, 0, 2], position: [0, 0, 0.9999999], hidden: false},
  // Altitude beyond the ground horizon: one clear segment and one crossing the sphere.
  {eye: [0, 0, 2], position: [2, 0, 0], hidden: false},
  {eye: [0, 0, 2], position: [0, 0, -2], hidden: true},
  // Closest approach on an infinite ray would be misleading behind these anchors.
  {eye: [0, 0, 2], position: [0, 0, 1.5], hidden: false},
  {eye: [0, 0, 2], position: [0, 0, 3], hidden: false},
  {eye: [0, 0, 2], position: [0, 0, 2], hidden: false},
  {eye: [0, 0, 1000], position: [0, 0, 1], hidden: false},
  {eye: [0, 0, 2], position: [0, 0, 0.99], hidden: true},
  // No exterior horizon for missing, interior, or surface cameras.
  {eye: [0, 0, 0], position: [0, 0, -1], hidden: false},
  {eye: [0, 0, 0.5], position: [0, 0, -1], hidden: false},
  {eye: [0, 0, 1], position: [0, 0, -1], hidden: false},
  {eye: [0, -2, 0], position: [0, 1, 0], hidden: true},
  {eye: [-2, 0, 0], position: [1, 0, 0], hidden: true},
  {eye: [272.9970703125 / 256, -1548.2432861328125 / 256, 572.2075805664062 / 256], position: [0, 0, 1], hidden: false}
];

/** Use decimal literals in both shader languages; values are common-space vectors. */
function vectorLiteral(values: readonly number[], constructorName: string) {
  return `${constructorName}(${values.map(value => (value * 256).toFixed(8)).join(', ')})`;
}

test(`${DEVICE_TYPE}: the production sphere-occlusion helper handles segment and precision boundaries`, async () => {
  harness = new RenderingHarness('globe');
  await harness.initializeDevice();
  const device = harness.device;
  const length = occlusionSamples.length;
  const helper = pointsVertexGLSL.match(/bool tangramGlobeOccluded\([^]*?\n\}/)?.[0];
  expect(helper).toBeDefined();
  const positionHelper = GLOBE_PROJECTION_GLSL.match(/vec3 tangramGlobePosition\([^]*?\n\}/)?.[0];
  const positionHelperWGSL = GLOBE_PROJECTION_WGSL.match(/fn tangramGlobePosition\([^]*?\n\}/)?.[0];
  const source = DEVICE_TYPE === 'webgl' ? `#version 300 es
precision highp float;
${helper}
${positionHelper}
layout(location = 0) in vec3 mercatorPosition;
out float hidden;
const vec2 corners[6] = vec2[6](vec2(0., -1.), vec2(1., -1.), vec2(0., 1.),
  vec2(0., 1.), vec2(1., -1.), vec2(1., 1.));
const vec3 eyes[${length}] = vec3[${length}](${occlusionSamples.map(sample => vectorLiteral(sample.eye, 'vec3')).join(',')});
const vec3 positions[${length}] = vec3[${length}](${occlusionSamples.map(sample => vectorLiteral(sample.position, 'vec3')).join(',')});
const float altitudes[${length}] = float[${length}](${occlusionSamples.map((sample, index) => index === length - 1 ? '0.' : ((Math.hypot(...sample.position) - 1) * 6370972).toFixed(8)).join(',')});
void main() {
  int sampleIndex = gl_VertexID / 6;
  vec2 corner = corners[gl_VertexID % 6];
  gl_Position = vec4((float(sampleIndex) + corner.x) / ${length}. * 2. - 1., corner.y, 0., 1.);
  vec3 projected = sampleIndex == ${length - 1} ? tangramGlobePosition(mercatorPosition) : positions[sampleIndex];
  hidden = tangramGlobeOccluded(projected, altitudes[sampleIndex], eyes[sampleIndex]) ? 1. : 0.;
}` : `
${GLOBE_VISIBILITY_WGSL}
${positionHelperWGSL}
struct Varyings { @builtin(position) position: vec4<f32>, @location(0) hidden: f32 };
@vertex fn main(@builtin(vertex_index) vertexIndex: u32, @location(0) mercatorPosition: vec3<f32>) -> Varyings {
  let corners = array<vec2<f32>, 6>(vec2<f32>(0., -1.), vec2<f32>(1., -1.), vec2<f32>(0., 1.),
    vec2<f32>(0., 1.), vec2<f32>(1., -1.), vec2<f32>(1., 1.));
  let eyes = array<vec3<f32>, ${length}>(${occlusionSamples.map(sample => vectorLiteral(sample.eye, 'vec3<f32>')).join(',')});
  let positions = array<vec3<f32>, ${length}>(${occlusionSamples.map(sample => vectorLiteral(sample.position, 'vec3<f32>')).join(',')});
  let altitudes = array<f32, ${length}>(${occlusionSamples.map((sample, index) => index === length - 1 ? '0.' : ((Math.hypot(...sample.position) - 1) * 6370972).toFixed(8)).join(',')});
  let sampleIndex = vertexIndex / 6u;
  let corner = corners[vertexIndex % 6u];
  var output: Varyings;
  output.position = vec4<f32>((f32(sampleIndex) + corner.x) / ${length}. * 2. - 1., corner.y, 0., 1.);
  let projected = select(positions[sampleIndex], tangramGlobePosition(mercatorPosition), sampleIndex == ${length - 1}u);
  output.hidden = select(0., 1., tangramGlobeOccluded(projected, altitudes[sampleIndex], eyes[sampleIndex]));
  return output;
}`;
  const fragment = DEVICE_TYPE === 'webgl' ? `#version 300 es
precision highp float;
in float hidden;
out vec4 color;
void main() { color = vec4(hidden, 0., 0., 1.); }
` : `@fragment fn main(@location(0) hidden: f32) -> @location(0) vec4<f32> {
  return vec4<f32>(hidden, 0., 0., 1.);
}`;
  const vertexShader = device.createShader({stage: 'vertex', source});
  const fragmentShader = device.createShader({stage: 'fragment', source: fragment});
  const bufferLayout = [{name: 'mercatorPosition', format: 'float32x3' as const}];
  const vertexBuffer = device.createBuffer({usage: Buffer.VERTEX,
    data: new Float32Array(Array.from({length: length * 6}, () => [1115370, 2269874, 0]).flat())});
  const pipeline = device.createRenderPipeline({vs: vertexShader, fs: fragmentShader, bufferLayout,
    shaderLayout: {attributes: [{name: 'mercatorPosition', location: 0, type: 'vec3<f32>'}], bindings: []}, vertexEntryPoint: 'main', fragmentEntryPoint: 'main',
    topology: 'triangle-list', parameters: {cullMode: 'none', depthWriteEnabled: true, depthCompare: 'always'}});
  const vertexArray = device.createVertexArray({shaderLayout: pipeline.shaderLayout, bufferLayout});
  vertexArray.setBuffer(0, vertexBuffer);
  try {
    const renderPass = device.beginRenderPass({clearColor: [0, 0, 0, 1], clearDepth: 1});
    renderPass.setPipeline(pipeline);
    renderPass.setVertexArray(vertexArray);
    renderPass.draw({vertexCount: length * 6});
    submitEyeRenderPass(device, renderPass);
    const image = await readCanvasPixels(harness.canvas);
    for (const [index, sample] of occlusionSamples.entries()) {
      const offset = (Math.floor(image.height / 2) * image.width +
        Math.floor((index + 0.5) / length * image.width)) * 4;
      expect(image.data[offset], JSON.stringify(sample)).toBe(sample.hidden ? 255 : 0);
    }
  } finally {
    vertexArray.destroy();
    vertexBuffer.destroy();
    pipeline.destroy();
    fragmentShader.destroy();
    vertexShader.destroy();
  }
});

for (const kind of ['points', 'attached-text', 'text'] as const) {
  for (const mode of ['mono', 'stereo-preview'] as const) {
    test(`${DEVICE_TYPE}: ${kind}/${mode} occludes far-side globe labels and follows camera movement`, async () => {
      harness = new RenderingHarness('globe', mode);
      harness.presentation.setViewState({longitude: 10, latitude: 20, zoom: 0});
      await harness.initialize(createLabelScene(kind));
      await harness.settle();
      const front = await harness.pixels();
      expect(countLabelPixels(front, 0)).toBeGreaterThan(30);
      expect(countLabelPixels(front, 1)).toBe(0);
      if (mode === 'stereo-preview') {
        expect(countLabelPixels(front, 0, 0, front.width / 2)).toBeGreaterThan(10);
        expect(countLabelPixels(front, 0, front.width / 2)).toBeGreaterThan(10);
      }
      harness.presentation.setViewState({longitude: -160});
      await harness.settle();
      const back = await harness.pixels();
      expect(countLabelPixels(back, 1)).toBeGreaterThan(30);
      expect(countLabelPixels(back, 0)).toBe(0);
    });
  }
}

test(`${DEVICE_TYPE}: elevated globe labels remain visible beyond the ground horizon`, async () => {
  harness = new RenderingHarness('globe');
  harness.presentation.setViewState({longitude: 0, latitude: 0, zoom: 0});
  await harness.initialize(createLabelScene('points', 20000, 84, 0));
  await harness.settle();
  expect(countLabelPixels(await harness.pixels(), 1)).toBeGreaterThan(30);
  await harness.renderer.load(createLabelScene('points', 0, 84, 0), {blocking: false});
  await harness.settle();
  expect(countLabelPixels(await harness.pixels(), 1)).toBe(0);
});

test(`${DEVICE_TYPE}: stereo eyes independently occlude an anchor at the globe horizon`, async () => {
  harness = new RenderingHarness('globe', 'stereo-preview');
  harness.interpupillaryDistance = 0.3;
  harness.presentation.setViewState({longitude: 0, latitude: 0, zoom: 0});
  const frame = harness.presentation.createFrame({width: 512, height: 320,
    interpupillaryDistance: harness.interpupillaryDistance});
  const centerDistance = Math.hypot(...frame.renderViews[0].camera.position.map((value, index) =>
    (value + frame.renderViews[1].camera.position[index]) / 2));
  const longitude = Math.acos(256 / centerDistance) * 180 / Math.PI;
  await harness.initialize(createLabelScene('points', 0, longitude, 0));
  await harness.settle();
  const image = await harness.pixels();
  // The left eye moves west: this eastern horizon anchor is behind its sphere.
  // The right eye moves east: the same anchor is now on its visible surface.
  expect(countLabelPixels(image, 1, 0, image.width / 2)).toBe(0);
  expect(countLabelPixels(image, 1, image.width / 2)).toBeGreaterThan(30);
});

test(`${DEVICE_TYPE}: selection rejects far-side globe point geometry`, async () => {
  harness = new RenderingHarness('globe');
  harness.presentation.setViewState({longitude: 10, latitude: 20, zoom: 0});
  await harness.initialize(createLabelScene('points'));
  await harness.settle();
  const viewport = new GlobeViewport({width: 512, height: 320, longitude: 10, latitude: 20, zoom: 0});
  const near = viewport.project([10, 20]);
  const far = viewport.project([-160, 20]);
  expect((await harness.pick(near[0], near[1]))?.feature).toMatchObject({properties: {name: 'near'}});
  expect((await harness.pick(far[0], far[1]))?.feature).toBeFalsy();
  harness.presentation.setViewState({longitude: -160});
  await harness.settle();
  const rotated = new GlobeViewport({width: 512, height: 320, longitude: -160, latitude: 20, zoom: 0});
  const visible = rotated.project([-160, 20]);
  expect((await harness.pick(visible[0], visible[1]))?.feature).toMatchObject({properties: {name: 'far'}});
});
