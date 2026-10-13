// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// GL program wrapper to cache uniform locations/values, do compile-time pre-processing
// (injecting #defines and #pragma blocks into shaders), etc.

import log from '../utils/log';
import GLSL from './glsl';
import Texture from './texture';
import getExtension from './extensions';
import hashString from '../utils/hash';
import {notifyGPUResourceDisposal} from '../gpu/resource_lifecycle';
import type {MeshProgram} from './mesh-types';
import type {Shader, UniformValue} from '@luma.gl/core';
import type UniformBuffer from './uniform_buffer';
import type {TangramShaderOptions, TangramShaderProgramOptions} from '../gpu/tangram_gpu_backend';

import parseShaderErrors from 'gl-shader-errors';

// Regex patterns
const re_pragma = /^\s*#pragma.*$/gm;   // for removing unused pragmas after shader block injection
const re_continue_line = /\\\s*\n/mg;   // for removing backslash line continuations
const re_fragment_color = /\bgl_FragColor\b/g;
const re_texture_2d = /\btexture2D\b/g;
const re_texture_cube = /\btextureCube\b/g;
/** Wrapper ownership of cached raw programs; device-owned shaders use their own lifecycle. */
const programReferences = new WeakMap<WebGLProgram, number>();

/** Stage identity shared by source composition and compiler diagnostics. */
type ShaderStage = 'vertex' | 'fragment';
/** Classic context identity is part of the exact-source cache key. */
type ShaderContext = WebGLRenderingContext & {_tangram_id?: number};
/** Authored source fragments, either one string or an ordered list. */
type ShaderBlocks = Record<string, string | string[]>;
/** One injected source fragment with provenance for compiler diagnostics. */
type ShaderBlock = {key: string; source: string; num: number; scope?: string};
/** Source location within an injected Tangram block. */
type ShaderBlockLocation = {scope: string; name: string; num: string; line?: number; source?: string};
/** Compiler diagnostics retain both the original line and legacy block mapping. */
type ShaderDiagnostic = {message: string; file: number; line: number | ShaderBlockLocation | null | undefined; type?: ShaderStage; block?: ShaderBlockLocation | null};
/** Cached scalar/vector uniform and its optional legacy location. */
type CachedUniform = {name: string; method: string; value: UniformValue; saved_value?: UniformValue; location?: WebGLUniformLocation | null};
/** A sampler needs only classic binding or portable resource access, not every texture-wrapper field. */
type SamplerTexture = Partial<Pick<Texture, 'bind' | 'getResource'>>;
/** Program composition and portable resource allocation options. */
interface ShaderProgramOptions {
    name?: string;
    defines?: Record<string, unknown>;
    blocks?: ShaderBlocks;
    block_scopes?: Record<string, string[]>;
    extensions?: string[];
    uniforms?: Parameters<typeof GLSL.parseUniforms>[0];
    uniform_blocks?: Record<string, UniformBuffer>;
    deferUniformBlocks?: boolean;
    deferTextureBindings?: boolean;
    deferUniformUpdates?: boolean;
    shaderLanguage?: 'glsl' | 'wgsl';
    shaderFactory?: (options: TangramShaderOptions) => Shader;
    shaderProgramValidator?: (options: TangramShaderProgramOptions) => void;
    deviceShaderCompilation?: boolean;
    glsl_version?: number;
}

export default class ShaderProgram {
    /** Caller context is opaque in the portable path. */
    declare gl: object | null;
    /** Stable wrapper identity, independent of shared compiled resources. */
    declare id: number;
    declare name: string | undefined;
    declare vertex_source: string;
    declare computed_vertex_source: string | null;
    declare computed_fragment_source: string | null;
    declare compiled: boolean;
    declare compiling: boolean;
    declare error: unknown;
    declare defines: Record<string, unknown>;
    declare blocks: ShaderBlocks;
    declare block_scopes: Record<string, string[]>;
    declare extensions: string[];
    declare dependent_uniforms: ShaderProgramOptions['uniforms'];
    declare uniforms: Record<string, CachedUniform>;
    declare uniform_blocks: Record<string, UniformBuffer>;
    declare defer_uniform_blocks: boolean;
    declare defer_texture_bindings: boolean;
    declare defer_uniform_updates: boolean;
    declare texture_uniforms: Record<string, SamplerTexture>;
    declare shader_language: 'glsl' | 'wgsl';
    declare shader_factory: ShaderProgramOptions['shaderFactory'];
    declare shader_program_validator: ShaderProgramOptions['shaderProgramValidator'];
    declare device_shader_compilation: boolean;
    declare vertex_shader_resource: Shader | null | undefined;
    declare fragment_shader_resource: Shader | null | undefined;
    declare glsl_version: number;
    declare attribs: Record<string, {name: string; location: number}>;
    declare shader_errors: ShaderDiagnostic[];
    declare texture_unit: number;
    declare saved_texture_unit: number;
    declare saved_texture_uniforms: Record<string, SamplerTexture>;
    declare saved_uniform_block_data: Map<UniformBuffer, Uint8Array> | null;
    declare static id: number;
    declare static blocks: ShaderBlocks;
    declare static shaders_by_source: Record<string, WebGLShader>;
    declare static resetCurrent: () => void;
    declare static releaseProgram: (context: ShaderContext, program: WebGLProgram | null) => void;
    declare static convertToWebGL2: (source: string, stage: ShaderStage) => string;
    declare static buildDefineString: (defines: Record<string, unknown>) => string;
    declare static buildExtensionString: (extensions?: string[]) => string;
    declare static updateProgram: (context: ShaderContext, program: WebGLProgram | null, vertex: string, fragment: string, resources?: {vertex_shader?: Shader; fragment_shader?: Shader}) => WebGLProgram;
    declare static createShader: (context: ShaderContext, source: string, stage: number) => WebGLShader;
    /** Program used when a classic mesh draw omits an explicit program. */
    declare static current: MeshProgram | null;
    /** Linked raw program owned by this wrapper, or null for device compilation. */
    declare program: WebGLProgram | null;
    /** Authored fragment source, before Tangram shader block composition. */
    declare fragment_source: string;
    /** Raw programs shared by exact source and context identity. */
    declare static programs_by_source: Record<string, WebGLProgram>;
    /** Clear source lookup caches without changing ownership of live programs. */
    declare static reset: () => void;
    /** Global shader defines shared by the Tangram block composer. */
    declare static defines: Record<string, unknown>;
    /** Append named GLSL blocks; implemented below for legacy compatibility. */
    declare static addBlock: (key: string, ...blocks: string[]) => void;
    /** Remove a named GLSL block; implemented below for legacy compatibility. */
    declare static removeBlock: (key: string) => void;
    /** Replaces a named Tangram shader block with the supplied source fragments. */
    static declare replaceBlock: (key: string, ...blocks: string[]) => void;

