// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Viewport, WebMercatorViewport, FirstPersonViewport} from '@deck.gl/core';
import type {Mesh} from '@loaders.gl/schema';
import {pixelsToWorld} from '@math.gl/web-mercator';
import {TriangleQueryIndex} from '@vis.gl/tangram-renderer/map-logic';

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

/** Owned immutable top-surface query cache; camera matrices do not rebuild common geometry. */
export class TerrainScreenQuery {
    /** Detached geographic vertex and index snapshots, excluding visual skirts. */
    private readonly positions: Float64Array;
    private readonly indices: Uint32Array;
    /** Only one common-space index is retained per tile. */
    private index?: TriangleQueryIndex;
    /** Public projection probes distinguish standard and legacy pseudo-meter height scales. */
    private projectionSignature = '';
    /** Work performed by the last ray, for example diagnostics rather than timing assertions. */
    private testedTriangles = 0;
    /** Number of common-space geometry builds; ordinary pan/zoom should reuse the index. */
    private builds = 0;

    /** Copy the same physical top triangles supplied to rendering. */
    constructor(mesh: Mesh) {
        const positions = mesh.attributes.POSITION, indices = mesh.indices;
        if (!positions || positions.size !== 3 || !indices || mesh.topology !== 'triangle-list') throw new Error('Terrain query requires indexed XYZ top triangles');
        if (positions.value.length % 3 || !positions.value.every(Number.isFinite) || indices.value.length % 3 || !indices.value.every(index => Number.isSafeInteger(index) && index >= 0 && index < positions.value.length / 3)) throw new Error('Terrain query requires finite positions and in-range indices');
        this.positions = Float64Array.from(positions.value); this.indices = Uint32Array.from(indices.value);
    }

    /** Detached counts for checking query acceleration and projection-cache ownership. */
    getStatistics(): {builds: number; testedTriangles: number} {return {builds: this.builds, testedTriangles: this.testedTriangles};}

    /** Intersect a finite Map/FirstPerson canvas CSS-pixel ray, including viewport offsets. */
    pick(viewport: unknown, pixel: readonly [number, number]): TerrainScreenHit | null {
    this.testedTriangles = 0;
    if (!(viewport instanceof Viewport) || !(viewport instanceof WebMercatorViewport || viewport instanceof FirstPersonViewport) || !viewport.isGeospatial || !pixel.every(Number.isFinite)) return null;
    const horizontal = pixel[0] - viewport.x, vertical = pixel[1] - viewport.y;
    if (horizontal < 0 || vertical < 0 || horizontal >= viewport.width || vertical >= viewport.height) return null;
    // Geographic unproject() varies endpoint Z by latitude: keep this ray straight in common space.
    const near = pixelsToWorld([horizontal, vertical, -1], viewport.pixelUnprojectionMatrix);
    const far = pixelsToWorld([horizontal, vertical, 1], viewport.pixelUnprojectionMatrix);
    if (!near.every(Number.isFinite) || !far.every(Number.isFinite)) return null;
    const origin: [number, number, number] = [near[0], near[1], near[2]];
    const direction: [number, number, number] = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
    // XY is Mercator in both accepted views. MapView's physical/legacy modes
    // and FirstPerson's anchor-meter scale have different height mappings.
    // Public probes detect the convention and its current scale.
    const signature = [-60, 0, 60].flatMap(latitude => viewport.projectPosition([0, latitude, 1])).join(',');
    if (!this.index || signature !== this.projectionSignature) {
        const positions = new Float64Array(this.positions.length);
        for (let index = 0; index < positions.length; index += 3) positions.set(viewport.projectPosition([this.positions[index], this.positions[index + 1], this.positions[index + 2]]), index);
        this.index = new TriangleQueryIndex(positions, this.indices);
        this.projectionSignature = signature; this.builds++;
    }
    const result = this.index.queryRay(origin, direction, 1);
    this.testedTriangles = result.testedTriangles;
    const hit = result.hit;
    if (!hit) return null;
    const location = viewport.unprojectFlat([near[0] + direction[0] * hit.parameter, near[1] + direction[1] * hit.parameter]);
    const vertices = [this.indices[hit.triangleIndex * 3], this.indices[hit.triangleIndex * 3 + 1], this.indices[hit.triangleIndex * 3 + 2]];
    const altitude = vertices.reduce((sum, vertex, offset) => sum + this.positions[vertex * 3 + 2] * hit.barycentric[offset], 0);
    return {coordinate: [location[0], location[1], altitude], triangleIndex: hit.triangleIndex, barycentric: hit.barycentric, rayParameter: hit.parameter};
    }
}

/** One-off conformance helper; mounted examples retain TerrainScreenQuery per immutable mesh. */
export function pickTerrainSurface(viewport: unknown, mesh: Mesh, pixel: readonly [number, number]): TerrainScreenHit | null {
    if (!mesh.attributes.POSITION || mesh.attributes.POSITION.size !== 3 || !mesh.indices || mesh.topology !== 'triangle-list') return null;
    return new TerrainScreenQuery(mesh).pick(viewport, pixel);
}
