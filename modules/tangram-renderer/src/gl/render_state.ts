// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors


export class RenderState {
    value: any;
    setup: (value: any) => void;

    constructor (value: any, setup: (value: any) => void) {
        setup(value);
        this.value = value;
        this.setup = setup;
    }

    set (value: any): void {
        // if the states are different, call the GL context for a state change
        if (JSON.stringify(this.value) !== JSON.stringify(value)) {
            this.setup(value);
            this.value = value;
        }
    }

    invalidate (): void {
        this.value = null;
    }
}

export default class RenderStateManager {

    defaults: {culling: boolean; culling_face: number; blending: false; blending_src: number; blending_dst: number; blending_src_alpha: number; blending_dst_alpha: number; depth_write: boolean; depth_test: boolean};
    culling: RenderState;
    blending: RenderState;
    depth_write: RenderState;
    depth_test: RenderState;

    constructor (gl: any) {
        this.defaults = {culling: true, culling_face: gl.BACK,
            blending: false, blending_src: gl.ONE_MINUS_SRC_ALPHA, blending_dst: gl.ONE_MINUS_SRC_ALPHA,
            blending_src_alpha: gl.ONE, blending_dst_alpha: gl.ONE_MINUS_SRC_ALPHA,
            depth_write: true, depth_test: true};
        gl.depthFunc(gl.LESS); // depth function only needs to be set once

        // Culling
        this.culling = new RenderState(
            { cull: this.defaults.culling, face: this.defaults.culling_face },
            (value: any) => {
                if (value.cull) {
                    gl.enable(gl.CULL_FACE);
                    gl.cullFace(value.face);
                } else {
                    gl.disable(gl.CULL_FACE);
                }
            }
        );

        // Blending mode
        this.blending = new RenderState({
            blend: this.defaults.blending,
            src: this.defaults.blending_src,
            dst: this.defaults.blending_dst,
            src_alpha: this.defaults.blending_src_alpha,
            dst_alpha: this.defaults.blending_dst_alpha
        },
        (value: any) => {
            if (value.blend) {
                gl.enable(gl.BLEND);

                if (value.src_alpha && value.dst_alpha) {
                    gl.blendFuncSeparate(value.src, value.dst, value.src_alpha, value.dst_alpha);
                }
                else {
                    gl.blendFunc(value.src, value.dst);
                }
            } else {
                gl.disable(gl.BLEND);
            }
        }
        );

        // Depth write
        this.depth_write = new RenderState(
            { depth_write: this.defaults.depth_write },
            (value: any) => {
                gl.depthMask(value.depth_write);
            }
        );

        // Depth test
        this.depth_test = new RenderState(
            { depth_test: this.defaults.depth_test },
            (value: any) => {
                if (value.depth_test) {
                    gl.enable(gl.DEPTH_TEST);
                } else {
                    gl.disable(gl.DEPTH_TEST);
                }
            }
        );

    }

    invalidate (): void {
        this.culling.invalidate();
        this.blending.invalidate();
        this.depth_write.invalidate();
        this.depth_test.invalidate();
    }

}