    constructor(gl: object | null, vertex_source: string, fragment_source: string, options: ShaderProgramOptions = {}) {
        options = options || {};

        this.gl = gl;
        this.program = null;
        this.compiled = false;
        this.compiling = false;
        this.error = null;

        // key/values inserted as #defines into shaders at compile-time
        this.defines = Object.assign({}, options.defines||{});

        // key/values for blocks that can be injected into shaders at compile-time
        this.blocks = Object.assign({}, options.blocks||{});
        this.block_scopes = Object.assign({}, options.block_scopes||{});

        // list of extensions to activate
        this.extensions = options.extensions || [];

        // JS-object uniforms that are expected by this program, their types are inferred and definitions
        // for each will be injected.
        this.dependent_uniforms = options.uniforms;

        this.uniforms = {}; // program locations of uniforms, lazily added as each uniform is set
        this.uniform_blocks = Object.assign({}, options.uniform_blocks || {});
        this.defer_uniform_blocks = options.deferUniformBlocks === true;
        this.defer_texture_bindings = options.deferTextureBindings === true;
        this.defer_uniform_updates = options.deferUniformUpdates === true;
        this.texture_uniforms = {};
        this.shader_language = options.shaderLanguage || 'glsl';
        this.shader_factory = options.shaderFactory;
        this.shader_program_validator = options.shaderProgramValidator;
        this.device_shader_compilation = options.deviceShaderCompilation === true;
        this.vertex_shader_resource = null;
        this.fragment_shader_resource = null;
        this.glsl_version = options.glsl_version || (Object.keys(this.uniform_blocks).length > 0 ? 300 : 100);
        this.attribs = {}; // program locations of vertex attributes, lazily added as each attribute is accessed

        this.vertex_source = vertex_source;
        this.fragment_source = fragment_source;

        this.id = ShaderProgram.id++;
        this.name = options.name; // can provide a program name (useful for debugging)
    }

    /** Only legacy compilation/binding may inspect raw WebGL capabilities. */
    private get classicContext(): ShaderContext {
        if (isShaderContext(this.gl)) return this.gl;
        throw new Error('Classic shaders require a WebGL context');
    }

    destroy() {
        if (this.shader_language === 'glsl' && !this.device_shader_compilation) {
            this.classicContext.useProgram(null);
            ShaderProgram.current = null;
            ShaderProgram.releaseProgram(this.classicContext, this.program);
        }
        this.destroyShaderResources();
        this.program = null;
        this.uniforms = {};
        this.texture_uniforms = {};
        this.attribs = {};
        this.compiled = false;
    }

    // Use program wrapper with simple state cache
    use({ bindUniformBlocks = !this.defer_uniform_blocks } = {}) {
        if (!this.compiled) {
            return;
        }

        const changed = ShaderProgram.current !== this;
        if (changed && this.shader_language === 'glsl' && !this.defer_uniform_updates) {
            this.classicContext.useProgram(this.program);
        }
        ShaderProgram.current = this;
        if (bindUniformBlocks) {
            this.bindUniformBlocks({ force: true });
        }
    }

