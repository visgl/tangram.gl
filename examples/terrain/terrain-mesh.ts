// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Mesh} from '@loaders.gl/schema';
import {worldToLngLat} from '@math.gl/web-mercator';
import {sampleTerrainNeighborhood, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';
import type {TerrainTileData} from './decode-terrain';
import {createTerrainQuerySurface, type LoadedTerrain} from './load-terrain';

/** Presentation walls are separate from physical top-surface sampling and picking. */
export interface TerrainRenderMesh {
    /** Reconstructed top surface and exact triangle query. */
    loaded: LoadedTerrain;
    /** Same top geometry with optional visual skirts. */
    renderMesh: Mesh;
}

/** Reconstruct pixel-center heights and shared full-resolution edges over adaptive topology. */
export function buildTerrainRenderMesh(data: TerrainTileData, neighbors: readonly TerrainHeightGrid[] = [], skirtDepth = 250): TerrainRenderMesh {
    if (!Number.isFinite(skirtDepth) || skirtDepth < 0) throw new Error('Terrain skirt depth must be non-negative meters');
    const grid = data.grid;
    const [west, south, east, north] = grid.bounds;
    const grids = [grid, ...neighbors.filter(neighbor => neighbor !== grid)];
    if (grid.registration !== 'pixel-center') throw new Error('Terrain display reconstruction requires pixel-center samples');
    if (grids.some(neighbor => neighbor.verticalDatum !== grid.verticalDatum || neighbor.registration !== grid.registration || neighbor.width !== grid.width || neighbor.height !== grid.height ||
        Math.abs((neighbor.bounds[2] - neighbor.bounds[0]) / (east - west) - 1) > 1e-8 || Math.abs((neighbor.bounds[3] - neighbor.bounds[1]) / (north - south) - 1) > 1e-8)) throw new Error('Terrain mesh neighbors require matching resolution and datum');
    const positions: number[] = [], textureCoordinates: number[] = [], normals: number[] = [], indices: number[] = [];
    const vertices = new Map<string, number>();
    const validVertices = new Set<number>();
    const scale = 512 / (2 * Math.PI * 6378137);
    /** Reuse a canonical node; local geometry is geographic, elevation stays in meters. */
    function vertex(column: number, row: number): number {
        const key = `${column},${row}`;
        const existing = vertices.get(key);
        if (existing !== undefined) return existing;
        const index = positions.length / 3;
        vertices.set(key, index);
        const x = west + column / grid.width * (east - west), y = north - row / grid.height * (north - south);
        const location = worldToLngLat([x * scale + 256, y * scale + 256]);
        const height = sampleTerrainNeighborhood(grids, [x, y]);
        if (height !== null) validVertices.add(index);
        positions.push(location[0], location[1], height ?? 0);
        textureCoordinates.push(column / grid.width, row / grid.height);
        const deltaX = (east - west) / grid.width, deltaY = (north - south) / grid.height;
        const left = sampleTerrainNeighborhood(grids, [x - deltaX, y]), right = sampleTerrainNeighborhood(grids, [x + deltaX, y]);
        const bottom = sampleTerrainNeighborhood(grids, [x, y - deltaY]), top = sampleTerrainNeighborhood(grids, [x, y + deltaY]);
        const physicalScale = Math.cos(location[1] * Math.PI / 180);
        const gradientX = left !== null && right !== null ? (right - left) / (2 * deltaX * physicalScale) : 0;
        const gradientY = bottom !== null && top !== null ? (top - bottom) / (2 * deltaY * physicalScale) : 0;
        const length = Math.hypot(gradientX, gradientY, 1);
        normals.push(-gradientX / length, -gradientY / length, 1 / length);
        return index;
    }
    /** A triangle touching invalid reconstruction nodes is omitted, not bridged. */
    function triangle(first: number, second: number, third: number): void {
        if (validVertices.has(first) && validVertices.has(second) && validVertices.has(third)) indices.push(first, second, third);
    }
    const masked = grids.some(candidate => candidate.valid.includes(0));
    if (masked) {
        // Adaptive decimation must not connect across a masked pixel in a triangle interior.
        for (let row = 0; row < grid.height; row++) for (let column = 0; column < grid.width; column++) {
            const northwest = vertex(column, row), northeast = vertex(column + 1, row), southwest = vertex(column, row + 1), southeast = vertex(column + 1, row + 1);
            if (![northwest, northeast, southwest, southeast].every(index => validVertices.has(index))) continue;
            triangle(northwest, southwest, northeast); triangle(northeast, southwest, southeast);
        }
    } else {
        const texture = data.mesh.attributes.TEXCOORD_0, sourceIndices = data.mesh.indices;
        if (!texture || texture.size !== 2 || !sourceIndices) throw new Error('Terrain mesh requires indexed UV coordinates');
        for (let offset = 0; offset < sourceIndices.value.length; offset += 3) {
            const corners = [0, 1, 2].map(index => {
                const source = sourceIndices.value[offset + index];
                return [texture.value[source * 2] * grid.width, texture.value[source * 2 + 1] * grid.height];
            });
            const ring: number[] = [];
            for (let edge = 0; edge < 3; edge++) {
                const start = corners[edge], end = corners[(edge + 1) % 3];
                ring.push(vertex(start[0], start[1]));
                const boundary = start[0] === end[0] && (start[0] === 0 || start[0] === grid.width) || start[1] === end[1] && (start[1] === 0 || start[1] === grid.height);
                if (!boundary) continue;
                const steps = Math.max(Math.abs(end[0] - start[0]), Math.abs(end[1] - start[1]));
                for (let step = 1; step < steps; step++) ring.push(vertex(start[0] + (end[0] - start[0]) * step / steps, start[1] + (end[1] - start[1]) * step / steps));
            }
            if (ring.length === 3) triangle(ring[0], ring[1], ring[2]);
            else {
                const center = vertex(corners.reduce((sum, point) => sum + point[0] / 3, 0), corners.reduce((sum, point) => sum + point[1] / 3, 0));
                for (let edge = 0; edge < ring.length; edge++) triangle(center, ring[edge], ring[(edge + 1) % ring.length]);
            }
        }
    }
    /** Materialize a detached mesh, with a truthful bounding box for its actual vertices. */
    function mesh(): Mesh {
        const heights = positions.filter((_, index) => index % 3 === 2);
        let minimum = Infinity, maximum = -Infinity;
        for (const height of heights) {minimum = Math.min(minimum, height); maximum = Math.max(maximum, height);}
        const boundingBox: [number[], number[]] = [[positions[0] ?? 0, positions[1] ?? 0, minimum], [positions[0] ?? 0, positions[1] ?? 0, maximum]];
        for (let index = 0; index < positions.length; index += 3) {
            boundingBox[0][0] = Math.min(boundingBox[0][0], positions[index]); boundingBox[0][1] = Math.min(boundingBox[0][1], positions[index + 1]);
            boundingBox[1][0] = Math.max(boundingBox[1][0], positions[index]); boundingBox[1][1] = Math.max(boundingBox[1][1], positions[index + 1]);
        }
        return {...data.mesh, attributes: {POSITION: {value: Float32Array.from(positions), size: 3}, NORMAL: {value: Float32Array.from(normals), size: 3}, TEXCOORD_0: {value: Float32Array.from(textureCoordinates), size: 2}},
            indices: {value: Uint32Array.from(indices), size: 1}, header: {vertexCount: positions.length / 3, boundingBox},
            schema: {fields: ['POSITION', 'NORMAL', 'TEXCOORD_0'].map(name => ({name, nullable: false, metadata: {}, type: {type: 'fixed-size-list', listSize: name === 'TEXCOORD_0' ? 2 : 3, children: [{name: 'value', type: 'float32'}]}})), metadata: {...data.mesh.schema.metadata, boundingBox: JSON.stringify(boundingBox)}}};
    }
    const top = mesh();
    if (skirtDepth) {
        const bottoms = new Map<number, number>();
        /** A skirt vertex is a visual wall, never part of the physical query surface. */
        function bottom(topIndex: number): number {
            const existing = bottoms.get(topIndex); if (existing !== undefined) return existing;
            const index = positions.length / 3; bottoms.set(topIndex, index);
            positions.push(positions[topIndex * 3], positions[topIndex * 3 + 1], positions[topIndex * 3 + 2] - skirtDepth);
            normals.push(normals[topIndex * 3], normals[topIndex * 3 + 1], normals[topIndex * 3 + 2]);
            textureCoordinates.push(textureCoordinates[topIndex * 2], textureCoordinates[topIndex * 2 + 1]);
            return index;
        }
        for (let edge = 0; edge < 4; edge++) {
            const length = edge % 2 ? grid.height : grid.width;
            for (let step = 0; step < length; step++) {
                const point = (offset: number) => edge === 0 ? [offset, 0] : edge === 1 ? [grid.width, offset] : edge === 2 ? [grid.width - offset, grid.height] : [0, grid.height - offset];
                const first = point(step), second = point(step + 1);
                const firstIndex = vertices.get(`${first[0]},${first[1]}`), secondIndex = vertices.get(`${second[0]},${second[1]}`);
                if (firstIndex === undefined || secondIndex === undefined || !validVertices.has(firstIndex) || !validVertices.has(secondIndex)) continue;
                const firstBottom = bottom(firstIndex), secondBottom = bottom(secondIndex);
                indices.push(firstIndex, secondIndex, firstBottom, secondIndex, secondBottom, firstBottom);
            }
        }
    }
    return {loaded: {grid, mesh: top, surface: createTerrainQuerySurface(top)}, renderMesh: skirtDepth ? mesh() : top};
}
