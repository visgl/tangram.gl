// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {createTerrainGroundTopology, getTerrainEdgeNodes, wrapTerrainGroundGrids, type TerrainGroundTopology} from '../src/map-logic/terrain-ground-topology';
import type {TerrainHeightGrid} from '../src/map-logic/terrain-data';
import type {TerrainFieldBounds} from '../src/map-logic/terrain-height-field';
import {TerrainHeightField} from '../src/map-logic/terrain-height-field';
import {drapeTerrainMesh, normalizeTerrainDraping, getTerrainVertexLayout, extractDrapedTerrainQueryMesh} from '../src/procedures/terrain-draping';
import {DrapedTerrainSurfaceSnapshot} from '../src/selection/draped-terrain-surface';
import VertexLayout from '../src/gl/vertex_layout';

const CIRCUMFERENCE = 2 * Math.PI * 6378137;
/** Use the same explicit world lattice as decoded provider tiles. */
function bounds(column: number, row: number, zoom: number): TerrainFieldBounds {
    const span = CIRCUMFERENCE / 2 ** zoom;
    return [column * span - CIRCUMFERENCE / 2, CIRCUMFERENCE / 2 - (row + 1) * span, (column + 1) * span - CIRCUMFERENCE / 2, CIRCUMFERENCE / 2 - row * span];
}
/** A tiny valid physical field, including a coarse/fine seam with different edge samples. */
function grid(column = 1, row = 1, zoom = 2, height = 100): TerrainHeightGrid {
    return {width: 3, height: 3, bounds: bounds(column, row, zoom), heights: new Float32Array(9).fill(height), valid: new Uint8Array(9).fill(1), registration: 'grid-node', verticalDatum: 'orthometric'};
}
/** Canonical triangle coordinates, independent of local vertex numbering and source tile zoom. */
function faces(topology: TerrainGroundTopology): Set<string> {
    const faces = new Set<string>();
    for (let offset = 0; offset < topology.indices.length; offset += 3) faces.add(Array.from(topology.indices.subarray(offset, offset + 3), vertex => `${topology.positions[vertex * 2]},${topology.positions[vertex * 2 + 1]}`).sort().join('|'));
    return faces;
}

test('detail owners retain identical complete canonical triangles, including neighbors outside their clip', () => {
    const grids = [grid(), grid(4, 2, 3, 200), grid(4, 3, 3, 300)];
    const parent = createTerrainGroundTopology(grids, bounds(1, 1, 2), 4);
    const detail = createTerrainGroundTopology(grids, bounds(126, 64, 8), 4);
    expect(detail.indices.length).toBeGreaterThan(6);
    for (const face of faces(detail)) expect(faces(parent).has(face)).toBe(true);
    const clip = bounds(126, 64, 8);
    expect(Array.from(detail.positions).some((coordinate, index) => index % 2 === 0 && coordinate > clip[2])).toBe(true);
    expect(createTerrainGroundTopology(grids, bounds(1, 1, 2), 4)).toEqual(parent);
});

test('balanced DEM boundaries contain all fine edge nodes, without skirts or T junctions', () => {
    const grids = [grid(), grid(4, 2, 3, 200), grid(4, 3, 3, 300)];
    const parent = createTerrainGroundTopology(grids, bounds(1, 1, 2), 4);
    const east = createTerrainGroundTopology(grids, [0, 0, CIRCUMFERENCE / 8, CIRCUMFERENCE / 4], 4);
    const edge = (topology: TerrainGroundTopology) => Array.from({length: topology.positions.length / 2}, (_, index) => [topology.positions[index * 2], topology.positions[index * 2 + 1]])
        .filter(position => position[0] === 0).map(position => position[1]).sort((first, second) => first - second);
    expect(edge(parent)).toEqual(edge(east));
    expect(edge(parent)).toHaveLength(9);
    for (const topology of [parent, east]) for (let offset = 0; offset < topology.indices.length; offset += 3) {
        const [first, second, third] = Array.from(topology.indices.subarray(offset, offset + 3), index => topology.positions.subarray(index * 2, index * 2 + 2));
        expect((second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0])).toBeGreaterThan(0);
    }
});