    compile() {
        if (this.shader_language !== 'glsl') {
            return this.compilePortable();
        }
        if (this.device_shader_compilation &&
            (!this.shader_factory || !this.shader_program_validator)) {
            throw new Error(
                'ShaderProgram: device compilation requires shaderFactory and shaderProgramValidator'
            );
        }
        if (this.compiling) {
            throw(new Error(`ShaderProgram.compile(): skipping for ${this.id} (${this.name}) because already compiling`));
        }
        this.compiling = true;
        this.compiled = false;
        this.error = null;

        // Copy sources from pre-modified template
        this.computed_vertex_source = this.vertex_source;
        this.computed_fragment_source = this.fragment_source;

        // Check for extension availability
        let extensions = this.checkExtensions();

        // Make list of defines to be injected later
        var defines = this.buildDefineList();

        // Inject user-defined blocks (arbitrary code points matching named #pragmas)
        // Replace according to this pattern:
        // #pragma tangram: [key]
        // e.g. #pragma tangram: global

        // Gather all block code snippets
        var blocks = this.buildShaderBlockList();
        var regexp;

        for (var key in blocks) {
            var block = blocks[key];
            if (!block || (Array.isArray(block) && block.length === 0)) {
                continue;
            }

            // First find code replace points in shaders
            regexp = new RegExp('^\\s*#pragma\\s+tangram:\\s+' + key + '\\s*$', 'm');
            var inject_vertex = this.computed_vertex_source.match(regexp);
            var inject_fragment = this.computed_fragment_source.match(regexp);

            // Avoid network request if nothing to replace
            if (inject_vertex == null && inject_fragment == null) {
                continue;
            }

            // Combine all blocks into one string
            var source = '';
            block.forEach(val => {
                // Mark start and end of each block with metadata (which can be extracted from
                // final source for error handling, debugging, etc.)
                let mark = `${val.scope}, ${val.key}, ${val.num}`;
                source += `\n// tangram-block-start: ${mark}\n`;
                source += val.source;
                source += `\n// tangram-block-end: ${mark}\n`;
            });

            // Inject
            if (inject_vertex != null) {
                this.computed_vertex_source = this.computed_vertex_source.replace(regexp, source);
            }
            if (inject_fragment != null) {
                this.computed_fragment_source = this.computed_fragment_source.replace(regexp, source);
            }

            // Add a #define for this injection point
            defines['TANGRAM_BLOCK_' + key.replace(/[\s-]+/g, '_').toUpperCase()] = true;
        }

        // Clean-up any #pragmas that weren't replaced (to prevent compiler warnings)
        this.computed_vertex_source = this.computed_vertex_source.replace(re_pragma, '');
        this.computed_fragment_source = this.computed_fragment_source.replace(re_pragma, '');

        // Inject uniform definitions
        this.ensureUniforms(this.dependent_uniforms);
        this.ensureUniformBlocks();

        // Build & inject extensions & defines
        // This is done *after* code injection so that we can add defines for which code points were injected
        let precision = '';
        // Device compilation targets WebGL 2, where highp float is required.
        // Only the standalone legacy path needs a raw WebGL 1 precision query.
        let high = this.device_shader_compilation ? {precision: 1} :
            this.classicContext.getShaderPrecisionFormat(this.classicContext.FRAGMENT_SHADER, this.classicContext.HIGH_FLOAT);
        if (high && high.precision > 0) {
            precision = 'precision highp float;\n';
        }
        else {
            precision = 'precision mediump float;\n';
        }

        defines['TANGRAM_VERTEX_SHADER'] = true;
        defines['TANGRAM_FRAGMENT_SHADER'] = false;
        defines['TANGRAM_WEBGL2'] = this.glsl_version >= 300;
        this.computed_vertex_source =
            precision +
            ShaderProgram.buildDefineString(defines) +
            this.computed_vertex_source;

        // Precision qualifier only valid in fragment shader
        // NB: '#extension' statements added to fragment shader only, as IE11 throws error when they appear in
        // vertex shader (even when guarded by #ifdef), and no WebGL extensions require '#extension' in vertex shaders
        defines['TANGRAM_VERTEX_SHADER'] = false;
        defines['TANGRAM_FRAGMENT_SHADER'] = true;
        this.computed_fragment_source =
            ShaderProgram.buildExtensionString(extensions) +
            precision +
            ShaderProgram.buildDefineString(defines) +
            this.computed_fragment_source;

        // Replace multi-line backslashes
        this.computed_vertex_source = this.computed_vertex_source.replace(re_continue_line, '');
        this.computed_fragment_source = this.computed_fragment_source.replace(re_continue_line, '');
        if (this.glsl_version >= 300) {
            this.computed_vertex_source = ShaderProgram.convertToWebGL2(this.computed_vertex_source, 'vertex');
            this.computed_fragment_source = ShaderProgram.convertToWebGL2(this.computed_fragment_source, 'fragment');
        }

        // Compile & set uniforms to cached values
        try {
            let shader_resources;
            if (this.shader_factory) {
                shader_resources = this.createShaderResources(
                    this.computed_vertex_source,
                    this.computed_fragment_source
                );
            }
            if (this.device_shader_compilation) {
                try {
                    if (!this.shader_program_validator || !shader_resources) throw new Error('ShaderProgram: missing device shader resources');
                    this.shader_program_validator({
                        id: this.name || String(this.id),
                        vertexShader: shader_resources.vertex_shader,
                        fragmentShader: shader_resources.fragment_shader
                    });
                }
                catch (error) {
                    destroyShaderResource(shader_resources && shader_resources.vertex_shader);
                    destroyShaderResource(shader_resources && shader_resources.fragment_shader);
                    throw error;
                }
                this.destroyShaderResources();
                this.vertex_shader_resource = shader_resources && shader_resources.vertex_shader;
                this.fragment_shader_resource = shader_resources && shader_resources.fragment_shader;
                this.program = null;
            }
            else {
                try {
                    this.program = ShaderProgram.updateProgram(
                        this.classicContext,
                        this.program,
                        this.computed_vertex_source,
                        this.computed_fragment_source,
                        shader_resources
                    );
                }
                catch (error) {
                    destroyShaderResource(shader_resources && shader_resources.vertex_shader);
                    destroyShaderResource(shader_resources && shader_resources.fragment_shader);
                    throw error;
                }
                this.destroyShaderResources();
                this.vertex_shader_resource = shader_resources && shader_resources.vertex_shader;
                this.fragment_shader_resource = shader_resources && shader_resources.fragment_shader;
            }
            this.compiled = true;
            this.compiling = false;
            ShaderProgram.current = null;
            for (const uniform_buffer of Object.values(this.uniform_blocks)) {
                if (typeof uniform_buffer.invalidateProgram === 'function') {
                    uniform_buffer.invalidateProgram(this.program);
                }
            }
        }
        catch(error) {
            this.program = null;
            this.compiled = false;
            this.compiling = false;
            this.error = error;

            // shader error info
            if (error instanceof Object) Object.assign(error, {vertex_shader_source: this.computed_vertex_source, fragment_shader_source: this.computed_fragment_source});

            if (isShaderFailure(error)) {
                this.shader_errors = error.errors;
                this.shader_errors.forEach(e => {
                    e.type = error.type;
                    if (typeof e.line === 'number') {
                        e.block = this.block(error.type, e.line);
                        e.line = this.block(error.type, e.line);
                    }
                });
                Object.assign(error, {shader_errors: this.shader_errors});
            }
            throw error;
        }

        // Discard shader sources after successful compilation
        this.computed_vertex_source = null;
        this.computed_fragment_source = null;

        this.use();
        this.refreshUniforms();
        this.refreshAttributes();
    }

    createShaderResources(vertex_source: string, fragment_source: string) {
        if (!this.shader_factory) throw new Error('ShaderProgram: portable compilation requires a shaderFactory');
        let vertex_shader: Shader | undefined;
        try {
            const vertex_options: TangramShaderOptions = {
                id: `${this.name || this.id}-vertex`,
                stage: 'vertex',
                language: this.shader_language,
                source: vertex_source
            };
            const fragment_options: TangramShaderOptions = {
                id: `${this.name || this.id}-fragment`,
                stage: 'fragment',
                language: this.shader_language,
                source: fragment_source
            };
            if (this.shader_language === 'wgsl') {
                vertex_options.entryPoint = 'vertexMain';
                fragment_options.entryPoint = 'fragmentMain';
            }
            vertex_shader = this.shader_factory(vertex_options);
            const fragment_shader = this.shader_factory(fragment_options);
            const resources_valid = vertex_shader && typeof vertex_shader.destroy === 'function' &&
                fragment_shader && typeof fragment_shader.destroy === 'function';
            const handles_valid = this.shader_language !== 'glsl' || this.device_shader_compilation ||
                (vertex_shader.handle && fragment_shader.handle);
            if (!resources_valid || !handles_valid) {
                destroyShaderResource(fragment_shader);
                throw new Error('ShaderProgram: shaderFactory must return a portable shader resource');
            }
            return { vertex_shader, fragment_shader };
        }
        catch (error) {
            destroyShaderResource(vertex_shader);
            throw error;
        }
    }

