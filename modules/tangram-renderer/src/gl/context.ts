// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// WebGL context wrapper

/** A host scope must return the callback result without taking ownership of its context. */
type ContextScope = <Result>(callback: () => Result) => Result;

interface ContextNamespace {
    configure<Context extends object>(gl: Context, scope?: ContextScope): Context & {_tangram_id: number};
    withContext<T>(gl: object | null | undefined, callback: () => T): T;
    hasContextScope(gl: object | null | undefined): boolean;
    getContext(canvas?: HTMLCanvasElement | null, options?: WebGLContextAttributes & {device_pixel_ratio?: number}): WebGLRenderingContext;
    resize(gl: WebGLRenderingContext, width: number, height: number, devicePixelRatio?: number): void;
}

export const Context: ContextNamespace = {configure, withContext, hasContextScope, getContext, resize};
export default Context;

let context_id = 0;
const context_scopes = new WeakMap<object, ContextScope>();

// Register a WebGL context for Tangram use without taking ownership of it.
function configure<Context extends object>(gl: Context, scope?: ContextScope): Context & {_tangram_id: number}
{
    const configured = hasContextIdentity(gl) ? gl : Object.assign(gl, {_tangram_id: context_id++});
    if (scope) {
        context_scopes.set(gl, scope);
    }
    return configured;
}

/** Preserve already configured contexts without rewriting caller-owned properties. */
function hasContextIdentity<Context extends object>(context: Context): context is Context & {_tangram_id: number} {
    return '_tangram_id' in context && typeof context._tangram_id === 'number';
}

// Run WebGL work inside an optional host-managed state scope.
function withContext<T>(gl: object | null | undefined, callback: () => T): T
{
    const scope = gl && context_scopes.get(gl);
    return scope ? scope(callback) : callback();
}

function hasContextScope(gl: object | null | undefined): boolean
{
    return Boolean(gl && context_scopes.has(gl));
}

// Setup a WebGL context
// If no canvas element is provided, one is created and added to the document body
function getContext(canvas?: HTMLCanvasElement | null, options: WebGLContextAttributes & {device_pixel_ratio?: number} = {}): WebGLRenderingContext
{
    var fullscreen = false;
    if (canvas == null) {
        canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.zIndex = '-1';
        document.body.appendChild(canvas);
        fullscreen = true;
    }

    // powerPreference context option spec requires listeners for context loss/restore,
    // though it's not clear these are required in practice.
    // https://www.khronos.org/registry/webgl/specs/latest/1.0/#5.2.1
    canvas.addEventListener('webglcontextlost', () => {});
    canvas.addEventListener('webglcontextrestored', () => {});

    const gl = canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options);
    if (!gl || !('getParameter' in gl)) {
        throw new Error('Couldn\'t create WebGL context.');
    }
    Context.configure(gl);

    if (!fullscreen) {
        Context.resize(gl, parseFloat(canvas.style.width), parseFloat(canvas.style.height), options.device_pixel_ratio);
    }
    else {
        Context.resize(gl, window.innerWidth, window.innerHeight, options.device_pixel_ratio);
        window.addEventListener('resize', function () {
            Context.resize(gl, window.innerWidth, window.innerHeight, options.device_pixel_ratio);
        });
    }

    return gl;
}

function resize(gl: WebGLRenderingContext, width: number, height: number, device_pixel_ratio?: number): void
{
    device_pixel_ratio = device_pixel_ratio || window.devicePixelRatio || 1;
    if ('style' in gl.canvas) {
        gl.canvas.style.width = width + 'px';
        gl.canvas.style.height = height + 'px';
    }
    gl.canvas.width = Math.round(width * device_pixel_ratio);
    gl.canvas.height = Math.round(height * device_pixel_ratio);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
}