test('periodic copies preserve canonical samples and matching dateline knot heights', () => {
    const grids = [grid(0, 1, 2, 100), grid(3, 1, 2, 300)];
    const wrapped = wrapTerrainGroundGrids(grids), field = new TerrainHeightField(wrapped);
    expect(wrapped[0].heights).toBe(grids[0].heights);
    expect(field.sampleHeight([-CIRCUMFERENCE / 2, CIRCUMFERENCE / 8])).toBe(200);
    expect(field.sampleHeight([CIRCUMFERENCE / 2, CIRCUMFERENCE / 8])).toBe(200);
    const ordinary = createTerrainGroundTopology(grids, bounds(0, 1, 2), 4);
    const repeated = createTerrainGroundTopology(grids, bounds(8, 1, 2), 4);
    expect(repeated.sampleOffset).toBe(2 * CIRCUMFERENCE);
    expect(repeated.samplePositions).toEqual(ordinary.samplePositions);
    expect(repeated.indices).toEqual(ordinary.indices);
    for (let index = 0; index < repeated.positions.length; index++) expect(repeated.positions[index]).toBe(ordinary.positions[index] + (index % 2 ? 0 : 2 * CIRCUMFERENCE));
});

test('high-zoom lattice nodes remain inside their snapped sampling footprints', () => {
    const source = grid(2 ** 30 - 1, 2 ** 29, 30), topology = createTerrainGroundTopology([source], source.bounds, 4);
    const field = new TerrainHeightField(wrapTerrainGroundGrids([source]));
    for (let offset = 0; offset < topology.samplePositions.length; offset += 2) expect(field.sampleHeight([topology.samplePositions[offset], topology.samplePositions[offset + 1]])).toBeCloseTo(100, 10);
});

test('no-data is retained by conservative complete-cell sampling, not patched from another field', () => {
    const source = grid();
    source.valid[4] = 0; source.heights[4] = NaN;
    const field = new TerrainHeightField(wrapTerrainGroundGrids([source]));
    const topology = createTerrainGroundTopology([source], source.bounds, 4);
    expect(topology.indices.length).toBeGreaterThan(0);
    expect(field.sampleHeight([source.bounds[0] / 2, source.bounds[3] / 2])).toBeNull();
    expect(field.coversBounds(source.bounds)).toBe(false);
});

test.each([0, 1, 3, 65, NaN])('canonical resolution %s rejects instead of publishing partial topology', resolution => {
    expect(() => createTerrainGroundTopology([grid()], bounds(1, 1, 2), resolution)).toThrow(/limits/);
    expect(() => normalizeTerrainDraping({grids: [], groundMeshResolution: resolution === 0 ? -1 : resolution})).toThrow(/limits/);
});

test('unsupported footprints, overlap, unbalanced edges and resource pressure reject explicitly', () => {
    expect(() => createTerrainGroundTopology([{...grid(), bounds: [0, 0, 100, 100]}], bounds(1, 1, 2), 4)).toThrow(/quadtree/);
    expect(() => createTerrainGroundTopology([grid(), grid()], bounds(1, 1, 2), 4)).toThrow(/overlap/);
    expect(() => createTerrainGroundTopology([grid(), grid(8, 4, 4)], bounds(1, 1, 2), 4)).toThrow(/balanced/);
    expect(() => createTerrainGroundTopology([grid()], bounds(1, 1, 2), 4, 1)).toThrow(/vertex budget/);
    expect(() => createTerrainGroundTopology([grid()], [0, 0, 0, 1])).toThrow(/bounds/);
    expect(() => createTerrainGroundTopology(Array.from({length: 97}, () => grid()), bounds(1, 1, 2))).toThrow(/limits/);
    expect(createTerrainGroundTopology([], bounds(1, 1, 2), 4).indices).toHaveLength(0);
    expect(createTerrainGroundTopology([grid()], bounds(2, 2, 2), 4).indices).toHaveLength(0);
});

test('shared edge knot ordering also supports reversed horizontal edges and unchanged interior diagonals', () => {
    const parent = bounds(1, 1, 2), neighbors = [parent, bounds(2, 1, 3)];
    expect(getTerrainEdgeNodes(parent, neighbors, 4, [1, 1], [2, 2])).toEqual([]);
    const forward = getTerrainEdgeNodes(parent, neighbors, 4, [0, 0], [1, 0]);
    expect(forward).toEqual([[0.5, 0]]);
    expect(getTerrainEdgeNodes(parent, neighbors, 4, [1, 0], [0, 0])).toEqual([...forward].reverse());
});

