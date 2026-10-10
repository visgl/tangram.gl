// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {Texture} from '@luma.gl/core';
import {GLSLShaderAssembler, WGSLShaderAssembler, type PlatformInfo} from '@luma.gl/shadertools';
import {heightDecode, globeHorizon} from '../../modules/tangram-renderer/dist/shader-modules.js';
import pointGLSL from '../../modules/tangram-renderer/src/styles/points/points_vertex.glsl?raw';
import {GLOBE_VISIBILITY_WGSL} from '../../modules/tangram-renderer/src/styles/globe_visibility_wgsl';
import {RenderingHarness, DEVICE_TYPE} from './harness';
import {readDevicePixels} from '../../modules/tangram-renderer/src/gpu/pixel_readback';
import {submitEyeRenderPass} from '../../examples/webxr/submit-eye.js';

/** Each shader expression returns a success bit against an independent CPU result. */
type Sample = {name: string; glsl: string; wgsl: string};
/** Emit finite float literals without dropping small height or horizon differences. */
function literal(value: number): string {return value.toExponential(10);}
/** Emit the same vector in both languages. */
function vector(values: number[], wgsl: boolean): string {
    const vectorType = `vec${values.length}${wgsl ? '<f32>' : ''}`;
    return `(${vectorType}(${values.map(literal).join(',')}) + ${vectorType}(runtimeZero))`;
}
/** Independent closest-point reference in double precision, centered at the sphere. */
function isOccluded(position: number[], eye: number[], radius: number): boolean {
    if (Math.hypot(...eye) <= radius) {return false;}
    const segment = position.map((value, index) => value - eye[index]);
    const lengthSquared = segment.reduce((sum, value) => sum + value * value, 0);
    if (lengthSquared === 0) {return false;}
    const amount = Math.max(0, Math.min(1, -eye.reduce((sum, value, index) => sum + value * segment[index], 0) / lengthSquared));
    const closest = eye.map((value, index) => (1 - amount) * value + amount * position[index]);
    return closest.reduce((sum, value) => sum + value * value, 0) / (radius * radius) < 1 - 1e-6;
}
/** Boundary corpus for normalized byte channels, carry transitions and custom encodings. */
function createHeightSamples(): Sample[] {
    const samples: Sample[] = [];
    for (const bytes of [[0, 0, 0], [255, 255, 255], [127, 255, 255], [128, 0, 0], [128, 0, 1],
        [128, 1, 0], [0, 255, 255], [1, 0, 0], [1, 134, 160], [10, 20, 30], [17.5, 22.25, 13.5]]) {
        const packed = bytes[0] * 65536 + bytes[1] * 256 + bytes[2];
        for (const [name, expected, tolerance] of [
            ['Terrarium', packed / 256 - 32768, 0.004],
            ['TerrainRGB', packed / 10 - 10000, 0.25],
            ['Height', bytes[0] * 0.5 + bytes[1] * -2 + bytes[2] * 0.25 + 7, 0.0001]
        ] as const) {
            const expressions = [false, true].map(wgsl => {
                const argumentsExpression = vector(bytes.map(value => value / 255), wgsl) +
                    (name === 'Height' ? `, ${vector([0.5, -2, 0.25], wgsl)}, 7.` : '');
                return `abs(heightDecode_get${name}(${argumentsExpression}) - ${literal(expected)}) <= ${literal(tolerance)}`;
            });
            samples.push({name: `${name}: ${bytes}`, glsl: expressions[0], wgsl: expressions[1]});
        }
    }
    const blueStep = [false, true].map(wgsl =>
        `abs((heightDecode_getTerrarium(${vector([128 / 255, 0, 1 / 255], wgsl)}) - heightDecode_getTerrarium(${vector([128 / 255, 0, 0], wgsl)})) - 0.00390625) < 0.0001`);
    samples.push({name: 'Terrarium retains fractional blue-channel step near sea level', glsl: blueStep[0], wgsl: blueStep[1]});
    const terrainStep = [false, true].map(wgsl =>
        `abs((heightDecode_getTerrainRGB(${vector([1 / 255, 134 / 255, 161 / 255], wgsl)}) - heightDecode_getTerrainRGB(${vector([1 / 255, 134 / 255, 160 / 255], wgsl)})) - 0.1) < 0.002`);
    samples.push({name: 'Terrain-RGB retains a decimeter blue-channel step near sea level', glsl: terrainStep[0], wgsl: terrainStep[1]});
    return samples;
}
/** Surface, elevated, tangent, buried and finite-segment fixtures at several radii. */
function createHorizonSamples(legacy: boolean): Sample[] {
    const samples: Sample[] = [];
    const fixtures = [
        {position: [0, 0, 1], eye: [0, 0, 2]},
        {position: [0, 0, -1], eye: [0, 0, 2]},
        {position: [Math.sqrt(0.75), 0, 0.5], eye: [0, 0, 2]},
        {position: [1, 0, 2], eye: [1, 0, -2]}, // tangent
        {position: [0.99999, 0, 2], eye: [0.99999, 0, -2]},
        {position: [1.00001, 0, 2], eye: [1.00001, 0, -2]},
        {position: [0, 0, 3], eye: [0, 0, 2]}, // ray would hit; segment does not
        {position: [0, 0, 2], eye: [0, 0, 2]}, // coincident
        {position: [0, 0, -1], eye: [0, 0, 0]},
        {position: [0, 0, -1], eye: [0, 0, 0.5]},
        {position: [0, 0, -1], eye: [0, 0, 1]},
        {position: [0, 0, 0.9], eye: [0, 0, 2]}, // buried
        {position: [3, 0, -1], eye: [0, 0, 2]}, // elevated past surface horizon
        {position: [0, 0, 1], eye: [0, 0, 10000]}
    ];
    if (!legacy) {
        for (const radius of [0.5, 256, 6370972]) {
            for (const fixture of fixtures) {
                const position = fixture.position.map(value => value * radius);
                const eye = fixture.eye.map(value => value * radius);
                const expected = isOccluded(position, eye, radius);
                const expressions = [false, true].map(wgsl =>
                    `globeHorizon_isOccluded(${vector(position, wgsl)}, ${vector(eye, wgsl)}, ${literal(radius)}) == ${expected}`);
                samples.push({name: `segment ${radius}: ${JSON.stringify(fixture)}`, glsl: expressions[0], wgsl: expressions[1]});
            }
        }
    }
    for (const altitude of [-1000, 0, 1000, 6370972]) {
        for (const direction of [[0, 0, 1], [0, 0, -1], [1, 2, -1]]) {
            const earthRadius = 6370972; const radius = 256;
            const position = direction.map(value => value / Math.hypot(...direction) * radius * (1 + altitude / earthRadius));
            const eye = [0, 0, 512];
            const expected = isOccluded(position, eye, radius);
            const expressions = [false, true].map(wgsl => legacy ?
                `tangramGlobeOccluded(${vector(direction, wgsl)}, ${literal(altitude)}, ${vector(eye, wgsl)}) == ${expected}` :
                `globeHorizon_isOccluded(globeHorizon_getAnchor(${vector(direction, wgsl)}, ${literal(altitude)}, 256., 6370972.), ${vector(eye, wgsl)}, 256.) == ${expected}`);
            samples.push({name: `anchor ${direction}, altitude ${altitude}`, glsl: expressions[0], wgsl: expressions[1]});
            if (!legacy) {
                const anchors = [false, true].map(wgsl =>
                    `length(globeHorizon_getAnchor(${vector(direction, wgsl)}, ${literal(altitude)}, 256., 6370972.) - ${vector(position, wgsl)}) < 0.0001`);
                samples.push({name: `anchor radius ${direction}, ${altitude}`, glsl: anchors[0], wgsl: anchors[1]});
            }
        }
    }
    return samples;
}

