// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import ShaderProgram from '../gl/shader_program';
import Camera, {type CameraView, type CameraConfiguration, type Matrix, type Vector, type Program, type UniformBuffer} from './camera_base';
import type {Matrix4 as HostMatrix} from '../types';

/**
    Camera whose view and projection matrices are supplied by an embedding renderer.

    This lets hosts such as deck.gl remain authoritative for camera projection while
    Tangram continues to manage scene loading, tile selection, and drawing.
*/
export default class ExternalCamera extends Camera {
    readonly vanishing_point: number[];

    constructor(name: string, view: CameraView, options: CameraConfiguration = {}) {
        super(name, view, options);
        this.type = 'external';
        this.position_meters = [0, 0, 0];
        this.vanishing_point = [0, 0];
        this.view_matrix = new Float64Array(16);
        this.projection_matrix = new Float32Array(16);
        this.matrix4.identity().toArray(this.view_matrix);
        this.matrix4.identity().toArray(this.projection_matrix);

        ShaderProgram.replaceBlock('camera', `
            uniform mat4 u_projection;
            uniform vec3 u_eye;
            uniform vec2 u_vanishing_point;

            void cameraProjection (inout vec4 position) {
                position = u_projection * position;
            }`
        );
    }

    setMatrices({view, projection, position = [0, 0, 0]}: {view: HostMatrix; projection: HostMatrix; position?: ArrayLike<number>}): boolean {
        if (!view || view.length !== 16 || !projection || projection.length !== 16) {
            throw new Error('ExternalCamera requires 4x4 view and projection matrices');
        }
        const changed = !matrixEquals(this.view_matrix, view) ||
            !matrixEquals(this.projection_matrix, projection) ||
            !vectorEquals(this.position_meters, position);
        if (!changed) {
            return false;
        }
        this.view_matrix.set(view);
        this.projection_matrix.set(projection);
        this.position_meters = Array.from(position);
        this.view.scene.requestRedraw();
        return true;
    }

    setupProgram(program: Program, uniform_buffer?: UniformBuffer): void {
        if (uniform_buffer) {
            uniform_buffer.setUniforms({
                u_projection: this.projection_matrix,
                u_eye: this.position_meters,
                u_vanishing_point: this.vanishing_point
            });
        }
        else {
            program.uniform('Matrix4fv', 'u_projection', this.projection_matrix);
            program.uniform('3fv', 'u_eye', this.position_meters);
            program.uniform('2fv', 'u_vanishing_point', this.vanishing_point);
        }
    }

    transformVector(vector: Vector): number[] {
        const matrix = this.view_matrix;
        const transformed = [
            matrix[0] * vector[0] + matrix[4] * vector[1] + matrix[8] * vector[2],
            matrix[1] * vector[0] + matrix[5] * vector[1] + matrix[9] * vector[2],
            matrix[2] * vector[0] + matrix[6] * vector[1] + matrix[10] * vector[2]
        ];
        const length = Math.hypot(...transformed);
        return length === 0 ? transformed : transformed.map(value => value / length);
    }

}

function matrixEquals(left: Matrix, right: ArrayLike<number>): boolean {
    for (let index = 0; index < 16; index++) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function vectorEquals(left: Vector, right: ArrayLike<number>): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
