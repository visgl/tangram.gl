// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// Creates a Vertex Array Object if the extension is available, or falls back on standard attribute calls

import getExtension from './extensions';
import log from '../utils/log';

/** Extension shape shared by WebGL 1's OES API and the native WebGL 2 adapter. */
interface VertexArrayExtension {
    createVertexArrayOES(): WebGLVertexArrayObject | null;
    deleteVertexArrayOES(array: WebGLVertexArrayObject | null): void;
    bindVertexArrayOES(array: WebGLVertexArrayObject | null): void;
}
/** Context operations needed to create or emulate vertex-array state. */
export type VertexArrayContext = Pick<WebGLRenderingContext, 'getExtension'> &
    Partial<Pick<WebGL2RenderingContext, 'createVertexArray' | 'deleteVertexArray' | 'bindVertexArray'>>;
/** Stored setup/teardown hooks and an optional native vertex-array handle. */
export interface VertexArrayBinding {
    setup(): void;
    teardown?: () => void;
    _vao?: WebGLVertexArrayObject | null;
}
/** Per-context VAO tracking with the legacy fallback behavior retained. */
interface VertexArrayRuntime {
    disabled: boolean;
    bound_vao: [VertexArrayContext, VertexArrayBinding | null][];
    init(context: VertexArrayContext): void;
    getExtension(context: VertexArrayContext, name: string): unknown;
    create(context: VertexArrayContext, setup: () => void, teardown?: () => void): VertexArrayBinding;
    getCurrentBinding(context: VertexArrayContext): VertexArrayBinding | null | undefined;
    setCurrentBinding(context: VertexArrayContext, binding: VertexArrayBinding | null): void;
    bind(context: VertexArrayContext, binding: VertexArrayBinding | null): void;
    destroy(context: VertexArrayContext, binding: VertexArrayBinding | null | undefined): void;
}

const native_extensions = new WeakMap<object, VertexArrayExtension>();

function getVertexArrayExtension(gl: VertexArrayContext): VertexArrayExtension | null | undefined {
    const extension = getExtension(gl, 'OES_vertex_array_object') as VertexArrayExtension | null;
    if (extension || typeof gl.createVertexArray !== 'function') {
        return extension;
    }

    if (!native_extensions.has(gl)) {
        native_extensions.set(gl, {
            createVertexArrayOES: () => gl.createVertexArray!(),
            deleteVertexArrayOES: vao => gl.deleteVertexArray!(vao),
            bindVertexArrayOES: vao => gl.bindVertexArray!(vao)
        });
    }
    return native_extensions.get(gl);
}

const Vao: VertexArrayRuntime = {

    disabled: false, // set to true to disable VAOs even if extension is available
    bound_vao: [],   // currently bound VAO, by GL context

    init (gl) {
        let ext;
        if (this.disabled !== true) {
            ext = getVertexArrayExtension(gl);
        }

        if (ext != null) {
            log('info', 'Vertex Array Object extension available');
        }
        else if (this.disabled !== true) {
            log('warn', 'Vertex Array Object extension NOT available');
        }
        else {
            log('warn', 'Vertex Array Object extension force disabled');
        }
    },

    getExtension(gl, ext_name) {
        if (this.disabled !== true) {
            if (ext_name === 'OES_vertex_array_object') {
                return getVertexArrayExtension(gl);
            }
            return getExtension(gl, ext_name);
        }
    },

    create (gl, setup, teardown) {
        let vao = {} as VertexArrayBinding; // Hooks are assigned before the binding escapes.
        vao.setup = setup;
        vao.teardown = teardown;

        let ext = this.getExtension(gl, 'OES_vertex_array_object') as VertexArrayExtension | null | undefined;
        if (ext != null) {
            vao._vao = ext.createVertexArrayOES();
            ext.bindVertexArrayOES(vao._vao);
        }

        vao.setup();

        return vao;
    },

    getCurrentBinding (gl) {
        let bound = this.bound_vao.filter(e => e[0] === gl)[0];
        return bound && bound[1];
    },

    setCurrentBinding (gl, vao) {
        let bound_vao = this.bound_vao;
        let binding = bound_vao.filter(e => e[0] === gl)[0];
        if (binding == null) {
            bound_vao.push([gl, vao]);
        }
        else {
            binding[1] = vao;
        }
    },

    bind (gl, vao) {
        let ext = this.getExtension(gl, 'OES_vertex_array_object') as VertexArrayExtension | null | undefined;
        if (vao != null) {
            if (ext != null && vao._vao != null) {
                ext.bindVertexArrayOES(vao._vao);
                this.setCurrentBinding(gl, vao);
            }
            else {
                vao.setup();
            }
        }
        else {
            let bound_vao = this.getCurrentBinding(gl);
            if (ext != null) {
                ext.bindVertexArrayOES(null);
            }
            else if (bound_vao != null && typeof bound_vao.teardown === 'function') {
                bound_vao.teardown();
            }
            this.setCurrentBinding(gl, null);
        }
    },

    destroy (gl, vao) {
        let ext = this.getExtension(gl, 'OES_vertex_array_object') as VertexArrayExtension | null | undefined;
        if (ext != null && vao != null && vao._vao != null) {
            ext.deleteVertexArrayOES(vao._vao);
            vao._vao = null;
        }
        // destroy is a no-op if VAO extension isn't available
    }

};

export default Vao;
