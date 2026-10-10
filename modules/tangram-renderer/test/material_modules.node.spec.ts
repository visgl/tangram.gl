// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {build} from 'esbuild';
import {GLSLShaderAssembler, WGSLShaderAssembler} from '@luma.gl/shadertools';
import {triplanar, planar, sphereMap, heightDecode, globeHorizon} from '../src/shader-modules/index';

test.each([triplanar, planar, sphereMap, heightDecode, globeHorizon])('$name assembles in both languages without bindings', shaderModule => {
    const glsl = new GLSLShaderAssembler().assembleGLSLShaderPair({
        platformInfo: {type: 'webgl', shaderLanguage: 'glsl', shaderLanguageVersion: 300, gpu: 'unknown', features: new Set()},
        modules: [shaderModule],
        vs: '#version 300 es\nvoid main() {gl_Position = vec4(0.);}',
        fs: '#version 300 es\nout vec4 color;\nvoid main() {color = vec4(1.);}'
    });
    const wgsl = new WGSLShaderAssembler().assembleWGSLShader({
        platformInfo: {type: 'webgpu', shaderLanguage: 'wgsl', shaderLanguageVersion: 300, gpu: 'unknown', features: new Set()},
        modules: [shaderModule], source: '@fragment fn main() -> @location(0) vec4<f32> {return vec4<f32>(1.0);}'
    });
    expect(glsl.vs).toContain(`${shaderModule.name}_get`);
    expect(glsl.fs).toContain(`${shaderModule.name}_get`);
    expect(wgsl.source).toContain(`fn ${shaderModule.name}_get`);
    expect(wgsl.bindingAssignments).toEqual([]);
    expect(glsl.getUniforms({})).toEqual({});
    expect(wgsl.getUniforms({})).toEqual({});
});

test.each(['triplanar', 'planar', 'sphereMap', 'heightDecode', 'globeHorizon'])('tree shakes unused modules when importing %s', async name => {
    const result = await build({stdin: {
        contents: `import {${name}} from './modules/tangram-renderer/src/shader-modules/index.ts'; console.log(${name});`,
        resolveDir: process.cwd(), loader: 'ts'
    }, bundle: true, write: false, metafile: true, format: 'esm', minify: true});
    const source = result.outputFiles[0].text;
    expect(source).toContain(`${name}_get`);
    for (const unused of ['hillshade', 'triplanar', 'planar', 'sphereMap', 'heightDecode', 'globeHorizon'].filter(candidate => candidate !== name)) {
        expect(source).not.toContain(`name:"${unused}"`);
    }
    if (!result.metafile) {throw new Error('Expected dependency graph');}
    expect(Object.values(result.metafile.outputs).every(output => output.imports.length === 0)).toBe(true);
});
