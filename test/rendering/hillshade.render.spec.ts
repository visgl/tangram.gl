// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test} from 'vitest';
import {GLSLShaderAssembler, WGSLShaderAssembler, type PlatformInfo} from '@luma.gl/shadertools';
import {hillshade} from '../../modules/tangram-renderer/dist/shader-modules.js';
import {RenderingHarness, DEVICE_TYPE, readCanvasPixels} from './harness';
import {submitEyeRenderPass} from '../../examples/webxr/submit-eye.js';

/** Flat, directional slopes, anisotropic spacing, clamping and zero-light fixtures. */
const samples = [
    {heights: [0, 0, 0, 0], spacing: [1, 1], light: [0, 0, 1], ambient: 0},
    {heights: [100, 100, 100, 100], spacing: [1, 1], light: [0, 0, -1], ambient: 0.35},
    {heights: [0, 2, 0, 0], spacing: [1, 1], light: [-1, 0, 1], ambient: 0.2},
    {heights: [0, 2, 0, 0], spacing: [1, 1], light: [1, 0, 1], ambient: 0.2},
    {heights: [0, 0, 0, 4], spacing: [1, 2], light: [0, -1, 1], ambient: 0},
    {heights: [-2, 6, 4, -8], spacing: [2, 3], light: [3, 2, 1], ambient: 0.1},
    {heights: [0, 0, 0, 0], spacing: [1, 1], light: [0, 0, 0], ambient: 0.25},
    {heights: [0, 0, 0, 0], spacing: [1, 1], light: [0, 0, 0.0000005], ambient: 0},
    {heights: [0, 0, 0, 0], spacing: [1, 1], light: [0, 0, 1e20], ambient: 0},
    {heights: [0, 2, 0, 0], spacing: [1, 1], light: [-0.0000005, 0, 0.0000005], ambient: 0.2},
    {heights: [0, 0, 0, 0], spacing: [1, 1], light: [0, 0, -1], ambient: -1},
    {heights: [0, 0, 0, 0], spacing: [1, 1], light: [0, 0, -1], ambient: 2},
    {heights: [0, 0.000002, 0, 0], spacing: [0, -1], light: [-1, 0, 1], ambient: 0}
];
let harness: RenderingHarness | undefined;
afterEach(() => {harness?.destroy(); harness = undefined;});

/** Independent CPU central difference and Lambert reference for the GPU pixels. */
function calculateExpected(sample: typeof samples[number]): number {
    const normal = [(sample.heights[0] - sample.heights[1]) / (2 * Math.max(Math.abs(sample.spacing[0]), 1e-6)),
        (sample.heights[2] - sample.heights[3]) / (2 * Math.max(Math.abs(sample.spacing[1]), 1e-6)), 1];
    const normalLength = Math.hypot(...normal);
    const lightLength = Math.hypot(...sample.light) || 1;
    const diffuse = Math.max(0, Math.min(1, normal.reduce((sum, value, index) =>
        sum + value * sample.light[index], 0) / normalLength / lightLength));
    const ambient = Math.max(0, Math.min(1, sample.ambient));
    return ambient + (1 - ambient) * diffuse;
}

/** Decimal literals valid in both GLSL and WGSL. */
function vector(values: number[], constructorName: string): string {
    return `${constructorName}(${values.map(value => value.toFixed(8)).join(', ')})`;
}

