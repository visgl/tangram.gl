// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen

// GL program wrapper to cache uniform locations/values, do compile-time pre-processing
// (injecting #defines and #pragma blocks into shaders), etc.

// @ts-nocheck

import log from '../utils/log';
import GLSL from './glsl';
import Texture from './texture';
import getExtension from './extensions';
import hashString from '../utils/hash';

import parseShaderErrors from 'gl-shader-errors';

// Regex patterns
const re_pragma = /^\s*#pragma.*$/gm;   // for removing unused pragmas after shader block injection
const re_continue_line = /\\\s*\n/mg;   // for removing backslash line continuations
const re_fragment_color = /\bgl_FragColor\b/g;
const re_texture_2d = /\btexture2D\b/g;
const re_texture_cube = /\btextureCube\b/g;

export default class ShaderProgram {
    /** Replaces a named Tangram shader block with the supplied source fragments. */
    static declare replaceBlock: (key: string, ...blocks: string[]) => void;

    constructor(gl, vertex_source, fragment_source, options) {
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

    destroy() {
        if (this.shader_language === 'glsl' && !this.device_shader_compilation) {
            this.gl.useProgram(null);
            this.gl.deleteProgram(this.program);
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
            this.gl.useProgram(this.program);
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
        let high = this.gl.getShaderPrecisionFormat(this.gl.FRAGMENT_SHADER, this.gl.HIGH_FLOAT);
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
                    this.shader_program_validator({
                        id: this.name || this.id,
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
                        this.gl,
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
            this.error.vertex_shader_source = this.computed_vertex_source;
            this.error.fragment_shader_source = this.computed_fragment_source;

            if (error.type === 'vertex' || error.type === 'fragment') {
                this.shader_errors = error.errors;
                this.shader_errors.forEach(e => {
                    e.type = error.type;
                    e.block = this.block(error.type, e.line);
                    e.line = this.block(error.type, e.line);
                });
                this.error.shader_errors = this.shader_errors;
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

    createShaderResources(vertex_source, fragment_source) {
        let vertex_shader;
        try {
            const vertex_options = {
                id: `${this.name || this.id}-vertex`,
                stage: 'vertex',
                language: this.shader_language,
                source: vertex_source
            };
            const fragment_options = {
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
        destroyShaderResource(this.vertex_shader_resource);
        destroyShaderResource(this.fragment_shader_resource);
        this.vertex_shader_resource = null;
        this.fragment_shader_resource = null;
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
            error.vertex_shader_source = this.computed_vertex_source;
            error.fragment_shader_source = this.computed_fragment_source;
            throw error;
        }

        this.computed_vertex_source = null;
        this.computed_fragment_source = null;
        this.use();
    }

    prependPortableUniformBlocks(source) {
        const declarations = Object.values(this.uniform_blocks)
            .filter(uniform_buffer => typeof uniform_buffer.getDeclaration === 'function')
            .map(uniform_buffer => uniform_buffer.getDeclaration({ language: this.shader_language }));
        return declarations.length > 0 ? `${declarations.join('\n')}\n${source}` : source;
    }

    // Make list of defines (global, then program-specific)
    buildDefineList() {
        var d, defines = {};
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
        let key, blocks = {};

        // Global blocks
        for (key in ShaderProgram.blocks) {
            blocks[key] = [];

            if (Array.isArray(ShaderProgram.blocks[key])) {
                blocks[key].push(
                    ...ShaderProgram.blocks[key].map((source, num) => {
                        return { key, source, num, scope: 'ShaderProgram' };
                    })
                );
            }
            else {
                blocks[key] = [{ key, source: ShaderProgram.blocks[key], num: 0, scope: 'ShaderProgram' }];
            }
        }

        // Program-specific blocks
        for (key in this.blocks) {
            blocks[key] = blocks[key] || [];

            if (Array.isArray(this.blocks[key])) {
                let scopes = (this.block_scopes && this.block_scopes[key]) || [];
                let cur_scope = null, num = 0;

                for (let b=0; b < this.blocks[key].length; b++) {
                    // Count blocks relative to current scope
                    if (scopes[b] !== cur_scope) {
                        cur_scope = scopes[b];
                        num = 0;
                    }

                    blocks[key].push({
                        key,
                        source: this.blocks[key][b],
                        num,
                        scope: cur_scope || this.name
                    });

                    num++;
                }
            }
            else {
                // TODO: address discrepancy in array vs. single-value blocks
                // styles assume array when tracking block scopes
                blocks[key].push({ key, source: this.blocks[key], num: 0, scope: this.name });
            }
        }
        return blocks;
    }

    // Inject uniform definitions
    ensureUniforms(uniforms) {
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
                this.computed_vertex_source = this.computed_vertex_source.replace(declaration, '');
                this.computed_fragment_source = this.computed_fragment_source.replace(declaration, '');
            }

            const block_define = `TANGRAM_UNIFORM_BLOCK_${uniform_buffer.name.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()}`;
            const declaration = `#define ${block_define}\n${uniform_buffer.getDeclaration()}\n`;
            this.computed_vertex_source = declaration + this.computed_vertex_source;
            this.computed_fragment_source = declaration + this.computed_fragment_source;
        }
    }

    // Set uniforms from a JS object, with inferred types
    setUniforms(uniforms, reset_texture_unit = true) {
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
                if (type === 'sampler2D') {
                    // For textures, we need to track texture units, so we have a special setter
                    this.setTextureUniform(name, value);
                }
                else {
                    this.uniform(method, name, value);
                }
            });
    }

    // Register a WebGL2 uniform buffer with this program.
    setUniformBlock(name, uniform_buffer) {
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
        const bindings = {};
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
        const bindings = {};
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
        const values = {};
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
    saveUniforms(subset) {
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
    restoreUniforms(subset) {
        let uniforms = subset || this.uniforms;
        for (let u in uniforms) {
            let uniform = this.uniforms[u];
            if (uniform && uniform.saved_value !== undefined) {
                uniform.value = uniform.saved_value;
                this.updateUniform(uniform);
            }
        }
        for (const [uniform_buffer, data] of this.saved_uniform_block_data || []) {
            new Uint8Array(uniform_buffer.data).set(data);
            uniform_buffer.dirty = true;
        }
        this.saved_uniform_block_data = null;
        this.texture_unit = this.saved_texture_unit || 0;
        this.texture_uniforms = this.saved_texture_uniforms || {};
    }

    // Set a texture uniform, finds texture by name or creates a new one
    setTextureUniform(uniform_name, texture_name) {
        var texture = Texture.textures[texture_name];
        if (texture == null) {
            log('warn', `Cannot find texture '${texture_name}'`);
            return;
        }

        this.texture_uniforms[uniform_name] = texture;
        if (!this.defer_texture_bindings) {
            texture.bind(this.texture_unit);
            this.uniform('1i', uniform_name, this.texture_unit);
        }
        this.texture_unit++; // TODO: track max texture units and log/throw errors
    }

    // ex: program.uniform('3fv', 'position', [x, y, z]);
    // TODO: only update uniforms when changed
    uniform(method, name, value) { // 'value' is a method-appropriate arguments list
        if (!this.compiled) {
            return;
        }

        for (const uniform_buffer of Object.values(this.uniform_blocks)) {
            if (uniform_buffer.layout && uniform_buffer.layout.uniforms[name]) {
                uniform_buffer.setUniform(name, value);
                return;
            }
        }

        this.uniforms[name] = this.uniforms[name] || {};
        let uniform = this.uniforms[name];
        uniform.name = name;
        if (uniform.location === undefined && !this.defer_uniform_updates) {
            uniform.location = this.gl.getUniformLocation(this.program, name);
        }
        uniform.method = method;
        uniform.value = value;
        this.updateUniform(uniform);
    }

    // Set a single uniform
    updateUniform(uniform) {
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
    commitUniform(uniform){
        let location = uniform.location;
        let value = uniform.value;

        switch (uniform.method) {
        case '1i':
            this.gl.uniform1i(location, value);
            break;
        case '1f':
            this.gl.uniform1f(location, value);
            break;
        case '2f':
            this.gl.uniform2f(location, value[0], value[1]);
            break;
        case '3f':
            this.gl.uniform3f(location, value[0], value[1], value[2]);
            break;
        case '4f':
            this.gl.uniform4f(location, value[0], value[1], value[2], value[3]);
            break;
        case '1iv':
            this.gl.uniform1iv(location, value);
            break;
        case '3iv':
            this.gl.uniform3iv(location, value);
            break;
        case '1fv':
            this.gl.uniform1fv(location, value);
            break;
        case '2fv':
            this.gl.uniform2fv(location, value);
            break;
        case '3fv':
            this.gl.uniform3fv(location, value);
            break;
        case '4fv':
            this.gl.uniform4fv(location, value);
            break;
        case 'Matrix3fv':
            this.gl.uniformMatrix3fv(location, false, value);
            break;
        case 'Matrix4fv':
            this.gl.uniformMatrix4fv(location, false, value);
            break;
        }
    }

    // Refresh uniform locations and set to last cached values
    refreshUniforms() {
        if (!this.compiled) {
            return;
        }

        if (this.defer_uniform_updates) {
            return;
        }

        for (var u in this.uniforms) {
            let uniform = this.uniforms[u];
            uniform.location = this.gl.getUniformLocation(this.program, u);
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
    attribute(name) {
        if (!this.compiled) {
            return;
        }

        var attrib = (this.attribs[name] = this.attribs[name] || {});
        if (attrib.location != null) {
            return attrib;
        }

        attrib.name = name;
        attrib.location = this.gl.getAttribLocation(this.program, name);

        // var info = this.gl.getActiveAttrib(this.program, attrib.location);
        // attrib.type = info.type;
        // attrib.size = info.size;

        return attrib;
    }

    // Get shader source as string
    source(type) {
        if (type === 'vertex') {
            return this.computed_vertex_source;
        }
        else if (type === 'fragment') {
            return this.computed_fragment_source;
        }
    }

    // Get shader source as array of line strings
    lines(type) {
        let source = this.source(type);
        if (source) {
            return source.split('\n');
        }
        return [];
    }

    // Get a specific line from shader source
    line(type, num) {
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
    block(type, num) {
        let lines = this.lines(type);
        let block;
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
        let exts = [];
        this.extensions.forEach(name => {
            let ext = getExtension(this.gl, name);
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
        if (defines[d] == null || defines[d] === false) {
            continue;
        }
        else if (typeof defines[d] === 'boolean' && defines[d] === true) { // booleans are simple defines with no value
            define_str += '#define ' + d + '\n';
        }
        else if (typeof defines[d] === 'number' && Math.floor(defines[d]) === defines[d]) { // int to float conversion to satisfy GLSL floats
            define_str += '#define ' + d + ' ' + defines[d].toFixed(1) + '\n';
        }
        else if (typeof defines[d] === 'number') {
            // GLSL floats do not benefit from JavaScript's full double precision, and
            // some WebGL compilers reject excessively precise decimal literals.
            define_str += '#define ' + d + ' ' + Number(defines[d].toPrecision(12)) + '\n';
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
    ShaderProgram.blocks[key].push(...blocks);
};

function escapeRegExp(value) {
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
        return ShaderProgram.programs_by_source[key];
    }

    var vertex_shader = use_shader_resources ? shader_resources.vertex_shader.handle :
        ShaderProgram.createShader(gl, vertex_shader_source, gl.VERTEX_SHADER);
    var fragment_shader = use_shader_resources ? shader_resources.fragment_shader.handle :
        ShaderProgram.createShader(gl, fragment_shader_source, gl.FRAGMENT_SHADER);

    gl.useProgram(null);
    if (program != null) {
        var old_shaders = gl.getAttachedShaders(program);
        for(var i = 0; i < old_shaders.length; i++) {
            gl.detachShader(program, old_shaders[i]);
        }
    } else {
        program = gl.createProgram();
    }

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

        throw Object.assign(new Error(message), { type: 'program' });
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

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        let type = (stype === gl.VERTEX_SHADER ? 'vertex' : 'fragment');
        let message = gl.getShaderInfoLog(shader);
        let errors = parseShaderErrors(message);
        throw Object.assign(new Error(message), { type, errors });
    }

    ShaderProgram.shaders_by_source[key] = shader; // cache by exact source
    return shader;
};

function destroyShaderResource(shader) {
    if (shader && typeof shader.destroy === 'function') {
        shader.destroy();
    }
}
