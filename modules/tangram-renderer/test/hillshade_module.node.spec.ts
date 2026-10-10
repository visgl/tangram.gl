// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {build} from 'esbuild';
import {GLSLShaderAssembler, WGSLShaderAssembler} from '@luma.gl/shadertools';
import {hillshade} from '../src/shader-modules/index';

test('hillshade is a binding-free module usable with both luma assemblers', () => {
    const glsl = new GLSLShaderAssembler().assembleGLSLShaderPair({
        platformInfo: {type: 'webgl', shaderLanguage: 'glsl', shaderLanguageVersion: 300, gpu: 'unknown', features: new Set()},
        modules: [hillshade],
        vs: '#version 300 es\nvoid main() {gl_Position = vec4(0.);}',
        fs: '#version 300 es\nout vec4 color;\nvoid main() {color = vec4(hillshade_getIntensity(vec3(0., 0., 1.), vec3(0., 0., 1.), 0.));}'
    });
    const wgsl = new WGSLShaderAssembler().assembleWGSLShader({
        platformInfo: {type: 'webgpu', shaderLanguage: 'wgsl', shaderLanguageVersion: 300, gpu: 'unknown', features: new Set()},
        modules: [hillshade], source: '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }'
    });
    expect(glsl.fs).toContain('hillshade_getIntensity');
    expect(glsl.vs).toContain('hillshade_getNormal');
    expect(wgsl.source).toContain('fn hillshade_getNormal');
    expect(wgsl.bindingAssignments).toEqual([]);
    expect(glsl.getUniforms({})).toEqual({});
    expect(wgsl.getUniforms({})).toEqual({});
});

test('optional shader entry bundles without renderer or third-party runtime code', async () => {
    const result = await build({entryPoints: ['modules/tangram-renderer/src/shader-modules/index.ts'],
        bundle: true, write: false, metafile: true, format: 'esm', minify: true});
    if (!result.metafile) { throw new Error('Expected an esbuild dependency graph'); }
    expect(Object.keys(result.metafile.inputs).sort()).toEqual([
        'modules/tangram-renderer/src/shader-modules/hillshade.ts',
        'modules/tangram-renderer/src/shader-modules/index.ts',
        'modules/tangram-renderer/src/shader-modules/planar.ts',
        'modules/tangram-renderer/src/shader-modules/sphere-map.ts',
        'modules/tangram-renderer/src/shader-modules/triplanar.ts'
    ]);
    expect(Object.values(result.metafile.outputs).every(output => output.imports.length === 0)).toBe(true);
});
