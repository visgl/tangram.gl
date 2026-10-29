// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Mesh} from '@loaders.gl/schema';
import {worldToLngLat} from '@math.gl/web-mercator';
import {sampleTerrainNeighborhood, type TerrainHeightGrid} from '@tangram.gl/tangram-renderer/map-logic';
import type {TerrainTileData} from './terrain-payload';
import {createTerrainQuerySurface, type LoadedTerrain} from './load-terrain';

/** Presentation walls are separate from physical top-surface sampling and picking. */
export interface TerrainRenderMesh {
    /** Reconstructed top surface and exact triangle query. */
    loaded: LoadedTerrain;
    /** Same top geometry with optional visual skirts. */
    renderMesh: Mesh;
}

/** Estimate a physical slope without flattening a boundary that has one valid side. */
function estimateTerrainSlope(negative: number | null, positive: number | null, center: number | null, distance: number): number {
    if (negative !== null && positive !== null) return (positive - negative) / (2 * distance);
    if (center === null) return 0;
    if (positive !== null) return (positive - center) / distance;
    return negative === null ? 0 : (center - negative) / distance;
}

/** Adjacent Mercator footprints include corner neighbors but never overlapping parents. */
export function terrainGridsTouch(first: TerrainHeightGrid, second: TerrainHeightGrid): boolean {
    const tolerance = Math.max(first.bounds[2] - first.bounds[0], second.bounds[2] - second.bounds[0]) * 1e-10;
    const width = Math.min(first.bounds[2], second.bounds[2]) - Math.max(first.bounds[0], second.bounds[0]);
    const height = Math.min(first.bounds[3], second.bounds[3]) - Math.max(first.bounds[1], second.bounds[1]);
    return width >= -tolerance && height >= -tolerance && (width <= tolerance || height <= tolerance);
}