test.each([false, true])(`${DEVICE_TYPE}: height decoding and horizon match CPU (legacy horizon: %s)`, async legacy => {
    const harness = new RenderingHarness();
    await harness.initializeDevice();
    const device = harness.device;
    const platformInfo: PlatformInfo = {type: device.type,
        shaderLanguage: DEVICE_TYPE === 'webgl' ? 'glsl' : 'wgsl', shaderLanguageVersion: 300,
        gpu: device.info.gpu, features: new Set(device.features)};
    const samples = [...createHeightSamples(), ...createHorizonSamples(legacy)];
    const legacyGLSL = pointGLSL.match(/bool tangramGlobeOccluded\([^]*?\n\}/)?.[0];
    if (!legacyGLSL) {throw new Error('Missing original globe GLSL');}
    const fragment = `#version 300 es
precision highp float;
out vec4 color;
${legacy ? legacyGLSL : ''}
void main() {
    float runtimeZero = gl_FragCoord.y - 0.5;
    int index = min(${samples.length - 1}, int(gl_FragCoord.x / 512. * ${samples.length}.));
    ${samples.map((sample, index) => `if (index == ${index}) {color = vec4(${sample.glsl} ? 1. : 0., 0., 0., 1.); return;}`).join('\n')}
}`;
    const vertex = `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1., -1.), vec2(3., -1.), vec2(-1., 3.));
void main() {gl_Position = vec4(corners[gl_VertexID], 0., 1.);}`;
    const application = `
${legacy ? GLOBE_VISIBILITY_WGSL : ''}
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let corners = array<vec2<f32>, 3>(vec2<f32>(-1., -1.), vec2<f32>(3., -1.), vec2<f32>(-1., 3.));
    return vec4<f32>(corners[index], 0., 1.);
}
@fragment fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let runtimeZero = position.y - 0.5;
    let index = min(${samples.length - 1}u, u32(position.x / 512. * ${samples.length}.));
    ${samples.map((sample, index) => `if (index == ${index}u) {return vec4<f32>(select(0., 1., ${sample.wgsl}), 0., 0., 1.);}`).join('\n')}
    return vec4<f32>(0.);
}`;
    let vertexSource: string; let fragmentSource: string;
    if (DEVICE_TYPE === 'webgl') {
        const assembled = new GLSLShaderAssembler().assembleGLSLShaderPair({platformInfo,
            modules: [heightDecode, globeHorizon], vs: vertex, fs: fragment});
        vertexSource = assembled.vs; fragmentSource = assembled.fs;
    } else {
        const assembled = new WGSLShaderAssembler().assembleWGSLShader({platformInfo,
            modules: [heightDecode, globeHorizon], source: application, vertexEntryPoint: 'vertexMain', fragmentEntryPoint: 'fragmentMain'});
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
            expect.soft(Array.from(pixels.subarray(offset, offset + 4)), sample.name).toEqual([255, 0, 0, 255]);
        }
        expect(harness.errors).toEqual([]);
    } finally {
        framebuffer.destroy(); depthTexture.destroy(); texture.destroy(); vertexArray.destroy(); pipeline.destroy(); fragmentShader.destroy(); vertexShader.destroy(); harness.destroy();
    }
});
