// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Texture} from '@luma.gl/core';
import {GLSLShaderAssembler, WGSLShaderAssembler, type PlatformInfo} from '@luma.gl/shadertools';
import {triplanar, planar, sphereMap} from '../../modules/tangram-renderer/dist/shader-modules.js';
import materialGLSL from '../../modules/tangram-renderer/src/lights/material.glsl?raw';
import {RenderingHarness, DEVICE_TYPE} from './harness';
import {readDevicePixels} from '../../modules/tangram-renderer/src/gpu/pixel_readback';
import {submitEyeRenderPass} from '../../examples/webxr/submit-eye.js';

/** Independent CPU results paired with equivalent GLSL/WGSL expressions. */
type Sample = {name: string; glsl: string; wgsl: string; expected: number[]};
/** Explicit negative-coordinate wrapping used by Tangram texture mapping. */
function wrap(value: number): number {return value - Math.floor(value);}
/** Emit finite f32 literals without truncating the tiny-normal fixtures. */
function vector(values: number[], wgsl: boolean): string {
    return `${wgsl ? `vec${values.length}<f32>` : `vec${values.length}`}(${values.map(value => `${value.toExponential(8)}`).join(',')})`;
}
/** Color fixture separates UV channels, projection-plane weights, and alpha. */
function sampleColor(coordinates: number[]): number[] {return [...coordinates, 0.25, 0.5];}
/** Euclidean normalization for the independent reflection reference. */
function normalize(values: number[]): number[] {
    const length = Math.hypot(...values);
    return values.map(value => value / length);
}
/** Build compact boundary fixtures, shared by both GPU backends and original GLSL. */
function createSamples(legacy: boolean): Sample[] {
    const samples: Sample[] = [];
    const normals = [[1, 0, 0], [0, -1, 0], [0, 0, 1], [1, -2, 3], [0, 0, 0], [1e-7, 2e-7, 0], [-0.2, 0.4, -0.6]];
    const position = [-1.25, 2.375, -0.125];
    const scale = [2, -3, 0.5];
    for (const normal of normals) {
        const clamped = normal.map(value => Math.max(Math.abs(value), 1e-5));
        const sum = clamped.reduce((total, value) => total + value, 0);
        const weights = clamped.map(value => value / sum);
        samples.push({name: `weights ${normal}`, glsl: `vec4(${legacy ? 'getTriPlanarBlend' : 'triplanar_getWeights'}(${vector(normal, false)}), 1.)`,
            wgsl: `vec4<f32>(triplanar_getWeights(${vector(normal, true)}), 1.)`, expected: [...weights, 1]});
        const coordinates = [[position[1], position[2]], [position[0], position[2]], [position[0], position[1]]]
            .map((pair, index) => pair.map(value => wrap(value * scale[index])));
        const colors = coordinates.map(sampleColor);
        const expected = colors[0].map((_, channel) => colors.reduce((total, color, index) => total + color[channel] * weights[index], 0));
        const expressions = [false, true].map(wgsl => {
            const positionExpression = vector(position, wgsl); const scaleExpression = vector(scale, wgsl);
            const normalExpression = vector(normal, wgsl);
            if (legacy && !wgsl) {return `getTriPlanar(0, ${positionExpression}, ${normalExpression}, ${scaleExpression})`;}
            return `triplanar_blend(${['X', 'Y', 'Z'].map(axis => `sampleFixture(triplanar_getUV${axis}(${positionExpression}, ${scaleExpression}))`).join(',')}, triplanar_getWeights(${normalExpression}))`;
        });
        samples.push({name: `blend ${normal}`, glsl: expressions[0], wgsl: expressions[1], expected});
    }
    for (const coordinates of [[0, 0, 0], position, [1.125, -0.75, 2.375]]) {
        for (const frequency of [0, -2, 0.5]) {
            const literal = frequency.toExponential(8);
            const expected = sampleColor(coordinates.slice(0, 2).map(value => wrap(value * frequency)));
            samples.push({name: `planar ${coordinates} ${frequency}`, glsl: legacy ?
                `getPlanar(0, ${vector(coordinates, false)}, vec2(${literal}, 99.))` :
                `sampleFixture(planar_getUV(${vector(coordinates, false)}, ${literal}))`,
            wgsl: `sampleFixture(planar_getUV(${vector(coordinates, true)}, ${literal}))`, expected});
            for (const [index, axis] of ['X', 'Y', 'Z'].entries()) {
                const pair = index === 0 ? coordinates.slice(1) : index === 1 ? [coordinates[0], coordinates[2]] : coordinates.slice(0, 2);
                const expectedUV = sampleColor(pair.map(value => wrap(value * frequency)));
                samples.push({name: `triplanar UV${axis} ${coordinates} ${frequency}`,
                    glsl: `sampleFixture(triplanar_getUV${axis}(${vector(coordinates, false)}, vec3(${literal})))`,
                    wgsl: `sampleFixture(triplanar_getUV${axis}(${vector(coordinates, true)}, vec3<f32>(${literal})))`, expected: expectedUV});
            }
        }
    }
    for (const [eye, normal, skew] of [
        [[0, 0, -1], [0, 0, 1], [0, 0]],
        [[1, 2, -3], [0, 0, 1], [0.1, -0.2]],
        [[-2, 1, -1], [1, 0, 0], [-0.2, 0.15]],
        [[2, 1, -1], normalize([1, 2, 3]), [0, 0]]
    ]) {
        const unitEye = normalize(eye);
        const skewed = normalize([unitEye[0] - skew[0], unitEye[1] - skew[1], unitEye[2]]);
        const dot = skewed.reduce((total, value, index) => total + value * normal[index], 0);
        const reflected = skewed.map((value, index) => value - 2 * dot * normal[index]);
        reflected[2] += 1;
        const denominator = 2 * Math.hypot(...reflected);
        const expected = sampleColor(reflected.slice(0, 2).map(value => value / denominator + 0.5));
        samples.push({name: `sphere ${eye} ${normal} ${skew}`, glsl: legacy ?
            `getSphereMap(0, ${vector(eye, false)}, ${vector(normal, false)}, ${vector(skew, false)})` :
            `sampleFixture(sphereMap_getUV(${vector(eye, false)}, ${vector(normal, false)}, ${vector(skew, false)}))`,
        wgsl: `sampleFixture(sphereMap_getUV(${vector(eye, true)}, ${vector(normal, true)}, ${vector(skew, true)}))`, expected});
    }
    return samples;
}

