// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {Matrix3, Matrix4} from '@math.gl/core';

export type Matrix = Float32Array | Float64Array;
export type Vector = number[] | Float32Array | Float64Array;
export type CameraType = 'external' | 'isometric' | 'flat' | 'perspective';
export type CameraConfiguration = {
    type?: CameraType;
    position?: number[];
    zoom?: number;
    focal_length?: number | number[][];
    fov?: number | number[][];
    vanishing_point?: number[];
    axis?: {x: number; y: number} | number[];
};
export type CameraView = {
    setView(view: {lng?: number; lat?: number; zoom?: number}): void;
    scene: {requestRedraw(): void};
    size: {
        css: {width: number; height: number};
        meters: {x: number; y: number};
    };
    aspect: number;
    meters_per_pixel: number;
    zoom: number;
    center: {meters: {x: number; y: number}};
};
export type Program = {uniform(type: string, name: string, value: Vector | Matrix): void};
export type UniformBuffer = {setUniforms(uniforms: Record<string, Vector | Matrix | number | boolean>): void};
export type MatrixSet = {
    model_view32: Matrix;
    model: Matrix;
    normal32: Matrix;
    inverse_normal32: Matrix;
};

// Abstract base class
export default class Camera {
    readonly view: CameraView;
    readonly position?: number[];
    readonly zoom?: number;
    private readonly matrix3 = new Matrix3();
    protected readonly matrix4 = new Matrix4();
    type?: CameraType;
    view_matrix: Matrix = new Float64Array(16);
    projection_matrix: Matrix = new Float32Array(16);
    position_meters: Vector = [0, 0, 0];

    constructor(name: string, view: CameraView, options: CameraConfiguration = {}) {
        this.view = view;
        this.position = options.position;
        this.zoom = options.zoom;
    }

    // Update method called once per frame
    update(): void {
    }

    // Called once per frame per program (e.g. for main render pass, then for each additional pass for feature selection, etc.)
    setupProgram(/*program*/ _program?: Program, _uniformBuffer?: UniformBuffer): void {
    }

    // Sync camera position/zoom to scene view
    updateView (): void {
        if (this.position || this.zoom) {
            let view: {lng?: number; lat?: number; zoom?: number} = {};
            if (this.position) {
                view = { lng: this.position[0], lat: this.position[1], zoom: this.position[2] };
            }
            if (this.zoom) {
                view.zoom = this.zoom;
            }
            this.view.setView(view);
        }
    }

    // Set model-view and normal matrices
    setupMatrices (matrices: MatrixSet, program: Program, uniform_buffer?: UniformBuffer): void {
        // Model view matrix - transform tile space into view space (meters, relative to camera)
        this.matrix4.copy(this.view_matrix).multiplyRight(matrices.model).toArray(matrices.model_view32);

        // Normal matrices - transforms surface normals into view space
        const normal_matrix = this.matrix3.set(
            matrices.model_view32[0], matrices.model_view32[1], matrices.model_view32[2],
            matrices.model_view32[4], matrices.model_view32[5], matrices.model_view32[6],
            matrices.model_view32[8], matrices.model_view32[9], matrices.model_view32[10]
        );
        if (normal_matrix.determinant() !== 0) {
            normal_matrix.invert().transpose().toArray(matrices.normal32);
            normal_matrix.copy(matrices.normal32);
            if (normal_matrix.determinant() !== 0) {
                normal_matrix.invert().toArray(matrices.inverse_normal32);
            }
        }
        if (uniform_buffer) {
            uniform_buffer.setUniforms({
                u_modelView: matrices.model_view32,
                u_normalMatrix: matrices.normal32,
                u_inverseNormalMatrix: matrices.inverse_normal32
            });
        }
        else {
            program.uniform('Matrix4fv', 'u_modelView', matrices.model_view32);
            program.uniform('Matrix3fv', 'u_normalMatrix', matrices.normal32);
            program.uniform('Matrix3fv', 'u_inverseNormalMatrix', matrices.inverse_normal32);
        }
    }

}