    destroyShaderResources() {
        try {
            notifyGPUResourceDisposal(this);
        }
        finally {
            destroyShaderResource(this.vertex_shader_resource);
            destroyShaderResource(this.fragment_shader_resource);
            this.vertex_shader_resource = null;
            this.fragment_shader_resource = null;
        }
    }

    // Compile a non-GLSL program without creating or linking a raw WebGL program.
    compilePortable() {
        if (this.shader_language !== 'wgsl') {
            throw new Error(`ShaderProgram: unsupported shader language '${this.shader_language}'`);
        }
        if (!this.shader_factory) {
            throw new Error('ShaderProgram: portable compilation requires a shaderFactory');
        }
        if (this.compiling) {
            throw new Error(`ShaderProgram.compile(): ${this.id} (${this.name}) is already compiling`);
        }

        this.compiling = true;
        this.compiled = false;
        this.error = null;
        this.computed_vertex_source = this.prependPortableUniformBlocks(this.vertex_source);
        this.computed_fragment_source = this.prependPortableUniformBlocks(this.fragment_source);

        try {
            const shader_resources = this.createShaderResources(
                this.computed_vertex_source,
                this.computed_fragment_source
            );
            this.destroyShaderResources();
            this.vertex_shader_resource = shader_resources.vertex_shader;
            this.fragment_shader_resource = shader_resources.fragment_shader;
            this.program = null;
            this.compiled = true;
            this.compiling = false;
            ShaderProgram.current = null;
        }
        catch (error) {
            this.program = null;
            this.compiled = false;
            this.compiling = false;
            this.error = error;
            if (error instanceof Object) Object.assign(error, {vertex_shader_source: this.computed_vertex_source, fragment_shader_source: this.computed_fragment_source});
            throw error;
        }

        this.computed_vertex_source = null;
        this.computed_fragment_source = null;
        this.use();
    }

    prependPortableUniformBlocks(source: string) {
        const declarations = Object.values(this.uniform_blocks)
            .filter(uniform_buffer => typeof uniform_buffer.getDeclaration === 'function')
            .map(uniform_buffer => uniform_buffer.getDeclaration({ language: this.shader_language }));
        return declarations.length > 0 ? `${declarations.join('\n')}\n${source}` : source;
    }

    // Make list of defines (global, then program-specific)
    buildDefineList() {
        var d, defines: Record<string, unknown> = {};
        for (d in ShaderProgram.defines) {
            defines[d] = ShaderProgram.defines[d];
        }
        for (d in this.defines) {
            defines[d] = this.defines[d];
        }
        return defines;
    }

    // Make list of shader blocks (global, then program-specific)
    buildShaderBlockList() {
        let key: string, blocks: Record<string, ShaderBlock[]> = {};

        // Global blocks
        for (key in ShaderProgram.blocks) {
            blocks[key] = [];
            const sources = ShaderProgram.blocks[key];
            if (Array.isArray(sources)) {
                blocks[key].push(
                    ...sources.map((source, num) => {
                        return { key, source, num, scope: 'ShaderProgram' };
                    })
                );
            }
            else {
                blocks[key] = [{ key, source: sources, num: 0, scope: 'ShaderProgram' }];
            }
        }

        // Program-specific blocks
        for (key in this.blocks) {
            blocks[key] = blocks[key] || [];
            const sources = this.blocks[key];
            if (Array.isArray(sources)) {
                let scopes = (this.block_scopes && this.block_scopes[key]) || [];
                let cur_scope: string | null = null, num = 0;

                for (let b=0; b < sources.length; b++) {
                    // Count blocks relative to current scope
                    if (scopes[b] !== cur_scope) {
                        cur_scope = scopes[b];
                        num = 0;
                    }

                    blocks[key].push({
                        key,
                        source: sources[b],
                        num,
                        scope: cur_scope || this.name
                    });

                    num++;
                }
            }
            else {
                // TODO: address discrepancy in array vs. single-value blocks
                // styles assume array when tracking block scopes
                blocks[key].push({ key, source: sources, num: 0, scope: this.name });
            }
        }
        return blocks;
    }

    // Inject uniform definitions
    ensureUniforms(uniforms: ShaderProgramOptions['uniforms']) {
        if (!uniforms) {
            return;
        }

        // Get GLSL definitions
        const inject = Object.entries(uniforms).
            map(([name, uniform]) => GLSL.defineUniform(name, uniform)).
            filter(x => x);

        // Inject uniforms
        // NOTE: these are injected at the very top of the shaders, even before any #defines or #pragmas are added
        // this could cause some issues with certain #pragmas, or other functions that might expect #defines
        this.computed_vertex_source = inject.join('\n') + this.computed_vertex_source;
        this.computed_fragment_source = inject.join('\n') + this.computed_fragment_source;
    }

    // Replace standalone uniforms with std140 uniform-block declarations.
    ensureUniformBlocks() {
        for (const uniform_buffer of Object.values(this.uniform_blocks)) {
            const uniforms = uniform_buffer.layout && uniform_buffer.layout.uniforms;
            if (!uniforms || typeof uniform_buffer.getDeclaration !== 'function') {
                continue;
            }

            for (const name of Object.keys(uniforms)) {
                const declaration = new RegExp(
                    `^\\s*uniform\\s+[A-Za-z0-9_]+\\s+${escapeRegExp(name)}\\s*;\\s*(?://.*)?$`,
                    'gm'
                );
                this.computed_vertex_source = this.computed_vertex_source?.replace(declaration, '') ?? null;
                this.computed_fragment_source = this.computed_fragment_source?.replace(declaration, '') ?? null;
            }

            const block_define = `TANGRAM_UNIFORM_BLOCK_${uniform_buffer.name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
            const declaration = `#define ${block_define}\n${uniform_buffer.getDeclaration()}\n`;
            this.computed_vertex_source = declaration + this.computed_vertex_source;
            this.computed_fragment_source = declaration + this.computed_fragment_source;
        }
    }

