// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test, vi} from 'vitest';
import ShaderProgram from '../src/gl/shader_program';

let context: WebGL2RenderingContext;
const programs: ShaderProgram[] = [];
const vertexSource = 'attribute vec4 a_position; void main() { gl_Position = a_position; }';

beforeEach(() => {
    const created = document.createElement('canvas').getContext('webgl2');
    if (!created) throw new Error('Fixture requires WebGL 2');
    context = created;
    Object.assign(context, {_tangram_id: 20001});
    ShaderProgram.reset();
});

afterEach(() => {
    vi.restoreAllMocks();
    for (const program of programs.splice(0)) program.destroy();
    ShaderProgram.reset();
    context.getExtension('WEBGL_lose_context')?.loseContext();
});

test('classic vector and matrix dispatch preserves numeric storage identity and cached restoration', () => {
    const program = new ShaderProgram(context, `
        attribute vec4 a_position;
        uniform mat4 matrix4; uniform mat3 matrix3;
        uniform vec2 vector2; uniform vec3 vector3; uniform vec4 vector4;
        uniform int integer; uniform ivec3 integers; uniform bool enabled;
        uniform float scalars[5];
        void main() {
            vec3 offset = vec3(vector2, 0.0) + vector3 + vector4.xyz + vec3(integers);
            float scale = float(integer) + scalars[0] + scalars[4] + (enabled ? 1.0 : 0.0);
            gl_Position = matrix4 * vec4(matrix3 * a_position.xyz + offset, scale);
        }`, 'void main() { gl_FragColor = vec4(1.0); }', {glsl_version: 300});
    programs.push(program); program.compile();
    const vector = new Float32Array([1, 2, 3]);
    const integers = new Int32Array([4, 5, 6]);
    const floatWrite = vi.spyOn(context, 'uniform3fv'), integerWrite = vi.spyOn(context, 'uniform3iv');
    program.uniform('3fv', 'vector3', vector);
    program.uniform('3iv', 'integers', integers);
    expect(floatWrite.mock.calls[0][1]).toBe(vector); expect(integerWrite.mock.calls[0][1]).toBe(integers);
    program.setUniforms({vector2: [1, 2], vector4: [1, 2, 3, 4], enabled: true, scalars: [1, 2, 3, 4, 5]});
    program.uniform('1i', 'integer', 7);
    program.uniform('Matrix3fv', 'matrix3', [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    program.uniform('Matrix4fv', 'matrix4', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    program.saveUniforms({vector3: true, integer: true});
    program.uniform('3f', 'vector3', [9, 8, 7]); program.uniform('1i', 'integer', 99);
    program.restoreUniforms({vector3: true, integer: true});
    expect(program.getUniformValues()).toMatchObject({vector3: vector, integer: 7, enabled: true, scalars: [1, 2, 3, 4, 5]});
    program.refreshUniforms();
    expect(context.getError()).toBe(context.NO_ERROR);
});

test('failed allocation is explicit and compiler diagnostics preserve the original error and composed sources', () => {
    const allocation = vi.spyOn(context, 'createShader').mockReturnValue(null);
    expect(() => ShaderProgram.createShader(context, 'void main() {}', context.VERTEX_SHADER)).toThrow(/allocation failed/);
    allocation.mockRestore();
    const program = new ShaderProgram(context, vertexSource, '#pragma tangram: color\nvoid main() { gl_FragColor = missingColor; }', {
        glsl_version: 300, blocks: {color: ['float diagnosticFixture = ;']}, block_scopes: {color: ['fixture']}
    });
    programs.push(program);
    let failure: unknown;
    try {program.compile();} catch (error) {failure = error;}
    expect(program.error).toBe(failure); expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({type: 'fragment', fragment_shader_source: expect.stringContaining('tangram-block-start: fixture')});
    expect(program.compiling).toBe(false); expect(program.compiled).toBe(false);
    expect(program.shader_errors.length).toBeGreaterThan(0);
});

test('portable rejection preserves primitive failure identity without touching a raw context', () => {
    const program = new ShaderProgram(null, 'vertex', 'fragment', {shaderLanguage: 'wgsl', shaderFactory() {throw 'fixture shader rejection';}});
    programs.push(program);
    let failure: unknown;
    try {program.compile();} catch (error) {failure = error;}
    expect(failure).toBe('fixture shader rejection'); expect(program.error).toBe(failure);
    expect(program.compiling).toBe(false); expect(program.program).toBeNull();
    expect(program.attribute('a_position')).toBeUndefined();
});

/** Compile a minimal real program through the same legacy path as the classic map. */
function createProgram(color = '1.0') {
    const program = new ShaderProgram(context, vertexSource,
        `void main() { gl_FragColor = vec4(${color}); }`, {glsl_version: 300});
    programs.push(program);
    program.compile();
    return program;
}

test('a scene reload never reuses a deleted program from the source cache', () => {
    const previous = createProgram();
    const previousHandle = previous.program;
    previous.destroy();
    const current = createProgram();
    expect(current.program).not.toBe(previousHandle);
    expect(context.isProgram(current.program)).toBe(true);
    current.use();
    expect(context.getError()).toBe(context.NO_ERROR);
});

test('identical styles retain their shared program until the final wrapper is destroyed', () => {
    const first = createProgram();
    const second = createProgram();
    expect(first.program).toBe(second.program);
    const handle = second.program;
    first.destroy();
    second.use();
    expect(context.isProgram(handle)).toBe(true);
    expect(context.getParameter(context.CURRENT_PROGRAM)).toBe(handle);
    expect(context.getError()).toBe(context.NO_ERROR);
    second.destroy();
    expect(context.isProgram(handle)).toBe(false);
    expect(Object.values(ShaderProgram.programs_by_source)).not.toContain(handle);
});

test('recompiling one shared style does not relink or retire the other style', () => {
    const first = createProgram();
    const second = createProgram();
    const original = second.program;
    first.fragment_source = 'void main() { gl_FragColor = vec4(0.5); }';
    first.compile();
    expect(first.program).not.toBe(original);
    expect(second.program).toBe(original);
    second.use();
    expect(context.isProgram(original)).toBe(true);
    expect(context.getError()).toBe(context.NO_ERROR);
});

test('recompiling an unchanged style does not retain an extra cache reference', () => {
    const program = createProgram();
    const handle = program.program;
    program.compile();
    expect(program.program).toBe(handle);
    program.destroy();
    program.destroy();
    expect(context.isProgram(handle)).toBe(false);
    expect(context.getError()).toBe(context.NO_ERROR);
});