const layout = new VertexLayout([{name: 'a_position', size: 4, type: 5122}, {name: 'a_color', size: 4, type: 5121}]);
/** Packed real raster-style quad; all style channels stay constant while XY changes. */
function quad(column: number, row: number, zoom: number, grids: readonly TerrainHeightGrid[], previousGrids: readonly TerrainHeightGrid[] = []) {
    const vertices = new Uint8Array(layout.stride * 4), view = new DataView(vertices.buffer);
    [[0, 0], [4096, 0], [4096, -4096], [0, -4096]].forEach(([x, y], index) => {
        view.setInt16(index * layout.stride, x, true); view.setInt16(index * layout.stride + 2, y, true);
        vertices.set([120, 160, 200, 255], index * layout.stride + layout.offset.a_color);
    });
    const footprint = bounds(column, row, zoom);
    return {vertices, indices: new Uint16Array([0, 1, 2, 0, 2, 3]), layout, origin: [footprint[0], footprint[3]] as const, tileZoom: zoom, ground: true,
        terrain: normalizeTerrainDraping({grids, previousGrids, groundMeshResolution: 4, transitionDuration: 200})};
}

test('worker ground uses identical sampled morph endpoints at shared source edges and keeps ownership clips', () => {
    const current = [grid(1, 1, 2, 500)], previous = [grid(1, 1, 2, 100)];
    const parentInput = quad(1, 1, 2, current, previous), childInput = quad(8, 8, 5, current, previous);
    const parent = drapeTerrainMesh(parentInput), child = drapeTerrainMesh(childInput);
    expect(parent.groundClip).toBe(true); expect(child.groundClip).toBe(true);
    expect(parent.statistics.canonicalGroundResolution).toBe(4);
    const output = getTerrainVertexLayout(layout);
    const mesh = (input: typeof parentInput, data: typeof parent) => extractDrapedTerrainQueryMesh(data.vertices, data.indices, output, input.origin, input.tileZoom, 1024 * 1024);
    const parentMesh = mesh(parentInput, parent), childMesh = mesh(childInput, child);
    const clip = bounds(8, 8, 5);
    expect(childMesh.bounds[2]).toBeGreaterThan(clip[2]);
    for (const blend of [0, 0.5, 1]) {
        const snapshot = new DrapedTerrainSurfaceSnapshot('web-mercator', [
            {id: 'parent', mesh: parentMesh, blend, clips: [[clip[2], clip[1], bounds(1, 1, 2)[2], clip[3]]], halfOpenClips: true},
            {id: 'detail', mesh: childMesh, blend, clips: [clip], halfOpenClips: true}
        ], 1, 100, 1);
        const y = (clip[1] + clip[3]) / 2;
        for (const x of [clip[2] - 1, clip[2], clip[2] + 1]) {
            const hit = snapshot.intersectRay({origin: [x, y, 1000], direction: [0, 0, -1]});
            expect(hit?.coordinate[2]).toBeCloseTo(100 + 400 * blend, 6);
            expect(hit?.surfaceId).toBe(x < clip[2] ? 'detail' : 'parent');
        }
    }
    const invalid = quad(1, 1, 2, current);
    new DataView(invalid.vertices.buffer).setInt16(0, 12, true);
    expect(() => drapeTerrainMesh(invalid)).toThrow(/full tile/);
    const tinted = quad(1, 1, 2, current); tinted.vertices[layout.stride + layout.offset.a_color] = 1;
    expect(() => drapeTerrainMesh(tinted)).toThrow(/uniform quad/);
    const missing = grid(1, 1, 2, 500); missing.valid.fill(0); missing.heights.fill(NaN);
    const suppressed = drapeTerrainMesh(quad(1, 1, 2, [missing], previous));
    expect(suppressed.indices).toHaveLength(0);
    expect(suppressed.statistics.suppressedTriangles).toBeGreaterThan(0);
});