    // Set uniforms from a JS object, with inferred types
    setUniforms(uniforms: Record<string, unknown>, reset_texture_unit = true) {
        if (!this.compiled) {
            return;
        }

        // TODO: only update uniforms when changed

        // Texture units must be tracked and incremented each time a texture sampler uniform is set.
        // By default, the texture unit is reset to 0 each time setUniforms is called, but they can
        // also be preserved, for example in cases where multiple calls to setUniforms are expected
        // (e.g. program-specific uniforms followed by mesh-specific ones).
        if (reset_texture_unit) {
            this.texture_unit = 0;
        }

        // Parse uniform types and values from the JS object
        GLSL.parseUniforms(uniforms)
            .forEach(({ name, type, value, method }) => {
                if (type === 'sampler2D' && typeof value === 'string') {
                    // For textures, we need to track texture units, so we have a special setter
                    this.setTextureUniform(name, value);
                }
                else if (isNumericUniform(value)) {
                    this.uniform(method, name, value);
                }
            });
    }

    // Register a WebGL2 uniform buffer with this program.
    setUniformBlock(name: string, uniform_buffer: UniformBuffer) {
        this.uniform_blocks[name] = uniform_buffer;
        if (this.compiled && !this.defer_uniform_blocks) {
            uniform_buffer.bind(this.program);
        }
    }

    // Bind all registered WebGL2 uniform buffers to this program.
    bindUniformBlocks({ force = false } = {}) {
        if (!this.compiled || (this.defer_uniform_blocks && !force)) {
            return;
        }
        for (const uniform_buffer of Object.values(this.uniform_blocks)) {
            uniform_buffer.bind(this.program);
        }
    }

    // Return portable luma.gl binding metadata for registered uniform blocks.
    getUniformBlockBindingLayouts() {
        return Object.values(this.uniform_blocks)
            .filter(uniform_buffer => typeof uniform_buffer.getBindingLayout === 'function')
            .map(uniform_buffer => uniform_buffer.getBindingLayout());
    }

    // Return luma.gl Buffer resources keyed by shader block name.
    getUniformBlockBindings() {
        const bindings: Record<string, import('./uniform_buffer').UniformBufferResource> = {};
        for (const [name, uniform_buffer] of Object.entries(this.uniform_blocks)) {
            if (uniform_buffer.buffer_resource) {
                uniform_buffer.upload();
                bindings[name] = uniform_buffer.buffer_resource;
            }
        }
        return bindings;
    }

    // Return luma.gl Texture resources keyed by sampler uniform name.
    getTextureBindings() {
        const bindings: Record<string, import('./texture').TextureResource> = {};
        for (const [uniform_name, texture] of Object.entries(this.texture_uniforms)) {
            const resource = texture && texture.getResource && texture.getResource();
            if (resource) {
                if (this.shader_language === 'glsl') {
                    bindings[uniform_name] = resource;
                }
                // WebGL reflects a sampler array through its base uniform name,
                // while Tangram assigns each texture through an indexed name.
                // Preserve the first element as the base binding expected by luma.
                if (uniform_name.endsWith('[0]')) {
                    bindings[uniform_name.slice(0, -3)] = resource;
                }
                else if (this.shader_language !== 'glsl' && !uniform_name.includes('[')) {
                    bindings[uniform_name] = resource;
                }
            }
        }
        return bindings;
    }

    // Return all portable shader resources for a renderer-owned draw call.
    getBindings() {
        return Object.assign({}, this.getUniformBlockBindings(), this.getTextureBindings());
    }

    // Return the current scalar uniform values for renderers that own the draw call.
    getUniformValues() {
        const values: Record<string, UniformValue> = {};
        for (const [name, uniform] of Object.entries(this.uniforms)) {
            if (uniform.value !== undefined) {
                values[name] = uniform.value;
                // A one-element uniform array is reflected through its base
                // name in WebGL, even though Tangram assigns its first index.
                if (name.endsWith('[0]')) {
                    values[name.slice(0, -3)] = uniform.value;
                }
            }
        }
        return values;
    }

    // Cache some or all uniform values so they can be restored
    saveUniforms(subset?: Record<string, unknown>) {
        let uniforms = subset || this.uniforms;
        for (let u in uniforms) {
            let uniform = this.uniforms[u];
            if (uniform) {
                uniform.saved_value = uniform.value;
            }
        }
        this.saved_uniform_block_data = new Map();
        for (const uniform_buffer of Object.values(this.uniform_blocks)) {
            const block_uniforms = uniform_buffer.layout && uniform_buffer.layout.uniforms;
            if (uniform_buffer.data && block_uniforms &&
                Object.keys(uniforms).some(name => block_uniforms[name])) {
                this.saved_uniform_block_data.set(
                    uniform_buffer,
                    new Uint8Array(uniform_buffer.data).slice()
                );
            }
        }
        this.saved_texture_unit = this.texture_unit || 0;
        this.saved_texture_uniforms = Object.assign({}, this.texture_uniforms);
    }

    // Restore some or all uniforms to saved values
    restoreUniforms(subset?: Record<string, unknown>) {
        let uniforms = subset || this.uniforms;
        for (let u in uniforms) {
            let uniform = this.uniforms[u];
            if (uniform && uniform.saved_value !== undefined) {
                uniform.value = uniform.saved_value;
                this.updateUniform(uniform);
            }
        }
        for (const [uniform_buffer, data] of this.saved_uniform_block_data || []) {
            if (!uniform_buffer.data) continue;
            new Uint8Array(uniform_buffer.data).set(data);
            uniform_buffer.dirty = true;
        }
        this.saved_uniform_block_data = null;
        this.texture_unit = this.saved_texture_unit || 0;
        this.texture_uniforms = this.saved_texture_uniforms || {};
    }

