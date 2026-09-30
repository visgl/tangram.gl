// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import VBOMesh from '../src/gl/vbo_mesh';
import Scene from '../src/scene/classic_scene';
import VertexLayout from '../src/gl/vertex_layout';
import gl_constants from '../src/gl/constants';

describe('VBOMesh render backend', function () {
    it('can allocate and destroy luma-style vertex and index buffer resources', function () {
        const vertex_data = new Float32Array([0, 1, 2, 3, 4, 5]);
        const element_data = new Uint16Array([0, 1, 2]);
        const resources = [];
        const factory_options = [];
        const buffer_factory = options => {
            factory_options.push(options);
            const resource = {
                get handle() { throw new Error('renderer-owned buffers must remain opaque'); },
                destroyed: false,
                destroy() {
                    this.destroyed = true;
                }
            };
            resources.push(resource);
            return resource;
        };
        const gl = {
            STATIC_DRAW: 0x88E4,
            TRIANGLES: 0x0004,
            UNSIGNED_SHORT: 0x1403,
            UNSIGNED_INT: 0x1405,
            createBuffer() {
                throw new Error('raw WebGL buffer allocation should be skipped');
            }
        };
        const mesh = new VBOMesh(gl, vertex_data, element_data, { stride: 8 }, {
            id: 'test',
            bufferFactory: buffer_factory
        });

        expect(mesh.vertex_buffer).toBe(resources[0]);
        expect(mesh.element_buffer).toBe(resources[1]);
        expect(factory_options).toEqual([{
            id: 'mesh-test-vertices',
            usage: 'vertex',
            data: vertex_data
        }, {
            id: 'mesh-test-indices',
            usage: 'index',
            indexType: 'uint16',
            data: element_data
        }]);

        mesh.destroy();
        expect(resources[0].destroyed).toBe(true);
        expect(resources[1].destroyed).toBe(true);
    });

    it('exposes a portable indexed draw descriptor', function () {
        const vertex_data = new Int16Array([0, 1, 2, 3, 4, 5]);
        const element_data = new Uint16Array([0, 1, 2]);
        const resources = [];
        const gl = {
            STATIC_DRAW: 0x88E4,
            TRIANGLES: 0x0004,
            UNSIGNED_SHORT: 0x1403,
            UNSIGNED_INT: 0x1405
        };
        const vertex_layout = new VertexLayout([
            { name: 'a_position', size: 2, type: gl_constants.SHORT, normalized: false },
            { name: 'a_color', size: 4, type: gl_constants.UNSIGNED_BYTE, normalized: true, static: [1, 1, 1, 1] }
        ]);
        const mesh = new VBOMesh(gl, vertex_data, element_data, vertex_layout, {
            id: 'descriptor',
            bufferFactory(options) {
                const resource = {
                    options,
                    get handle() { throw new Error('renderer-owned buffers must remain opaque'); },
                    destroy() {}
                };
                resources.push(resource);
                return resource;
            }
        });

        expect(mesh.getDrawDescriptor()).toEqual({
            topology: 'triangle-list',
            vertexCount: 3,
            indexCount: 3,
            indexType: 'uint16',
            vertexBuffer: resources[0],
            indexBuffer: resources[1],
            bufferLayout: {
                name: 'vertices',
                byteStride: 4,
                attributes: [
                    { attribute: 'a_position', format: 'sint16x2', byteOffset: 0 }
                ]
            },
            staticAttributes: [{ attribute: 'a_color', value: [1, 1, 1, 1] }]
        });

        mesh.destroy();
    });

    it('owns handle-free portable buffers without reading a WebGL context', function () {
        const resources = [];
        const mesh = new VBOMesh(null, new Float32Array([0, 1, 2, 3]), null, {
            stride: 8,
            getBufferLayout() {
                return { name: 'vertices', attributes: [] };
            },
            getStaticAttributes() {
                return [];
            }
        }, {
            bufferFactory() {
                const resource = {
                    get handle() { throw new Error('portable buffers must remain opaque'); },
                    destroy() { this.destroyed = true; }
                };
                resources.push(resource);
                return resource;
            }
        });

        expect(mesh.vertex_buffer).toBe(resources[0]);
        expect(mesh.getDrawDescriptor().topology).toBe('triangle-list');
        mesh.destroy();
        expect(resources[0].destroyed).toBe(true);
    });

    it('describes Uint16 indices without consulting a WebGL context', function () {
        const mesh = new VBOMesh(null, new Int16Array([0, 1, 2, 3]),
            new Uint16Array([0, 1, 2]), {
                stride: 8,
                getBufferLayout() { return { name: 'vertices', attributes: [] }; },
                getStaticAttributes() { return []; }
            }, {
                bufferFactory(options) {
                    return {
                        options,
                        get handle() { throw new Error('portable buffers must remain opaque'); },
                        destroy() {}
                    };
                }
            });

        expect(mesh.getDrawDescriptor().indexType).toBe('uint16');
        mesh.destroy();
    });

    it('uploads retained collision changes through the portable vertex buffer', function () {
        const writes = [];
        const vertex_data = new Float32Array([0, 1, 2, 3]);
        const mesh = new VBOMesh(null, vertex_data, null, {
            stride: 8,
            getBufferLayout() {
                return { name: 'vertices', attributes: [] };
            },
            getStaticAttributes() {
                return [];
            }
        }, {
            retain: true,
            bufferFactory() {
                return {
                    write(data) { writes.push(data); },
                    destroy() {}
                };
            }
        });

        vertex_data[0] = 42;
        mesh.upload();

        expect(writes).toEqual([vertex_data]);
        expect(writes[0][0]).toBe(42);
        mesh.destroy();
    });

    it('delegates a mesh draw with the active render pass before issuing raw WebGL calls', function () {
        const render_pass = {};
        const render_state = { blend: true, depthWriteEnabled: false };
        const program = {
            use_calls: 0,
            use() {
                this.use_calls++;
            }
        };
        const mesh = Object.assign(Object.create(VBOMesh.prototype), {
            created_at: +new Date(),
            fade_in_time: 0,
            valid: true
        });
        let draw_options;
        const mesh_renderer = {
            drawMesh(options) {
                draw_options = options;
                return true;
            }
        };

        expect(mesh.render({
            program,
            renderPass: render_pass,
            renderState: render_state,
            meshRenderer: mesh_renderer
        })).toBe(true);
        expect(draw_options.mesh).toBe(mesh);
        expect(draw_options.program).toBe(program);
        expect(draw_options.renderPass).toBe(render_pass);
        expect(draw_options.renderState).toBe(render_state);
        expect(draw_options.visibleTime).toEqual(expect.any(Number));
        expect(program.use_calls).toBe(0);
    });

    it('falls back to raw drawing and forces uniform block bindings when requested', function () {
        const use_options = [];
        const program = {
            use(options) {
                use_options.push(options);
            },
            uniform() {}
        };
        const draw_calls = [];
        const mesh = Object.assign(Object.create(VBOMesh.prototype), {
            created_at: +new Date(),
            fade_in_time: 0,
            valid: true,
            uniforms: null,
            toggle_element_array: false,
            draw_mode: 0x0004,
            vertex_count: 3,
            gl: {
                getExtension() {
                    return null;
                },
                drawArrays(...args) {
                    draw_calls.push(args);
                }
            },
            bind() {}
        });
        const mesh_renderer = { drawMesh: () => null };

        expect(mesh.render({ program, meshRenderer: mesh_renderer })).toBe(false);
        expect(use_options).toEqual([{ bindUniformBlocks: true }]);
        expect(draw_calls).toEqual([[0x0004, 0, 3]]);
    });

    it('routes the active render pass and mesh renderer through Scene.renderStyle', function () {
        const render_pass = {};
        const mesh_renderer = { drawMesh() {} };
        const mesh = {
            geometry_count: 2,
            variant: { blend_order: 1, mesh_order: 0 }
        };
        const tile = {
            meshes: { polygons: [mesh] },
            proxy_level: 0,
            shouldProxyForStyle() {
                return true;
            }
        };
        let render_options;
        const scene = {
            mesh_renderer,
            mesh_render_state: { blend: true, depthWriteEnabled: false },
            styles: {
                polygons: {
                    render(rendered_mesh, options) {
                        expect(rendered_mesh).toBe(mesh);
                        render_options = options;
                        return false;
                    }
                }
            },
            tile_manager: {
                getRenderableTiles() {
                    return [tile];
                }
            },
            setupStyle() {
                return {};
            },
            view: {
                setupTile() {}
            },
            requestRedraw() {}
        };

        const count = Scene.prototype.renderStyle.call(
            scene,
            'polygons',
            'program',
            1,
            null,
            render_pass
        );

        expect(count).toBe(2);
        expect(render_options).toEqual({
            renderPass: render_pass,
            meshRenderer: mesh_renderer,
            renderState: scene.mesh_render_state
        });
    });
});
