// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {describe, expect, it, vi} from 'vitest';
import {Matrix4} from '@math.gl/core';

import ExternalCamera from '../src/scene/external_camera';
import Camera, {
    FlatCamera,
    IsometricCamera,
    PerspectiveCamera
} from '../src/scene/camera';

function createView(): any {
    return {
        setView: vi.fn(),
        scene: {requestRedraw: vi.fn()},
        size: {
            css: {width: 800, height: 600},
            meters: {x: 800, y: 600}
        },
        aspect: 4 / 3,
        meters_per_pixel: 1,
        zoom: 16,
        center: {meters: {x: 10, y: 20}}
    };
}

function createMatrix(value: number): any {
    return new Float32Array(16).fill(value);
}

describe('Camera', () => {
    it('selects camera implementations through the factory', () => {
        const view = createView();
        expect(Camera.create('external', view, {type: 'external'})).toBeInstanceOf(ExternalCamera);
        expect(Camera.create('isometric', view, {type: 'isometric'})).toBeInstanceOf(IsometricCamera);
        expect(Camera.create('flat', view, {type: 'flat'})).toBeInstanceOf(FlatCamera);
        expect(Camera.create('perspective', view, {type: 'perspective', focal_length: 2})).toBeInstanceOf(PerspectiveCamera);
        expect(Camera.create('default', view, {})).toBeInstanceOf(PerspectiveCamera);
    });

    it('syncs configured position and zoom to the view', () => {
        const view = createView();
        const camera = new Camera('base', view, {position: [-74, 40, 12], zoom: 14});
        camera.updateView();
        expect(view.setView).toHaveBeenCalledWith({lng: -74, lat: 40, zoom: 14});

        const zoomOnlyCamera = new Camera('zoom', view, {zoom: 8});
        zoomOnlyCamera.updateView();
        expect(view.setView).toHaveBeenLastCalledWith({zoom: 8});
    });

    it('updates perspective matrices and routes uniforms', () => {
        const view = createView();
        const camera = new PerspectiveCamera('perspective', view, {focal_length: 2});
        camera.update();
        expect(camera.position_meters).toHaveLength(3);
        expect(camera.view_matrix).toBeInstanceOf(Float64Array);
        expect(camera.projection_matrix).toBeInstanceOf(Float32Array);

        const program = {uniform: vi.fn()};
        camera.setupProgram(program);
        expect(program.uniform).toHaveBeenCalledWith('Matrix4fv', 'u_projection', camera.projection_matrix);
        expect(program.uniform).toHaveBeenCalledWith('3f', 'u_eye', expect.any(Array));

        const uniformBuffer = {setUniforms: vi.fn()};
        camera.setupProgram(program, uniformBuffer);
        expect(uniformBuffer.setUniforms).toHaveBeenCalledWith(expect.objectContaining({u_projection: camera.projection_matrix}));
    });

    it('updates isometric and flat projections', () => {
        const view = createView();
        const isometric = new IsometricCamera('isometric', view, {axis: [1, 0.5]});
        isometric.update();
        expect(isometric.axis).toEqual({x: 1, y: 0.5});
        expect(isometric.viewport_height).toBe(600);

        const flat = new FlatCamera('flat', view, {});
        flat.update();
        expect(flat.axis).toEqual({x: 0, y: 0});
        expect(flat.projection_matrix).toBeInstanceOf(Float32Array);
    });

    it('uses math.gl transforms for model-view and normal matrices', () => {
        const view = createView();
        const camera = new Camera('matrix-test', view);
        new Matrix4().identity().toArray(camera.view_matrix);
        const model = new Matrix4().scale([2, 4, 8]).toArray(new Float64Array(16));
        const matrices = {
            model,
            model_view32: new Float64Array(16),
            normal32: new Float64Array(9),
            inverse_normal32: new Float64Array(9)
        };

        camera.setupMatrices(matrices, {uniform: vi.fn()});

        expect(matrices.model_view32[0]).toBe(2);
        expect(matrices.model_view32[5]).toBe(4);
        expect(matrices.model_view32[10]).toBe(8);
        expect(matrices.normal32[0]).toBe(0.5);
        expect(matrices.normal32[4]).toBe(0.25);
        expect(matrices.normal32[8]).toBe(0.125);
        expect(matrices.inverse_normal32[0]).toBe(2);
        expect(matrices.inverse_normal32[4]).toBe(4);
        expect(matrices.inverse_normal32[8]).toBe(8);
    });

    it('accepts external frames, avoids redundant redraws, and transforms vectors', () => {
        const view = createView();
        const camera = new ExternalCamera('external', view);
        const frame = {view: createMatrix(1), projection: createMatrix(2), position: [1, 2, 3]};
        expect(camera.setMatrices(frame)).toBe(true);
        expect(view.scene.requestRedraw).toHaveBeenCalledTimes(1);
        expect(camera.setMatrices(frame)).toBe(false);
        expect(view.scene.requestRedraw).toHaveBeenCalledTimes(1);
        expect(camera.transformVector([1, 0, 0])).toHaveLength(3);
        expect(() => camera.setMatrices({view: [1] as any, projection: [2] as any})).toThrow('4x4');

        const program = {uniform: vi.fn()};
        camera.setupProgram(program);
        expect(program.uniform).toHaveBeenCalledWith('3fv', 'u_eye', camera.position_meters);
    });
});