    // Set a texture uniform, finds texture by name or creates a new one
    setTextureUniform(uniform_name: string, texture_name: string) {
        var texture = Texture.textures[texture_name];
        if (texture == null || !isSamplerTexture(texture)) {
            log('warn', `Cannot find texture '${texture_name}'`);
            return;
        }

        this.texture_uniforms[uniform_name] = texture;
        if (!this.defer_texture_bindings) {
            if (typeof texture.bind !== 'function') throw new Error('ShaderProgram: classic texture requires bind');
            texture.bind(this.texture_unit);
            this.uniform('1i', uniform_name, this.texture_unit);
        }
        this.texture_unit++; // TODO: track max texture units and log/throw errors
    }

    // ex: program.uniform('3fv', 'position', [x, y, z]);
    // TODO: only update uniforms when changed
    uniform(method: string, name: string, value: UniformValue) { // 'value' is a method-appropriate arguments list
        if (!this.compiled) {
            return;
        }

        for (const uniform_buffer of Object.values(this.uniform_blocks)) {
            if (uniform_buffer.layout && uniform_buffer.layout.uniforms[name]) {
                uniform_buffer.setUniform(name, value);
                return;
            }
        }

        this.uniforms[name] = this.uniforms[name] || {name, method, value};
        let uniform = this.uniforms[name];
        uniform.name = name;
        if (uniform.location === undefined && !this.defer_uniform_updates) {
            if (!this.program) return;
            uniform.location = this.classicContext.getUniformLocation(this.program, name);
        }
        uniform.method = method;
        uniform.value = value;
        this.updateUniform(uniform);
    }

    // Set a single uniform
    updateUniform(uniform: CachedUniform | undefined) {
        if (!this.compiled) {
            return;
        }

        if (!uniform) {
            return;
        }

        if (this.defer_uniform_updates) {
            return;
        }

        if (uniform.location == null) {
            return;
        }

        this.use();
        this.commitUniform(uniform);
    }

    // Commits the uniform to the GPU
    commitUniform(uniform: CachedUniform){
        let location = uniform.location;
        let value = uniform.value;
        if (location == null) return;
        const context = this.classicContext;

        switch (uniform.method) {
        case '1i':
            if (typeof value === 'number' || typeof value === 'boolean') context.uniform1i(location, Number(value));
            break;
        case '1f':
            if (typeof value === 'number') context.uniform1f(location, value);
            break;
        case '2f':
            if (typeof value === 'object') context.uniform2f(location, value[0], value[1]);
            break;
        case '3f':
            if (typeof value === 'object') context.uniform3f(location, value[0], value[1], value[2]);
            break;
        case '4f':
            if (typeof value === 'object') context.uniform4f(location, value[0], value[1], value[2], value[3]);
            break;
        case '1iv':
            if (typeof value === 'object') context.uniform1iv(location, getIntegerUniformList(value));
            break;
        case '3iv':
            if (typeof value === 'object') context.uniform3iv(location, getIntegerUniformList(value));
            break;
        case '1fv':
            if (typeof value === 'object') context.uniform1fv(location, getFloatUniformList(value));
            break;
        case '2fv':
            if (typeof value === 'object') context.uniform2fv(location, getFloatUniformList(value));
            break;
        case '3fv':
            if (typeof value === 'object') context.uniform3fv(location, getFloatUniformList(value));
            break;
        case '4fv':
            if (typeof value === 'object') context.uniform4fv(location, getFloatUniformList(value));
            break;
        case 'Matrix3fv':
            if (typeof value === 'object') context.uniformMatrix3fv(location, false, getFloatUniformList(value));
            break;
        case 'Matrix4fv':
            if (typeof value === 'object') context.uniformMatrix4fv(location, false, getFloatUniformList(value));
            break;
        }
    }

    // Refresh uniform locations and set to last cached values
    refreshUniforms() {
        if (!this.compiled) {
            return;
        }

        if (this.defer_uniform_updates || !this.program) {
            return;
        }

        for (var u in this.uniforms) {
            let uniform = this.uniforms[u];
            uniform.location = this.classicContext.getUniformLocation(this.program, u);
            this.updateUniform(uniform);
        }
    }

    refreshAttributes() {
        // var len = this.gl.getProgramParameter(this.program, this.gl.ACTIVE_ATTRIBUTES);
        // for (var i=0; i < len; i++) {
        //     var a = this.gl.getActiveAttrib(this.program, i);
        // }
        this.attribs = {};
    }

    // Get the location of a vertex attribute
    attribute(name: string) {
        if (!this.compiled || !this.program) {
            return;
        }

        var attrib = (this.attribs[name] = this.attribs[name] || {name, location: this.classicContext.getAttribLocation(this.program, name)});
        if (attrib.location != null) {
            return attrib;
        }

        attrib.name = name;
        attrib.location = this.classicContext.getAttribLocation(this.program, name);

        // var info = this.gl.getActiveAttrib(this.program, attrib.location);
        // attrib.type = info.type;
        // attrib.size = info.size;

        return attrib;
    }

    // Get shader source as string
    source(type: ShaderStage) {
        if (type === 'vertex') {
            return this.computed_vertex_source;
        }
        else if (type === 'fragment') {
            return this.computed_fragment_source;
        }
    }

    // Get shader source as array of line strings
    lines(type: ShaderStage) {
        let source = this.source(type);
        if (source) {
            return source.split('\n');
        }
        return [];
    }

    // Get a specific line from shader source
    line(type: ShaderStage, num: number) {
        let source = this.lines(type);
        if (source) {
            return source[num];
        }
    }

    // Get info on which shader block (if any) a particular line number in a shader is in
    // Returns an object with the following info if a block is found: { name, line, source }
    //  scope: where the shader block originated, either a style name, or global such as ShaderProgram
    //  name: shader block name (e.g. 'color', 'position', 'global')
    //  num: the block number *within* local scope (e.g. if a style has multiple 'color' blocks)
    //  line: line number *within* the shader block (not the whole shader program), useful for error highlighting
    //  source: the code for the line
    // NOTE: this does a bruteforce loop over the shader source and looks for shader block start/end markers
    // We could track line ranges for shader blocks as they are inserted, but as this code is only used for
    // error handling on compilation failure, it was simpler to keep it separate than to burden the core
    // compilation path.
    block(type: ShaderStage, num: number) {
        let lines = this.lines(type);
        let block: ShaderBlockLocation | null | undefined;
        for (let i=0; i < num && i < lines.length; i++) {
            let line = lines[i];
            let match = line.match(/\/\/ tangram-block-start: ([A-Za-z0-9_-]+), ([A-Za-z0-9_-]+), (\d+)/);
            if (match && match.length > 1) {
                // mark current block
                block = {
                    scope: match[1],
                    name: match[2],
                    num: match[3]
                };
            }
            else {
                match = line.match(/\/\/ tangram-block-end: ([A-Za-z0-9_-]+), ([A-Za-z0-9_-]+), (\d+)/);
                if (match && match.length > 1) {
                    block = null; // clear current block
                }
            }

            // update line # and content
            if (block) {
                // init to -1 so that line 0 is first actual line of block code, after comment marker
                block.line = (block.line == null) ? -1 : block.line + 1;
                block.source = line;
            }
        }
        return block;
    }