/** Compile original helpers verbatim, substituting only the host sampling boundary. */
function getLegacyHelpers(): string {
    return ['getTriPlanarBlend', 'getTriPlanar', 'getPlanar', 'getSphereMap'].map(name => {
        const source = materialGLSL.match(new RegExp(`vec[34] ${name} \\([^]*?\\n\\}`))?.[0];
        if (!source) {throw new Error(`Missing legacy helper ${name}`);}
        return source.replaceAll('sampler2D', 'int').replace(/texture2D\s*\(\s*_tex\s*,/g, 'sampleFixture(');
    }).join('\n');
}

test.each(DEVICE_TYPE === 'webgl' ? [false, true] : [false])(`${DEVICE_TYPE}: material mappings match CPU reference (legacy GLSL: %s)`, async legacy => {
    const harness = new RenderingHarness();
    await harness.initializeDevice();
    const device = harness.device;
    const platformInfo: PlatformInfo = {type: device.type,
        shaderLanguage: DEVICE_TYPE === 'webgl' ? 'glsl' : 'wgsl', shaderLanguageVersion: 300,
        gpu: device.info.gpu, features: new Set(device.features)};
    const samples = createSamples(legacy);
    const fragment = `#version 300 es
precision highp float;
out vec4 color;
vec4 sampleFixture(vec2 uv) {return vec4(uv, 0.25, 0.5);}
${legacy ? getLegacyHelpers() : ''}
void main() {
    int index = min(${samples.length - 1}, int(gl_FragCoord.x / 512. * ${samples.length}.));
    ${samples.map((sample, index) => `if (index == ${index}) {color = ${sample.glsl}; return;}`).join('\n')}
}`;
    const vertex = `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
void main() {gl_Position = vec4(corners[gl_VertexID], 0., 1.);}`;
    const application = `
fn sampleFixture(uv: vec2<f32>) -> vec4<f32> {return vec4<f32>(uv, 0.25, 0.5);}
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let corners = array<vec2<f32>, 3>(vec2<f32>(-1., -1.), vec2<f32>(3., -1.), vec2<f32>(-1., 3.));
    return vec4<f32>(corners[index], 0., 1.);
}
@fragment fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let index = min(${samples.length - 1}u, u32(position.x / 512. * ${samples.length}.));
    ${samples.map((sample, index) => `if (index == ${index}u) {return ${sample.wgsl};}`).join('\n')}
    return vec4<f32>(0.);
}`;
    let vertexSource: string; let fragmentSource: string;
    if (DEVICE_TYPE === 'webgl') {
        const assembled = new GLSLShaderAssembler().assembleGLSLShaderPair({platformInfo,
            modules: [triplanar, planar, sphereMap], vs: vertex, fs: fragment});
        vertexSource = assembled.vs; fragmentSource = assembled.fs;
    } else {
        const assembled = new WGSLShaderAssembler().assembleWGSLShader({platformInfo,
            modules: [triplanar, planar, sphereMap], source: application, vertexEntryPoint: 'vertexMain', fragmentEntryPoint: 'fragmentMain'});
        vertexSource = fragmentSource = assembled.source;
    }
    const vertexShader = device.createShader({stage: 'vertex', source: vertexSource});
    const fragmentShader = device.createShader({stage: 'fragment', source: fragmentSource});
    const pipeline = device.createRenderPipeline({vs: vertexShader, fs: fragmentShader,
        colorAttachmentFormats: ['rgba8unorm'],
        vertexEntryPoint: DEVICE_TYPE === 'webgl' ? 'main' : 'vertexMain', fragmentEntryPoint: DEVICE_TYPE === 'webgl' ? 'main' : 'fragmentMain',
        bufferLayout: [], shaderLayout: {attributes: [], bindings: []}, topology: 'triangle-list',
        parameters: {cullMode: 'none', depthWriteEnabled: false, depthCompare: 'always'}});
    const vertexArray = device.createVertexArray({shaderLayout: pipeline.shaderLayout, bufferLayout: []});
    const texture = device.createTexture({width: 512, height: 1, format: 'rgba8unorm', usage: Texture.RENDER_ATTACHMENT | Texture.COPY_SRC});
    const depthTexture = device.createTexture({width: 512, height: 1, format: 'depth24plus', usage: Texture.RENDER_ATTACHMENT});
    const framebuffer = device.createFramebuffer({width: 512, height: 1, colorAttachments: [texture], depthStencilAttachment: depthTexture});
    try {
        const pass = device.beginRenderPass({framebuffer, clearColor: [0, 0, 0, 0]});
        pass.setPipeline(pipeline); pass.setVertexArray(vertexArray); pass.draw({vertexCount: 3});
        submitEyeRenderPass(device, pass);
        const pixels = await readDevicePixels(device, texture, {x: 0, y: 0, width: 512, height: 1});
        for (const [index, sample] of samples.entries()) {
            const offset = Math.floor((index + 0.5) / samples.length * 512) * 4;
            for (const [channel, expected] of sample.expected.entries()) {
                expect(pixels[offset + channel] / 255, `${sample.name}, channel ${channel}`).toBeCloseTo(expected, 2);
            }
        }
        expect(harness.errors).toEqual([]);
    } finally {
        framebuffer.destroy(); depthTexture.destroy(); texture.destroy(); vertexArray.destroy(); pipeline.destroy(); fragmentShader.destroy(); vertexShader.destroy(); harness.destroy();
    }
});
