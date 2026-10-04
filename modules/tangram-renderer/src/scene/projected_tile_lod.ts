// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Matrix4} from '@math.gl/core';
import Geo, {type Bounds} from '../utils/geo';
import type {HostCamera, HostProjection, Viewport} from '../types';
import type HostFrame from './host_frame';
import {getProjectionSurface} from './projection_math';

/** One eye's surface footprint and projection, independent of the embedding library. */
export interface ProjectedLODEye {
    /** Matrices in the renderer's planar/globe host convention. */
    readonly camera: HostCamera;
    /** Geographic projection of the surface. */
    readonly projection: HostProjection;
    /** Eye viewport in CSS pixels. */
    readonly viewport: Required<Viewport>;
    /** Unwrapped Mercator-meter footprint, or null when no surface is visible. */
    readonly bounds: Bounds | null;
}

/** Stateful, opt-in uniform surface-scale LOD; never changes scene/style zoom. */
export default class ProjectedTileLOD {
    private previousZoom?: number;
    private policyKey = '';

    /** Selects one level for every eye before allocating candidates or installing a frame. */
    select(frame: HostFrame, eyes: readonly ProjectedLODEye[], countCandidates: (zoom: number) => number): number | undefined {
        const options = frame.tileLOD;
        if (!options) {
            this.previousZoom = undefined;
            this.policyKey = '';
            return frame.tileZoom;
        }
        const key = JSON.stringify([options, frame.projection.type]);
        const maximumZoom = Math.min(22, Math.max(0, Math.floor(frame.geographicAnchor.zoom)));
        let scale = 0;
        for (const eye of eyes) {
            scale = Math.max(scale, getProjectedScale(eye, options.pixelRatio));
        }
        // Missing visible samples are not evidence that coarse data is sufficient.
        const desiredZoom = scale > 0
            ? Math.log2(Geo.circumference_meters * scale / options.targetTilePixels)
            : maximumZoom;
        let zoom = Math.min(maximumZoom, Math.max(0, Math.ceil(desiredZoom)));
        const previous = key === this.policyKey ? this.previousZoom : undefined;
        if (previous !== undefined && previous <= maximumZoom &&
            desiredZoom >= previous - 1 - options.hysteresis && desiredZoom <= previous + options.hysteresis) {
            zoom = previous;
        }
        for (;;) {
            const count = countCandidates(zoom);
            if (!Number.isFinite(count) || count < 0) {
                throw new Error('Automatic tile LOD requires a finite non-negative candidate count');
            }
            if (count <= options.maxTiles) break;
            if (zoom === 0) {
                throw new Error('HostFrame tileLOD maxTiles cannot fit the buffered eye footprints, even at zoom 0');
            }
            zoom--;
        }
        // Failed budget checks must not affect the next successful frame's hysteresis.
        this.previousZoom = zoom;
        this.policyKey = key;
        return zoom;
    }
}

/** Estimates the strongest local surface magnification at a deterministic 3x3 footprint grid. */
function getProjectedScale(eye: ProjectedLODEye, pixelRatio: number): number {
    if (!eye.bounds) return 0;
    const matrix = new Matrix4().copy(eye.camera.projection);
    if (eye.projection.type === 'web-mercator') matrix.multiplyRight(eye.camera.view);
    const {sw, ne} = eye.bounds;
    let scale = 0;
    for (const horizontal of [0, 0.5, 1]) {
        for (const vertical of [0, 0.5, 1]) {
            const x = sw.x + (ne.x - sw.x) * horizontal;
            const y = sw.y + (ne.y - sw.y) * vertical;
            const surface = getSurface(x, y, eye.projection);
            const clip = transform(matrix, surface.position, 1);
            if (!clip.every(Number.isFinite) || clip[3] <= 0 ||
                Math.abs(clip[0]) > clip[3] * 1.001 || Math.abs(clip[1]) > clip[3] * 1.001 ||
                Math.abs(clip[2]) > clip[3] * 1.001) continue;
            const derivativeX = transform(matrix, surface.derivativeX, 0);
            const derivativeY = transform(matrix, surface.derivativeY, 0);
            const width = eye.viewport.width * pixelRatio / 2;
            const height = eye.viewport.height * pixelRatio / 2;
            const horizontalX = projectedDerivative(clip, derivativeX, 0) * width;
            const horizontalY = projectedDerivative(clip, derivativeY, 0) * width;
            const verticalX = projectedDerivative(clip, derivativeX, 1) * height;
            const verticalY = projectedDerivative(clip, derivativeY, 1) * height;
            const diagonalX = horizontalX ** 2 + verticalX ** 2;
            const diagonalY = horizontalY ** 2 + verticalY ** 2;
            const offDiagonal = horizontalX * horizontalY + verticalX * verticalY;
            const largestEigenvalue = (diagonalX + diagonalY +
                Math.hypot(diagonalX - diagonalY, 2 * offDiagonal)) / 2;
            const candidate = Math.sqrt(largestEigenvalue);
            if (Number.isFinite(candidate)) scale = Math.max(scale, candidate);
        }
    }
    return scale;
}

/** Differential of normalized-device coordinates, including perspective division. */
function projectedDerivative(clip: number[], derivative: number[], axis: number): number {
    return (derivative[axis] * clip[3] - clip[axis] * derivative[3]) / (clip[3] ** 2);
}

/** Column-major homogeneous transform; derivatives use w=0, positions use w=1. */
function transform(matrix: ArrayLike<number>, vector: number[], homogeneous: number): number[] {
    return [0, 1, 2, 3].map(row => matrix[row] * vector[0] + matrix[row + 4] * vector[1] +
        matrix[row + 8] * vector[2] + matrix[row + 12] * homogeneous);
}

/** Surface position and derivatives per EPSG:3857 meter, matching the globe shaders. */
function getSurface(x: number, y: number, projection: HostProjection): {
    position: number[]; derivativeX: number[]; derivativeY: number[];
} {
    if (projection.type === 'web-mercator') {
        return {position: [x, y, 0], derivativeX: [1, 0, 0], derivativeY: [0, 1, 0]};
    }
    return getProjectionSurface(x, y, projection.type);
}