    // Returns list of available extensions from those requested
    // Sets internal #defines indicating availability of each requested extension
    checkExtensions() {
        let exts: string[] = [];
        this.extensions.forEach(name => {
            let ext = getExtension(this.classicContext, name);
            let def = `TANGRAM_EXTENSION_${name}`;

            this.defines[def] = (ext != null);

            if (ext) {
                exts.push(name);
            }
            else {
                log('debug', `Could not enable extension '${name}'`);
            }
        });
        return exts;
    }

}


// Static methods and state
ShaderProgram.id = 0;                   // assign each program a unique id
ShaderProgram.current = null;           // currently bound program

// Global config applied to all programs (duplicate properties for a specific program will take precedence)
ShaderProgram.defines = {};
ShaderProgram.blocks = {};

// Reset program and shader caches
ShaderProgram.reset = function () {
    ShaderProgram.programs_by_source = {};  // GL program objects by exact vertex + fragment shader source
    ShaderProgram.shaders_by_source = {};   // GL shader objects by exact source
};
ShaderProgram.reset();

// Invalidate Tangram's program cache when another renderer shares the context.
ShaderProgram.resetCurrent = function () {
    ShaderProgram.current = null;
};

/** Release one wrapper's program and evict it only when its last owner retires. */
ShaderProgram.releaseProgram = function (gl, program) {
    if (!program) return;
    const references = programReferences.get(program) || 1;
    if (references > 1) {
        programReferences.set(program, references - 1);
        return;
    }
    programReferences.delete(program);
    for (const key of Object.keys(ShaderProgram.programs_by_source)) {
        if (ShaderProgram.programs_by_source[key] === program) {
            delete ShaderProgram.programs_by_source[key];
        }
    }
    gl.deleteProgram(program);
};

// Upgrade the subset of GLSL ES 1.00 syntax emitted by Tangram to GLSL ES 3.00.
ShaderProgram.convertToWebGL2 = function (source, type) {
    source = source
        .replace(re_texture_2d, 'texture')
        .replace(re_texture_cube, 'texture');

    if (type === 'vertex') {
        source = source
            .replace(/\battribute\b/g, 'in')
            .replace(/\bvarying\b/g, 'out');
        source = source.replace(
            /(^|\n)(\s*)in\s+([^;\n]*\ba_position\b[^;\n]*;)/,
            '$1$2layout(location = 0) in $3'
        );
    }
    else if (type === 'fragment') {
        source = source
            .replace(/\bvarying\b/g, 'in')
            .replace(re_fragment_color, 'tangram_FragColor');
        source = source.replace(
            /(precision\s+(?:lowp|mediump|highp)\s+float\s*;)/,
            '$1\nlayout(location = 0) out vec4 tangram_FragColor;'
        );
    }

    return '#version 300 es\n' + source;
};

// Turn an object of key/value pairs into single string of #define statements
ShaderProgram.buildDefineString = function (defines) {
    var define_str = '';
    for (var d in defines) {
        const value = defines[d];
        if (value == null || value === false) {
            continue;
        }
        else if (value === true) { // booleans are simple defines with no value
            define_str += '#define ' + d + '\n';
        }
        else if (typeof value === 'number' && Math.floor(value) === value) { // int to float conversion to satisfy GLSL floats
            define_str += '#define ' + d + ' ' + value.toFixed(1) + '\n';
        }
        else if (typeof value === 'number') {
            // GLSL floats do not benefit from JavaScript's full double precision, and
            // some WebGL compilers reject excessively precise decimal literals.
            define_str += '#define ' + d + ' ' + Number(value.toPrecision(12)) + '\n';
        }
        else { // any other float or string value
            define_str += '#define ' + d + ' ' + defines[d] + '\n';
        }
    }
    return define_str;
};

// Turn a list of extension names into single string of #extension statements
ShaderProgram.buildExtensionString = function (extensions) {
    extensions = extensions || [];
    let str = '';
    extensions.forEach(ext => {
        str += `#ifdef GL_${ext}\n#extension GL_${ext} : enable\n#endif\n`;
    });
    return str;
};

ShaderProgram.addBlock = function (key, ...blocks) {
    ShaderProgram.blocks[key] = ShaderProgram.blocks[key] || [];
    const sources = ShaderProgram.blocks[key];
    if (!Array.isArray(sources)) throw new TypeError(`ShaderProgram: global block '${key}' must be an array before appending`);
    sources.push(...blocks);
};

function escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove all global shader blocks for a given key
ShaderProgram.removeBlock = function (key) {
    ShaderProgram.blocks[key] = [];
};

ShaderProgram.replaceBlock = function (key, ...blocks) {
    ShaderProgram.removeBlock(key);
    ShaderProgram.addBlock(key, ...blocks);
};

