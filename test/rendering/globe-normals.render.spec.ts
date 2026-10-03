// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {_GlobeViewport as GlobeViewport} from '@deck.gl/core';
import {Vector3} from '@math.gl/core';
import polygonVertexGLSL from '../../modules/tangram-renderer/src/styles/polygons/polygons_vertex.glsl?raw';
import {GLOBE_NORMAL_WGSL} from '../../modules/tangram-renderer/src/styles/globe_normal_wgsl';
import {RenderingHarness, readCanvasPixels, DEVICE_TYPE} from './harness';
import {submitEyeRenderPass} from '../../examples/webxr/submit-eye.js';

let harness: RenderingHarness | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors || []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
  } finally {
    if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName || 'normals',
      harness.canvas.toDataURL('image/png'));
    harness?.destroy();
    harness = undefined;
  }
});

/** Cardinal, seam, high-latitude, roof, wall, and mixed-normal probes. */
const samples = [
  {longitude: 0, latitude: 0, normal: [0, 0, 1]},
  {longitude: 90, latitude: 0, normal: [0, 0, 1]},
  {longitude: -90, latitude: 0, normal: [0, 0, 1]},
  {longitude: 180, latitude: 0, normal: [0, 0, 1]},
  {longitude: 0, latitude: 0, normal: [1, 0, 0]},
  {longitude: 0, latitude: 0, normal: [0, 1, 0]},
  {longitude: 37, latitude: 85, normal: [0, 0, 1]},
  {longitude: 37, latitude: -85, normal: [0, 1, 0]},
  {longitude: 179.999, latitude: 45, normal: [1, 0, 0]},
  {longitude: -180.001, latitude: 45, normal: [1, 0, 0]},
  {longitude: -73, latitude: 40, normal: [2, -1, 3]}
];

/** Derive ENU independently from deck.gl's geographic position projection. */
function expectedNormal(sample: typeof samples[number]): Vector3 {
  const viewport = new GlobeViewport({width: 512, height: 320});
  const project = (longitude: number, latitude: number) => viewport.projectPosition([longitude, latitude, 0]);
  const east = new Vector3(project(sample.longitude + 0.0001, sample.latitude))
    .subtract(project(sample.longitude - 0.0001, sample.latitude)).normalize();
  const north = new Vector3(project(sample.longitude, sample.latitude + 0.0001))
    .subtract(project(sample.longitude, sample.latitude - 0.0001)).normalize();
  const up = new Vector3(project(sample.longitude, sample.latitude)).normalize();
  return east.scale(sample.normal[0]).add(north.scale(sample.normal[1]))
    .add(up.scale(sample.normal[2])).normalize();
}

/** Serialize deterministic shader literals, retaining decimal points in GLSL. */
function vectorLiteral(values: readonly number[], constructorName: string): string {
  return `${constructorName}(${values.map(value => value.toFixed(8)).join(', ')})`;
}

