// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it, vi} from 'vitest';
import ShaderProgram from '../src/gl/shader_program';

describe('ShaderProgram portable compilation', function () {
    it('serializes numeric defines with GLSL-safe precision', function () {
        expect(ShaderProgram.buildDefineString({
            ENABLED: true,
            COUNT: 2,
            HALF_PI: 1.5707963267948966
        })).toBe('#define ENABLED\n#define COUNT 2.0\n#define HALF_PI 1.57079632679\n');
    });

    it('creates WGSL resources without reading or linking a WebGL context', function () {
        const shader_options = [];
        const shader_resources = [];
        const source = [
            '@vertex fn vertexMain() -> @builtin(position) vec4<f32> {',
            '    return vec4<f32>(0.0);',
            '}',
            '@fragment fn fragmentMain() -> @location(0) vec4<f32> {',
            '    return vec4<f32>(1.0);',
            '}'
        ].join('\n');
        const program = new ShaderProgram(null, source, source, {
            name: 'portable',
            shaderLanguage: 'wgsl',
            deferUniformBlocks: true,
            deferUniformUpdates: true,
            shaderFactory(options) {
                shader_options.push(options);
                const resource = {
                    destroyed: false,
                    destroy() { this.destroyed = true; }
                };
                shader_resources.push(resource);
                return resource;
            }
        });

        program.compile();

        expect(program.compiled).toBe(true);
        expect(program.program).toBeNull();
        expect(shader_options.map(options => ({
            stage: options.stage,
            language: options.language,
            entryPoint: options.entryPoint,
            source: options.source
        })), [
            { stage: 'vertex', language: 'wgsl', entryPoint: 'vertexMain', source },
            { stage: 'fragment', language: 'wgsl', entryPoint: 'fragmentMain', source }
        ]);

        program.destroy();
        expect(shader_resources[0].destroyed).toBe(true);
        expect(shader_resources[1].destroyed).toBe(true);
    });

    it('creates device-owned GLSL shaders without linking a raw WebGL program', function () {
        const create_program = vi.fn();
        const validate_program = vi.fn();
        const shader_options = [];
        const shader_resources = [];
        const gl = {
            FRAGMENT_SHADER: 0x8B30,
            HIGH_FLOAT: 0x8DF2,
            createProgram: create_program,
            getShaderPrecisionFormat: () => { throw new Error('device shaders must not query raw precision'); }
        };
        const vertex_source = 'attribute vec2 a_position; void main() { gl_Position = vec4(a_position, 0., 1.); }';
        const fragment_source = 'void main() { gl_FragColor = vec4(1.); }';
        const program = new ShaderProgram(gl, vertex_source, fragment_source, {
            name: 'device-glsl',
            shaderLanguage: 'glsl',
            deviceShaderCompilation: true,
            shaderProgramValidator: validate_program,
            deferUniformBlocks: true,
            deferUniformUpdates: true,
            shaderFactory(options) {
                shader_options.push(options);
                const resource = {
                    destroyed: false,
                    destroy() { this.destroyed = true; }
                };
                shader_resources.push(resource);
                return resource;
            }
        });

        program.compile();

        expect(program.compiled).toBe(true);
        expect(program.program).toBeNull();
        expect(create_program).not.toHaveBeenCalled();
        expect(validate_program).toHaveBeenCalledWith({
            id: 'device-glsl',
            vertexShader: shader_resources[0],
            fragmentShader: shader_resources[1]
        });
        expect(shader_options.map(options => ({
            stage: options.stage,
            language: options.language
        }))).toEqual([
            {stage: 'vertex', language: 'glsl'},
            {stage: 'fragment', language: 'glsl'}
        ]);
        expect(shader_options[0].source).toContain(vertex_source);
        expect(shader_options[1].source).toContain(fragment_source);

        program.destroy();
        expect(shader_resources[0].destroyed).toBe(true);
        expect(shader_resources[1].destroyed).toBe(true);
    });

    it('requires device shader factories and link validation', function () {
        const program = new ShaderProgram({}, '', '', {
            shaderLanguage: 'glsl',
            deviceShaderCompilation: true
        });

        expect(() => program.compile()).toThrow(
            'ShaderProgram: device compilation requires shaderFactory and shaderProgramValidator'
        );
    });

    it('surfaces device-owned GLSL link failures during style compilation', function () {
        const shader_resources = [];
        const program = new ShaderProgram({
            FRAGMENT_SHADER: 0x8B30,
            HIGH_FLOAT: 0x8DF2,
            getShaderPrecisionFormat: () => ({precision: 23})
        }, 'void main() { gl_Position = vec4(0.); }', 'void main() { gl_FragColor = vec4(1.); }', {
            name: 'invalid-device-glsl',
            shaderLanguage: 'glsl',
            deviceShaderCompilation: true,
            deferUniformBlocks: true,
            deferUniformUpdates: true,
            shaderFactory() {
                const resource = {
                    destroyed: false,
                    destroy() { this.destroyed = true; }
                };
                shader_resources.push(resource);
                return resource;
            },
            shaderProgramValidator() {
                throw new Error('varying mismatch');
            }
        });

        expect(() => program.compile()).toThrow('varying mismatch');
        expect(program.compiled).toBe(false);
        expect(program.error.message).toBe('varying mismatch');
        expect(shader_resources.every(resource => resource.destroyed)).toBe(true);
    });
});