// Compile & link a WebGL program from provided vertex and fragment shader sources
// update a program if one is passed in. Create one if not. Alert and don't update anything if the shaders don't compile.
ShaderProgram.updateProgram = function (gl, program, vertex_shader_source, fragment_shader_source, shader_resources = {}) {
    const use_shader_resources = Boolean(shader_resources.vertex_shader || shader_resources.fragment_shader);
    if (use_shader_resources && (!shader_resources.vertex_shader || !shader_resources.fragment_shader)) {
        throw new Error('ShaderProgram.updateProgram requires both vertex and fragment shader resources');
    }

    // Program with this exact vertex and fragment shader sources already cached?
    let key = hashString(gl._tangram_id + '::' + vertex_shader_source + '::' + fragment_shader_source);
    if (!use_shader_resources && ShaderProgram.programs_by_source[key]) {
        log('trace', 'Reusing identical source GL program object');
        const cached = ShaderProgram.programs_by_source[key];
        if (cached !== program) {
            ShaderProgram.releaseProgram(gl, program);
            programReferences.set(cached, (programReferences.get(cached) || 0) + 1);
        }
        return cached;
    }

    var vertex_shader = use_shader_resources ? shader_resources.vertex_shader?.handle :
        ShaderProgram.createShader(gl, vertex_shader_source, gl.VERTEX_SHADER);
    var fragment_shader = use_shader_resources ? shader_resources.fragment_shader?.handle :
        ShaderProgram.createShader(gl, fragment_shader_source, gl.FRAGMENT_SHADER);

    gl.useProgram(null);
    // Relinking a shared program would also change every other wrapper using it.
    ShaderProgram.releaseProgram(gl, program);
    program = gl.createProgram();
    if (!program) throw new Error('ShaderProgram: WebGL program allocation failed');
    programReferences.set(program, 1);

    if (vertex_shader == null || fragment_shader == null) {
        return program;
    }

    gl.attachShader(program, vertex_shader);
    gl.attachShader(program, fragment_shader);

    // Require position to be at attribute location 0
    // Attribute 0 should never be disabled (per GL best practices). All of our shader programs have an `a_position`
    // attribute, and it's customary for the vertex position to be the first attribute, so we enforce that here.
    // This can avoid unexpected/undefined interaction between static and dynamic attributes in Safari, and
    // possible warnings/errors in other browsers.
    // See https://stackoverflow.com/questions/20305231/webgl-warning-attribute-0-is-disabled-this-has-significant-performance-penalt/20923946
    gl.bindAttribLocation(program, 0, 'a_position');

    gl.linkProgram(program);

    // TODO: reference count and delete shader objects when no programs reference them

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        let message = new Error(
            `WebGL program error:
            PROGRAM_INFO_LOG: ${gl.getProgramInfoLog(program)}
            VERTEX_SHADER_INFO_LOG: ${gl.getShaderInfoLog(vertex_shader)}
            FRAGMENT_SHADER_INFO_LOG: ${gl.getShaderInfoLog(fragment_shader)}
            VALIDATE_STATUS: ${gl.getProgramParameter(program, gl.VALIDATE_STATUS)}
            ERROR: ${gl.getError()}
            --- Vertex Shader ---
            ${vertex_shader_source}
            --- Fragment Shader ---
            ${fragment_shader_source}`);

        ShaderProgram.releaseProgram(gl, program);
        throw Object.assign(new Error(message.message), { type: 'program' });
    }

    if (!use_shader_resources) {
        ShaderProgram.programs_by_source[key] = program; // cache by exact source
    }
    return program;
};

// Compile a vertex or fragment shader from provided source
ShaderProgram.createShader = function (gl, source, stype) {
    // Program with identical vertex and fragment shader sources already cached?
    let key = hashString(gl._tangram_id + '::' + source);
    if (ShaderProgram.shaders_by_source[key]) {
        log('trace', 'Reusing identical source GL shader object');
        return ShaderProgram.shaders_by_source[key];
    }

    let shader = gl.createShader(stype);
    if (!shader) throw new Error('ShaderProgram: WebGL shader allocation failed');

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        let type = (stype === gl.VERTEX_SHADER ? 'vertex' : 'fragment');
        let message = gl.getShaderInfoLog(shader);
        let errors = parseShaderErrors(message);
        throw Object.assign(new Error(message ?? ''), { type, errors });
    }

    ShaderProgram.shaders_by_source[key] = shader; // cache by exact source
    return shader;
};

function destroyShaderResource(shader: Pick<Shader, 'destroy'> | null | undefined) {
    if (shader && typeof shader.destroy === 'function') {
        shader.destroy();
    }
}

/** Structural classic boundary also accepts deterministic WebGL fixtures. */
function isShaderContext(context: object | null): context is ShaderContext {
    return context !== null && 'useProgram' in context && typeof context.useProgram === 'function';
}
/** Only native stage diagnostics carry a parsed error list. */
function isShaderFailure(error: unknown): error is {type: ShaderStage; errors: ShaderDiagnostic[]} {
    return error instanceof Object && 'type' in error && (error.type === 'vertex' || error.type === 'fragment') &&
        'errors' in error && Array.isArray(error.errors);
}

/** Numeric uniforms are distinct from named texture samplers. */
function isNumericUniform(value: unknown): value is UniformValue {
    return typeof value === 'number' || typeof value === 'boolean' ||
        Array.isArray(value) && value.every(component => typeof component === 'number');
}

/** Metadata-only worker records cannot bind; portable samplers need no classic bind method. */
function isSamplerTexture(texture: object): texture is SamplerTexture {
    return 'getResource' in texture && typeof texture.getResource === 'function' ||
        'bind' in texture && typeof texture.bind === 'function';
}

/** Preserve existing numeric arrays and ArrayBuffer-backed float views without per-draw copies. */
function getFloatUniformList(value: Exclude<UniformValue, number | boolean>): Float32List {
    if (Array.isArray(value)) return value;
    if (isFloat32UniformList(value)) return value;
    return Array.from(value);
}
/** Preserve existing numeric arrays and integer views used by classic vector uniforms. */
function getIntegerUniformList(value: Exclude<UniformValue, number | boolean>): Int32List {
    if (Array.isArray(value)) return value;
    if (isInt32UniformList(value)) return value;
    return Array.from(value);
}
/** WebGL accepts non-shared float storage; the check narrows the buffer ownership parameter. */
function isFloat32UniformList(value: unknown): value is Float32Array<ArrayBuffer> {
    return value instanceof Float32Array && value.buffer instanceof ArrayBuffer;
}
/** WebGL accepts non-shared integer storage; the check narrows the buffer ownership parameter. */
function isInt32UniformList(value: unknown): value is Int32Array<ArrayBuffer> {
    return value instanceof Int32Array && value.buffer instanceof ArrayBuffer;
}