test(`${DEVICE_TYPE}: globe normals agree with geographic tangents on the actual GPU`, async () => {
  harness = new RenderingHarness('globe');
  await harness.initializeDevice();
  const device = harness.device;
  const mercatorPositions = samples.map(sample => [
    sample.longitude * Math.PI / 180 * 6378137,
    Math.log(Math.tan(Math.PI / 4 + sample.latitude * Math.PI / 360)) * 6378137,
    // Normal orientation must not change with altitude.
    10000
  ]);
  const length = samples.length;
  // Compile the actual production helper, without the rest of the tile shader.
  const globeNormalGLSL = polygonVertexGLSL.match(/vec3 tangramGlobeNormal\([^]*?\n\}/)?.[0];
  expect(globeNormalGLSL).toBeDefined();
  const source = DEVICE_TYPE === 'webgl' ? `#version 300 es
precision highp float;
${globeNormalGLSL}
out vec3 encodedNormal;
const vec2 corners[6] = vec2[6](vec2(0., -1.), vec2(1., -1.), vec2(0., 1.),
  vec2(0., 1.), vec2(1., -1.), vec2(1., 1.));
const vec3 positions[${length}] = vec3[${length}](${mercatorPositions.map(position => vectorLiteral(position, 'vec3')).join(',')});
const vec3 normals[${length}] = vec3[${length}](${samples.map(sample => vectorLiteral(sample.normal, 'vec3')).join(',')});
void main() {
  int sampleIndex = gl_VertexID / 6;
  vec2 corner = corners[gl_VertexID % 6];
  gl_Position = vec4((float(sampleIndex) + corner.x) / ${length}. * 2. - 1., corner.y, 0., 1.);
  encodedNormal = tangramGlobeNormal(positions[sampleIndex], normals[sampleIndex]) * 0.5 + 0.5;
}` : `
${GLOBE_NORMAL_WGSL}
struct Varyings { @builtin(position) position: vec4<f32>, @location(0) encodedNormal: vec3<f32> };
@vertex fn main(@builtin(vertex_index) vertexIndex: u32) -> Varyings {
  let corners = array<vec2<f32>, 6>(vec2<f32>(0., -1.), vec2<f32>(1., -1.), vec2<f32>(0., 1.),
    vec2<f32>(0., 1.), vec2<f32>(1., -1.), vec2<f32>(1., 1.));
  let positions = array<vec3<f32>, ${length}>(${mercatorPositions.map(position => vectorLiteral(position, 'vec3<f32>')).join(',')});
  let normals = array<vec3<f32>, ${length}>(${samples.map(sample => vectorLiteral(sample.normal, 'vec3<f32>')).join(',')});
  let sampleIndex = vertexIndex / 6u;
  let corner = corners[vertexIndex % 6u];
  var output: Varyings;
  output.position = vec4<f32>((f32(sampleIndex) + corner.x) / ${length}. * 2. - 1., corner.y, 0., 1.);
  output.encodedNormal = tangramGlobeNormal(positions[sampleIndex], normals[sampleIndex]) * 0.5 + 0.5;
  return output;
}`;
  const fragment = DEVICE_TYPE === 'webgl' ? `#version 300 es
precision highp float;
in vec3 encodedNormal;
out vec4 color;
void main() { color = vec4(encodedNormal, 1.); }
` : `@fragment fn main(@location(0) encodedNormal: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(encodedNormal, 1.);
}`;
  const vertexShader = device.createShader({stage: 'vertex', source});
  const fragmentShader = device.createShader({stage: 'fragment', source: fragment});
  const pipeline = device.createRenderPipeline({vs: vertexShader, fs: fragmentShader, bufferLayout: [],
    shaderLayout: {attributes: [], bindings: []},
    vertexEntryPoint: 'main', fragmentEntryPoint: 'main',
    topology: 'triangle-list', parameters: {cullMode: 'none', depthWriteEnabled: true, depthCompare: 'always'}});
  const vertexArray = device.createVertexArray({shaderLayout: pipeline.shaderLayout, bufferLayout: []});
  try {
    const renderPass = device.beginRenderPass({clearColor: [0, 0, 0, 1], clearDepth: 1});
    renderPass.setPipeline(pipeline);
    renderPass.setVertexArray(vertexArray);
    renderPass.draw({vertexCount: length * 6});
    submitEyeRenderPass(device, renderPass);
    const image = await readCanvasPixels(harness.canvas);
    for (const [index, sample] of samples.entries()) {
      const expected = expectedNormal(sample);
      const pixel = (Math.floor(image.height / 2) * image.width +
        Math.floor((index + 0.5) / length * image.width)) * 4;
      for (let channel = 0; channel < 3; channel++) {
        expect(image.data[pixel + channel] / 255 * 2 - 1,
          `${sample.longitude}/${sample.latitude}: ${sample.normal}, channel ${channel}`)
          .toBeCloseTo(expected[channel], 2);
      }
    }
  } finally {
    vertexArray.destroy();
    pipeline.destroy();
    fragmentShader.destroy();
    vertexShader.destroy();
  }
});

// The portable WGSL path has fixed wall shading, not configurable scene lights.
// Keep its unlit roofs separate from GLSL's directional-light contract.
test.runIf(DEVICE_TYPE === 'webgl').each(['vertex', 'fragment'] as const)(`${DEVICE_TYPE}: %s globe roof lighting stays radial across camera rotation`, async lighting => {
  harness = new RenderingHarness('globe');
  harness.presentation.setViewState({zoom: 0});
  const source = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({
    type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
      type: 'Polygon', coordinates: [[[-35, -35], [35, -35], [35, 35], [-35, 35], [-35, -35]]]
    }}]
  }))}`;
  await harness.initialize({
    scene: {background: {color: '#000000'}},
    sources: {surface: {type: 'GeoJSON', url: source, max_zoom: 2}},
    lights: {sun: {type: 'directional', direction: [0, 1, 0], ambient: 0, diffuse: 1}},
    styles: {surface: {base: 'polygons', lighting, material: {ambient: 0, diffuse: 1}}},
    layers: {surface: {data: {source: 'surface'}, draw: {surface: {order: 0, color: '#ff0000', extrude: 100}}}}
  });
  for (const bearing of [0, 90, 180]) {
    harness.presentation.setViewState({bearing});
    await harness.settle();
    const image = await harness.pixels();
    const center = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    expect(image.data[center], `radial roof brightness at bearing ${bearing}`).toBeGreaterThan(240);
    expect(image.data[center + 1]).toBe(0);
    expect(image.data[center + 2]).toBe(0);
  }
});
