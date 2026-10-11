// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {WebMercatorViewport} from '@deck.gl/core';
import type {Mesh} from '@loaders.gl/schema';
import {pixelsToWorld} from '@math.gl/web-mercator';
import {intersectRayTriangle} from '@math.gl/culling/queries';

/** Screen hit on the loaded triangles, with physical elevation rather than common units. */
export interface TerrainScreenHit {
    /** Longitude, latitude and unexaggerated elevation meters. */
    coordinate: [number, number, number];
    /** Offset of the hit triangle in the original index list. */
    triangleIndex: number;
    /** Weights in the original triangle's vertex order. */
    barycentric: [number, number, number];
    /** Normalized near-to-far ray parameter, comparable across tiles in one view. */
    rayParameter: number;
}

/** Intersect the loaded triangles projected by the active MapView, using CSS pixels. */
export function pickTerrainSurface(viewport: unknown, mesh: Mesh, pixel: readonly [number, number]): TerrainScreenHit | null {
    if (!(viewport instanceof WebMercatorViewport) || !pixel.every(Number.isFinite) || pixel[0] < 0 || pixel[1] < 0 || pixel[0] > viewport.width || pixel[1] > viewport.height) return null;
    const source = mesh.attributes.POSITION, indices = mesh.indices;
    if (!source || source.size !== 3 || !indices || mesh.topology !== 'triangle-list') return null;
    // Geographic unproject() varies endpoint Z by latitude: keep this ray straight in common space.
    const near = pixelsToWorld([pixel[0], pixel[1], -1], viewport.pixelUnprojectionMatrix);
    const far = pixelsToWorld([pixel[0], pixel[1], 1], viewport.pixelUnprojectionMatrix);
    if (!near.every(Number.isFinite) || !far.every(Number.isFinite)) return null;
    const origin: [number, number, number] = [near[0], near[1], near[2]];
    const direction: [number, number, number] = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
    const positions: [number, number, number][] = [];
    for (let index = 0; index < source.value.length; index += 3) {
        const point = viewport.projectPosition([source.value[index], source.value[index + 1], source.value[index + 2]]);
        positions.push([point[0], point[1], point[2]]);
    }
    let nearest = 1;
    let result: TerrainScreenHit | null = null;
    for (let index = 0; index < indices.value.length; index += 3) {
        const vertices = [indices.value[index], indices.value[index + 1], indices.value[index + 2]];
        const hit = intersectRayTriangle(origin, direction, positions[vertices[0]], positions[vertices[1]], positions[vertices[2]], {maxT: nearest});
        if (!hit) continue;
        nearest = hit.t;
        const location = viewport.unprojectFlat([near[0] + direction[0] * hit.t, near[1] + direction[1] * hit.t]);
        const altitude = vertices.reduce((sum, vertex, offset) => sum + source.value[vertex * 3 + 2] * hit.barycentric[offset], 0);
        result = {coordinate: [location[0], location[1], altitude], triangleIndex: index / 3, barycentric: hit.barycentric, rayParameter: hit.t};
    }
    return result;
}