test('nonplanar ground keeps the parent triangle surface through source-detail ownership and height morphs', () => {
    const current = grid(), previous = grid();
    current.heights.set([40, 300, 80, 200, 900, 400, 60, 350, 100]);
    previous.heights.set([10, 40, 20, 30, 180, 70, 15, 50, 25]);
    const parentInput = quad(1, 1, 2, [current], [previous]), childInput = quad(8, 8, 5, [current], [previous]);
    const output = getTerrainVertexLayout(layout);
    const extract = (input: typeof parentInput) => {
        const prepared = drapeTerrainMesh(input);
        return extractDrapedTerrainQueryMesh(prepared.vertices, prepared.indices, output, input.origin, input.tileZoom, 1024 * 1024);
    };
    const parent = extract(parentInput), child = extract(childInput), clip = bounds(8, 8, 5);
    for (const blend of [0, 0.25, 0.75, 1]) {
        const oracle = new DrapedTerrainSurfaceSnapshot('web-mercator', [{id: 'parent', mesh: parent, blend}], 1, 100, 1);
        const split = new DrapedTerrainSurfaceSnapshot('web-mercator', [
            {id: 'parent', mesh: parent, blend, clips: [[clip[2], clip[1], current.bounds[2], clip[3]]], halfOpenClips: true},
            {id: 'detail', mesh: child, blend, clips: [clip], halfOpenClips: true}
        ], 1, 100, 1);
        for (const x of [clip[2] - 1, clip[2], clip[2] + 1]) {
            const ray = {origin: [x, (clip[1] + clip[3]) / 2, 2000] as const, direction: [0, 0, -1] as const};
            const expected = oracle.intersectRay(ray), actual = split.intersectRay(ray);
            expect(expected).not.toBeNull(); expect(actual).not.toBeNull();
            expect(actual?.coordinate[2]).toBeCloseTo(expected!.coordinate[2], 6);
            expect(actual?.surfaceId).toBe(x < clip[2] ? 'detail' : 'parent');
        }
    }
});

test('canonical packing preserves shared dyadic positions at the precision boundary and rejects excessive LOD gaps', () => {
    const grids = [grid(), grid(4, 2, 3, 200), grid(4, 3, 3, 300)];
    const output = getTerrainVertexLayout(layout);
    const extract = (input: ReturnType<typeof quad>) => {
        const prepared = drapeTerrainMesh(input);
        return extractDrapedTerrainQueryMesh(prepared.vertices, prepared.indices, output, input.origin, input.tileZoom, 1024 * 1024);
    };
    const parent = extract(quad(1, 1, 2, grids));
    for (const column of [8190, 8191]) {
        const detail = extract(quad(column, 4096, 14, grids));
        for (let vertex = 0; vertex < detail.positions.length; vertex += 3) {
            expect(Array.from({length: parent.positions.length / 3}, (_, index) => index * 3).some(index =>
                Math.abs(parent.positions[index] - detail.positions[vertex]) < 1e-7 && Math.abs(parent.positions[index + 1] - detail.positions[vertex + 1]) < 1e-7)).toBe(true);
        }
    }
    expect(() => drapeTerrainMesh(quad(16383, 8192, 15, grids))).toThrow(/LOD gap/);
    expect(() => drapeTerrainMesh(quad(2 ** 30 - 1, 2 ** 29, 30, [grid(3, 2, 2)]))).toThrow(/LOD gap/);
    expect(() => drapeTerrainMesh(quad(0, 0, 0, [grid(0, 0, 17)]))).toThrow(/LOD gap/);
    expect(drapeTerrainMesh(quad(0, 0, 1, [grid(0, 0, 17)])).indices.length).toBeGreaterThan(0);
    const highZoom = extract(quad(2 ** 30 - 1, 2 ** 29, 30, [grid(2 ** 30 - 1, 2 ** 29, 30)]));
    expect(highZoom.positions.every(Number.isFinite)).toBe(true);
    expect(highZoom.indices.length).toBeGreaterThan(0);
});

test('material UV channels cannot silently collapse to the copied template coordinate', () => {
    const input = quad(1, 1, 2, [grid()]);
    const materialLayout = new VertexLayout([{name: 'a_position', size: 4, type: 5122}, {name: 'a_color', size: 4, type: 5121}, {name: 'a_texcoord', size: 2, type: 5123, normalized: true}]);
    const vertices = new Uint8Array(materialLayout.stride * 4), view = new DataView(vertices.buffer);
    for (let index = 0; index < 4; index++) {
        vertices.set(input.vertices.subarray(index * layout.stride, (index + 1) * layout.stride), index * materialLayout.stride);
        view.setUint16(index * materialLayout.stride + materialLayout.offset.a_texcoord, index % 2 ? 65535 : 0, true);
    }
    expect(() => drapeTerrainMesh({...input, vertices, layout: materialLayout})).toThrow(/uniform quad/);
    for (let index = 0; index < 4; index++) view.setUint16(index * materialLayout.stride + materialLayout.offset.a_texcoord, 100, true);
    const prepared = drapeTerrainMesh({...input, vertices, layout: materialLayout});
    const outputLayout = getTerrainVertexLayout(materialLayout), output = new DataView(prepared.vertices.buffer);
    for (let index = 0; index < prepared.vertices.length / outputLayout.stride; index++) expect(output.getUint16(index * outputLayout.stride + outputLayout.offset.a_texcoord, true)).toBe(100);
});