test(`${DEVICE_TYPE}: packaged hillshade module matches central-difference CPU results on the GPU`, async () => {
    harness = new RenderingHarness();
    await harness.initializeDevice();
    const device = harness.device;
    const platformInfo: PlatformInfo = {
        type: device.type,
        shaderLanguage: DEVICE_TYPE === 'webgl' ? 'glsl' : 'wgsl',
        shaderLanguageVersion: 300,
        gpu: device.info.gpu,
        features: new Set(device.features)
    };
    const count = samples.length;
    const vertex = `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
void main() { gl_Position = vec4(corners[gl_VertexID], 0., 1.); }`;
    const fragment = `#version 300 es
precision highp float;
out vec4 color;
const vec4 heights[${count}] = vec4[${count}](${samples.map(sample => vector(sample.heights, 'vec4')).join(',')});
const vec2 spacing[${count}] = vec2[${count}](${samples.map(sample => vector(sample.spacing, 'vec2')).join(',')});
const vec3 lights[${count}] = vec3[${count}](${samples.map(sample => vector(sample.light, 'vec3')).join(',')});
const float ambient[${count}] = float[${count}](${samples.map(sample => sample.ambient.toFixed(8)).join(',')});
void main() {
    int index = min(${count - 1}, int(gl_FragCoord.x / 512. * ${count}.));
    vec3 normal = hillshade_getNormal(heights[index], spacing[index]);
    color = vec4(vec3(hillshade_getIntensity(normal, lights[index], ambient[index])), 1.);
}`;
    const application = `
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let corners = array<vec2<f32>, 3>(vec2<f32>(-1., -1.), vec2<f32>(3., -1.), vec2<f32>(-1., 3.));
    return vec4<f32>(corners[index], 0., 1.);
}
@fragment fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let heights = array<vec4<f32>, ${count}>(${samples.map(sample => vector(sample.heights, 'vec4<f32>')).join(',')});
    let spacing = array<vec2<f32>, ${count}>(${samples.map(sample => vector(sample.spacing, 'vec2<f32>')).join(',')});
    let lights = array<vec3<f32>, ${count}>(${samples.map(sample => vector(sample.light, 'vec3<f32>')).join(',')});
    let ambient = array<f32, ${count}>(${samples.map(sample => sample.ambient.toFixed(8)).join(',')});
    let index = min(${count - 1}u, u32(position.x / 512. * ${count}.));
    let normal = hillshade_getNormal(heights[index], spacing[index]);
    return vec4<f32>(vec3<f32>(hillshade_getIntensity(normal, lights[index], ambient[index])), 1.);
}`;
    let vertexSource: string;
    let fragmentSource: string;
    if (DEVICE_TYPE === 'webgl') {
        const assembled = new GLSLShaderAssembler().assembleGLSLShaderPair({platformInfo,
            modules: [hillshade], vs: vertex, fs: fragment});
        vertexSource = assembled.vs; fragmentSource = assembled.fs;
    } else {
        const assembled = new WGSLShaderAssembler().assembleWGSLShader({platformInfo,
            modules: [hillshade], source: application, vertexEntryPoint: 'vertexMain', fragmentEntryPoint: 'fragmentMain'});
        vertexSource = fragmentSource = assembled.source;
    }
    const vertexShader = device.createShader({stage: 'vertex', source: vertexSource});
    const fragmentShader = device.createShader({stage: 'fragment', source: fragmentSource});
    const pipeline = device.createRenderPipeline({vs: vertexShader, fs: fragmentShader,
        vertexEntryPoint: DEVICE_TYPE === 'webgl' ? 'main' : 'vertexMain',
        fragmentEntryPoint: DEVICE_TYPE === 'webgl' ? 'main' : 'fragmentMain',
        bufferLayout: [], shaderLayout: {attributes: [], bindings: []}, topology: 'triangle-list',
        parameters: {cullMode: 'none', depthWriteEnabled: false, depthCompare: 'always'}});
    const vertexArray = device.createVertexArray({shaderLayout: pipeline.shaderLayout, bufferLayout: []});
    try {
        const pass = device.beginRenderPass({clearColor: [0, 0, 0, 1]});
        pass.setPipeline(pipeline); pass.setVertexArray(vertexArray); pass.draw({vertexCount: 3});
        submitEyeRenderPass(device, pass);
        const image = await readCanvasPixels(harness.canvas);
        for (const [index, sample] of samples.entries()) {
            const offset = (Math.floor(image.height / 2) * image.width + Math.floor((index + 0.5) / count * image.width)) * 4;
            expect(image.data[offset] / 255, `sample ${index}`).toBeCloseTo(calculateExpected(sample), 2);
            expect(image.data[offset + 3]).toBe(255);
        }
        expect(harness.errors).toEqual([]);
    } finally {
        vertexArray.destroy(); pipeline.destroy(); fragmentShader.destroy(); vertexShader.destroy();
    }
});
