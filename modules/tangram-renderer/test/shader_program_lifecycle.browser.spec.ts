// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import ShaderProgram from '../src/gl/shader_program';

let context: WebGL2RenderingContext;
const programs: ShaderProgram[] = [];
const vertexSource = 'attribute vec4 a_position; void main() { gl_Position = a_position; }';

beforeEach(() => {
    context = document.createElement('canvas').getContext('webgl2')!;
    expect(context).not.toBeNull();
    Object.assign(context, {_tangram_id: 20001});
    ShaderProgram.reset();
});

afterEach(() => {
    for (const program of programs.splice(0)) program.destroy();
    ShaderProgram.reset();
    context.getExtension('WEBGL_lose_context')?.loseContext();
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
