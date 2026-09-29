// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import Utils from '../utils/utils';
import ShaderProgram from '../gl/shader_program';
import {Matrix3, Matrix4} from '@math.gl/core';

type Matrix = Float32Array | Float64Array;
type Vector = number[] | Float32Array | Float64Array;
type CameraType = 'external' | 'isometric' | 'flat' | 'perspective';
type CameraConfiguration = {
    type?: CameraType;
    position?: number[];
    zoom?: number;
    focal_length?: number | number[][];
    fov?: number | number[][];
    vanishing_point?: number[];
    axis?: {x: number; y: number} | number[];
};
type CameraView = {
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
type Program = {uniform(type: string, name: string, value: Vector | Matrix): void};
type UniformBuffer = {setUniforms(uniforms: Record<string, Vector | Matrix>): void};
type MatrixSet = {
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

    // Create a camera by type name, factory-style
    static create(name: string, view: CameraView, config: CameraConfiguration): Camera {
        switch (config.type) {
        case 'external':
            return new ExternalCamera(name, view, config);
        case 'isometric':
            return new IsometricCamera(name, view, config);
        case 'flat':
            return new FlatCamera(name, view, config);
        case 'perspective':
            /* falls through */
        default:
            return new PerspectiveCamera(name, view, config);
        }
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

/**
    Camera whose view and projection matrices are supplied by an embedding renderer.

    This lets hosts such as deck.gl remain authoritative for camera projection while
    Tangram continues to manage scene loading, tile selection, and drawing.
*/
export class ExternalCamera extends Camera {
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

        (ShaderProgram as any).replaceBlock('camera', `
            uniform mat4 u_projection;
            uniform vec3 u_eye;
            uniform vec2 u_vanishing_point;

            void cameraProjection (inout vec4 position) {
                position = u_projection * position;
            }`
        );
    }

    setMatrices({view, projection, position = [0, 0, 0]}: {view: Matrix; projection: Matrix; position?: Vector}): boolean {
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

function matrixEquals(left: Matrix, right: Matrix): boolean {
    for (let index = 0; index < 16; index++) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function vectorEquals(left: Vector, right: Vector): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
    Perspective matrix projection

    This is a specialized perspective camera that, given a desired camera focal length (which can also vary by zoom level),
    constrains the camera height above the ground plane such that the displayed ground area of the map matches that of
    a traditional web mercator map. This means you can set the camera location by [lat, lng, zoom] as you would a typical
    web mercator map, then adjust the focal length as needed.

    Vanishing point can also be adjusted to achieve different "viewing angles", e.g. instead of looking straight down into
    the center of the viewport, the camera appears to be tilted at an angle. For example:

    [0, 0] = looking towards center of viewport
    [-250, -250] = looking 250 pixels from the viewport center to the lower-left corner
    [400, 0] = looking 400 pixels to the right of the viewport center
*/
export class PerspectiveCamera extends Camera {
    focal_length: number | number[][] | undefined;
    fov: number | number[][] | undefined;
    vanishing_point: number[];
    vanishing_point_skew: number[];

    constructor(name: string, view: CameraView, options: CameraConfiguration = {}) {
        super(name, view, options);
        this.type = 'perspective';

        // a single scalar, or pairs of stops mapping zoom levels, e.g. [zoom, focal length]
        this.focal_length = options.focal_length;
        this.fov = options.fov;
        if (!this.focal_length && !this.fov) {
            // Default focal length ranges by zoom
            this.focal_length = [[16, 2], [17, 2.5], [18, 3], [19, 4], [20, 6]];
        }

        this.vanishing_point = options.vanishing_point || [0, 0]; // [x, y]
        this.vanishing_point = this.vanishing_point.map(value => parseFloat(String(value))); // we implicitly only support px units here
        this.vanishing_point_skew = [];

        this.position_meters = [];
        this.view_matrix = new Float64Array(16);
        this.projection_matrix = new Float32Array(16);

        // 'camera' is the name of the shader block, e.g. determines where in the shader this code is injected
        (ShaderProgram as any).replaceBlock('camera', `
            uniform mat4 u_projection;
            uniform vec3 u_eye;
            uniform vec2 u_vanishing_point;

            void cameraProjection (inout vec4 position) {
                position = u_projection * position;
            }`
        );
    }

    // Constrains the camera so that the viewable area matches given the viewport height
    // (in world space, e.g. meters), given either a camera focal length or field-of-view
    // (focal length is used if both are passed).
    constrainCamera({view_height, height, focal_length, fov}: {
        view_height: number;
        height?: number;
        focal_length?: number;
        fov?: number;
    }): {view_height: number; height: number; focal_length: number; fov: number} {
        // Solve for camera height
        if (!height) {
            // We have focal length, calculate FOV
            if (focal_length) {
                fov = Math.atan(1 / focal_length) * 2;
            }
            // We have FOV, calculate focal length
            else if (fov) {
                fov = fov * Math.PI / 180; // convert FOV degrees to radians
                focal_length = 1 / Math.tan(fov / 2);
            }

            // Distance that camera should be from ground such that it fits the field of view expected
            // for a conventional web mercator map at the current zoom level and camera focal length
            height = view_height / 2 * (focal_length ?? 0);
        }
        // Solve for camera focal length / field-of-view
        else {
            focal_length = 2 * height / view_height;
            fov = Math.atan(1 / focal_length) * 2;
        }

        return {
            view_height,
            height: height as number,
            focal_length: focal_length as number,
            fov: fov as number
        };
    }

    updateMatrices(): void {
        // TODO: only re-calculate these vars when necessary

        // Height of the viewport in meters at current zoom
        var viewport_height = this.view.size.css.height * this.view.meters_per_pixel;

        // Compute camera properties to fit desired view
        var { height, fov } = this.constrainCamera({
            view_height: viewport_height,
            focal_length: Utils.interpolate(this.view.zoom, this.focal_length) as number | undefined,
            fov: Utils.interpolate(this.view.zoom, this.fov) as number | undefined
        });

        // View matrix
        var position = [this.view.center.meters.x, this.view.center.meters.y, height];
        this.position_meters = position;

        // Exclude camera height from view matrix
        this.matrix4.identity().lookAt({
            eye: [position[0], position[1], 0],
            center: [position[0], position[1], -1],
            up: [0, 1, 0]
        }).toArray(this.view_matrix);

        // Projection matrix
        this.matrix4.identity().perspective({fovy: fov, aspect: this.view.aspect, near: 1, far: height * 2})
            .toArray(this.projection_matrix);

        // Convert vanishing point from pixels to viewport space
        this.vanishing_point_skew[0] = this.vanishing_point[0] / this.view.size.css.width;
        this.vanishing_point_skew[1] = this.vanishing_point[1] / this.view.size.css.height;

        // Adjust projection matrix to include vanishing point skew
        this.projection_matrix[8] = -this.vanishing_point_skew[0] * 2; // z column of x row, e.g. amount z skews x
        this.projection_matrix[9] = -this.vanishing_point_skew[1] * 2; // z column of y row, e.g. amount z skews y

        // Translate geometry into the distance so that camera is appropriate height above ground
        // Additionally, adjust xy to compensate for any vanishing point skew, e.g. move geometry so that the displayed g
        // plane of the map matches that expected by a traditional web mercator map at this [lat, lng, zoom].
        this.matrix4.copy(this.projection_matrix).translate(
            [
                viewport_height/2 * this.view.aspect * (-this.vanishing_point_skew[0] * 2),
                viewport_height/2 * (-this.vanishing_point_skew[1] * 2),
                0
            ]
        ).toArray(this.projection_matrix);

        // Include camera height in projection matrix
        this.matrix4.copy(this.projection_matrix).translate([0, 0, -height]).toArray(this.projection_matrix);
    }

    update(): void {
        super.update();
        this.updateMatrices();
    }

    setupProgram(program: Program, uniform_buffer?: UniformBuffer): void {
        if (uniform_buffer) {
            uniform_buffer.setUniforms({
                u_projection: this.projection_matrix,
                u_eye: [0, 0, this.position_meters[2]],
                u_vanishing_point: this.vanishing_point_skew
            });
        }
        else {
            program.uniform('Matrix4fv', 'u_projection', this.projection_matrix);
            program.uniform('3f', 'u_eye', [0, 0, this.position_meters[2]]);
            program.uniform('2fv', 'u_vanishing_point', this.vanishing_point_skew);
        }
    }

}

// Isometric-style projection
// Note: this is actually an "axonometric" projection, but I'm using the colloquial term isometric because it is more recognizable.
// An isometric projection is a specific subset of axonometric projections.
// 'axis' determines the xy skew applied to a vertex based on its z coordinate, e.g. [0, 1] axis causes buildings to be drawn
// straight upwards on screen at their true height, [0, .5] would draw them up at half-height, [1, 0] would be sideways, etc.
export class IsometricCamera extends Camera {
    axis: {x: number; y: number};
    viewport_height: number | null;

    constructor(name: string, view: CameraView, options: CameraConfiguration = {}) {
        super(name, view, options);
        this.type = 'isometric';
        const axis = options.axis;
        this.axis = Array.isArray(axis)
            ? {x: axis[0], y: axis[1]}
            : axis || {x: 0, y: 1};

        this.position_meters = [];
        this.viewport_height = null;

        this.view_matrix = new Float64Array(16);
        this.projection_matrix = new Float32Array(16);

        // 'camera' is the name of the shader block, e.g. determines where in the shader this code is injected
        (ShaderProgram as any).replaceBlock('camera', `
            uniform mat4 u_projection;
            uniform vec3 u_eye;
            uniform vec2 u_vanishing_point;

            void cameraProjection (inout vec4 position) {
                position = u_projection * position;
                // position.xy += position.z * u_isometric_axis;

                // Reverse z for depth buffer so up is negative,
                // and scale down values so objects higher than one screen height will not get clipped
                // pull forward slightly to avoid going past far clipping plane
                position.z = -position.z / 100. + 1. - 0.001;
            }`
        );
    }

    update(): void {
        super.update();

        this.viewport_height = this.view.size.css.height * this.view.meters_per_pixel;
        var position = [this.view.center.meters.x, this.view.center.meters.y, this.viewport_height];
        this.position_meters = position;

        // View
        this.matrix4.identity().translate([-position[0], -position[1], 0]).toArray(this.view_matrix);

        // Projection
        this.matrix4.identity().toArray(this.projection_matrix);

        // apply isometric skew
        this.projection_matrix[8] = this.axis.x / this.view.aspect; // z column of x row, e.g. amount z skews x
        this.projection_matrix[9] = this.axis.y;                    // z column of x row, e.g. amount z skews y

        // convert meters to viewport
        this.matrix4.copy(this.projection_matrix).scale(
            [
                2 / this.view.size.meters.x,
                2 / this.view.size.meters.y,
                2 / this.view.size.meters.y
            ]
        ).toArray(this.projection_matrix);
    }

    setupProgram(program: Program, uniform_buffer?: UniformBuffer): void {
        if (uniform_buffer) {
            uniform_buffer.setUniforms({
                u_projection: this.projection_matrix,
                u_eye: [0, 0, this.viewport_height ?? 0],
                u_vanishing_point: [0, 0]
            });
        }
        else {
            program.uniform('Matrix4fv', 'u_projection', this.projection_matrix);
            program.uniform('3fv', 'u_eye', [0, 0, this.viewport_height ?? 0]);
            // program.uniform('3f', 'u_eye', this.viewport_height * this.axis.x, this.viewport_height * this.axis.y, this.viewport_height);
            program.uniform('2fv', 'u_vanishing_point', [0, 0]);
        }
    }

}

// Flat projection (e.g. just top-down, no perspective) - a degenerate isometric camera
export class FlatCamera extends IsometricCamera {

    constructor(name: string, view: CameraView, options: CameraConfiguration = {}) {
        super(name, view, options);
        this.type = 'flat';
    }

    update(): void {
        // Axis is fixed to (0, 0) for flat camera
        this.axis.x = 0;
        this.axis.y = 0;

        super.update();
    }

}