/** Reconstruct pixel-center heights and shared full-resolution edges over adaptive topology. */
export function buildTerrainRenderMesh(data: TerrainTileData, neighbors: readonly TerrainHeightGrid[] = [], skirtDepth = 250): TerrainRenderMesh {
    if (!Number.isFinite(skirtDepth) || skirtDepth < 0) throw new Error('Terrain skirt depth must be non-negative meters');
    const grid = data.grid;
    const [west, south, east, north] = grid.bounds;
    const grids = [...new Set([grid, ...neighbors])].sort((first, second) => first.bounds[1] - second.bounds[1] || first.bounds[0] - second.bounds[0] || first.bounds[2] - second.bounds[2]);
    if (grid.registration !== 'pixel-center') throw new Error('Terrain display reconstruction requires pixel-center samples');
    if (grids.some(neighbor => {
        const horizontalRatio = (neighbor.bounds[2] - neighbor.bounds[0]) / (east - west);
        const verticalRatio = (neighbor.bounds[3] - neighbor.bounds[1]) / (north - south);
        return neighbor.verticalDatum !== grid.verticalDatum || neighbor.registration !== grid.registration || neighbor.width !== grid.width || neighbor.height !== grid.height ||
            ![0.5, 1, 2].some(ratio => Math.abs(horizontalRatio - ratio) < 1e-8 && Math.abs(verticalRatio - ratio) < 1e-8) || neighbor !== grid && !terrainGridsTouch(grid, neighbor);
    })) throw new Error('Terrain mesh neighbors require touching 2:1 footprints, matching sample dimensions and datum');
    /** Union edge nodes, including finer half-steps on coarse fallback boundaries. */
    function boundaryNodes(start: readonly number[], end: readonly number[]): number[][] {
        const vertical = start[0] === end[0];
        const boundary = vertical && (start[0] === 0 || start[0] === grid.width) || start[1] === end[1] && (start[1] === 0 || start[1] === grid.height);
        if (!boundary) return [];
        const axis = vertical ? 1 : 0;
        const values = new Set<number>();
        const fixed = vertical ? west + start[0] / grid.width * (east - west) : north - start[1] / grid.height * (north - south);
        for (const candidate of grids) {
            const bounds = candidate.bounds;
            const tolerance = Math.max(east - west, north - south) * 1e-10;
            if (vertical ? Math.min(Math.abs(fixed - bounds[0]), Math.abs(fixed - bounds[2])) > tolerance : Math.min(Math.abs(fixed - bounds[1]), Math.abs(fixed - bounds[3])) > tolerance) continue;
            const count = vertical ? candidate.height : candidate.width;
            for (let step = 0; step <= count; step++) {
                const value = vertical ? (north - (bounds[3] - step / count * (bounds[3] - bounds[1]))) / (north - south) * grid.height : (bounds[0] + step / count * (bounds[2] - bounds[0]) - west) / (east - west) * grid.width;
                if (value > Math.min(start[axis], end[axis]) + 1e-8 && value < Math.max(start[axis], end[axis]) - 1e-8) values.add(Math.round(value * 1e8) / 1e8);
            }
        }
        return [...values].sort((first, second) => (first - second) * Math.sign(end[axis] - start[axis])).map(value => vertical ? [start[0], value] : [value, start[1]]);
    }
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
        const touching = grids.filter(candidate => {
            const tolerance = Math.max(east - west, north - south) * 1e-10;
            return x >= candidate.bounds[0] - tolerance && x <= candidate.bounds[2] + tolerance && y >= candidate.bounds[1] - tolerance && y <= candidate.bounds[3] + tolerance;
        });
        const deltaX = Math.min(...touching.map(candidate => (candidate.bounds[2] - candidate.bounds[0]) / candidate.width));
        const deltaY = Math.min(...touching.map(candidate => (candidate.bounds[3] - candidate.bounds[1]) / candidate.height));
        const left = sampleTerrainNeighborhood(grids, [x - deltaX, y]), right = sampleTerrainNeighborhood(grids, [x + deltaX, y]);
        const bottom = sampleTerrainNeighborhood(grids, [x, y - deltaY]), top = sampleTerrainNeighborhood(grids, [x, y + deltaY]);
        const physicalScale = Math.cos(location[1] * Math.PI / 180);
        const gradientX = estimateTerrainSlope(left, right, height, deltaX * physicalScale);
        const gradientY = estimateTerrainSlope(bottom, top, height, deltaY * physicalScale);
        const length = Math.hypot(gradientX, gradientY, 1);
        normals.push(-gradientX / length, -gradientY / length, 1 / length);
        return index;
    }
    /** A triangle touching invalid reconstruction nodes is omitted, not bridged. */
    function triangle(first: number, second: number, third: number): void {
        if (validVertices.has(first) && validVertices.has(second) && validVertices.has(third)) indices.push(first, second, third);
    }
    /** Retain adaptive interiors and triangulate the common boundary ring without T-junctions. */
    function reconstructTriangle(corners: readonly number[][]): void {
        const ring: number[] = [];
        for (let edge = 0; edge < 3; edge++) {
            const start = corners[edge], end = corners[(edge + 1) % 3];
            ring.push(vertex(start[0], start[1]));
            for (const point of boundaryNodes(start, end)) ring.push(vertex(point[0], point[1]));
        }
        if (!ring.every(index => validVertices.has(index))) return;
        if (ring.length === 3) triangle(ring[0], ring[1], ring[2]);
        else {
            const center = vertex(corners.reduce((sum, point) => sum + point[0] / 3, 0), corners.reduce((sum, point) => sum + point[1] / 3, 0));
            for (let edge = 0; edge < ring.length; edge++) triangle(center, ring[edge], ring[(edge + 1) % ring.length]);
        }
    }
    const masked = grids.some(candidate => candidate.valid.includes(0));
    if (masked) {
        // Adaptive decimation must not connect across a masked pixel in a triangle interior.
        for (let row = 0; row < grid.height; row++) for (let column = 0; column < grid.width; column++) {
            const northwest = vertex(column, row), northeast = vertex(column + 1, row), southwest = vertex(column, row + 1), southeast = vertex(column + 1, row + 1);
            if (![northwest, northeast, southwest, southeast].every(index => validVertices.has(index))) continue;
            reconstructTriangle([[column, row], [column, row + 1], [column + 1, row]]);
            reconstructTriangle([[column + 1, row], [column, row + 1], [column + 1, row + 1]]);
        }
    } else {
        const texture = data.mesh.attributes.TEXCOORD_0, sourceIndices = data.mesh.indices;
        if (!texture || texture.size !== 2 || !sourceIndices) throw new Error('Terrain mesh requires indexed UV coordinates');
        for (let offset = 0; offset < sourceIndices.value.length; offset += 3) {
            const corners = [0, 1, 2].map(index => {
                const source = sourceIndices.value[offset + index];
                return [texture.value[source * 2] * grid.width, texture.value[source * 2 + 1] * grid.height];
            });
            reconstructTriangle(corners);
        }
    }
    /** Materialize a detached mesh, with a truthful bounding box for its actual vertices. */
    function mesh(): Mesh {
        const packedPositions = Float32Array.from(positions);
        const heights = packedPositions.filter((_, index) => index % 3 === 2);
        let minimum = Infinity, maximum = -Infinity;
        for (const height of heights) {minimum = Math.min(minimum, height); maximum = Math.max(maximum, height);}
        const boundingBox: [number[], number[]] = [[packedPositions[0] ?? 0, packedPositions[1] ?? 0, minimum], [packedPositions[0] ?? 0, packedPositions[1] ?? 0, maximum]];
        for (let index = 0; index < packedPositions.length; index += 3) {
            boundingBox[0][0] = Math.min(boundingBox[0][0], packedPositions[index]); boundingBox[0][1] = Math.min(boundingBox[0][1], packedPositions[index + 1]);
            boundingBox[1][0] = Math.max(boundingBox[1][0], packedPositions[index]); boundingBox[1][1] = Math.max(boundingBox[1][1], packedPositions[index + 1]);
        }
        return {...data.mesh, attributes: {POSITION: {value: packedPositions, size: 3}, NORMAL: {value: Float32Array.from(normals), size: 3}, TEXCOORD_0: {value: Float32Array.from(textureCoordinates), size: 2}},
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
            const point = (offset: number) => edge === 0 ? [offset, 0] : edge === 1 ? [grid.width, offset] : edge === 2 ? [grid.width - offset, grid.height] : [0, grid.height - offset];
            const points = [point(0), ...boundaryNodes(point(0), point(length)), point(length)];
            for (let step = 0; step < points.length - 1; step++) {
                const first = points[step], second = points[step + 1];
                const firstIndex = vertices.get(`${first[0]},${first[1]}`), secondIndex = vertices.get(`${second[0]},${second[1]}`);
                if (firstIndex === undefined || secondIndex === undefined || !validVertices.has(firstIndex) || !validVertices.has(secondIndex)) continue;
                const firstBottom = bottom(firstIndex), secondBottom = bottom(secondIndex);
                indices.push(firstIndex, secondIndex, firstBottom, secondIndex, secondBottom, firstBottom);
            }
        }
    }
    return {loaded: {grid, mesh: top, surface: createTerrainQuerySurface(top)}, renderMesh: skirtDepth ? mesh() : top};
}
