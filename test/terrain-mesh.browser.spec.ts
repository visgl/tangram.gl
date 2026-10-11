// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {buildTerrainRenderMesh} from '../examples/terrain/terrain-mesh';
import {createTerrainStreamFixture} from './terrain-stream-fixture';
import {sampleTerrainAnchor} from '../examples/terrain/ground-following';
import {worldToLngLat} from '@math.gl/web-mercator';

test.each([
  {side: 'east', axis: 0, coarseEdge: 1, fineEdge: 0, upper: [2, 1, 3, 2], lower: [2, 0, 3, 1]},
  {side: 'west', axis: 0, coarseEdge: 0, fineEdge: 1, upper: [-1, 1, 0, 2], lower: [-1, 0, 0, 1]},
  {side: 'north', axis: 1, coarseEdge: 0, fineEdge: 1, upper: [0, 2, 1, 3], lower: [1, 2, 2, 3]},
  {side: 'south', axis: 1, coarseEdge: 1, fineEdge: 0, upper: [0, -1, 1, 0], lower: [1, -1, 2, 0]}
])('2:1 $side fallback edges share fine nodes, heights and normals without skirts', configuration => {
  const bounds = (values: readonly number[]): [number, number, number, number] => [values[0] * 1000 + 1000000, values[1] * 1000 + 6000000, values[2] * 1000 + 1000000, values[3] * 1000 + 6000000];
  const coarse = createTerrainStreamFixture(bounds([0, 0, 2, 2])), upper = createTerrainStreamFixture(bounds(configuration.upper), [100, 200, 300, 400]), lower = createTerrainStreamFixture(bounds(configuration.lower), [500, 600, 700, 800]);
  const coarseMesh = buildTerrainRenderMesh(coarse, [upper.grid, lower.grid], 0).loaded.mesh;
  const fineMeshes = [upper, lower].map(data => buildTerrainRenderMesh(data, [coarse.grid, data === upper ? lower.grid : upper.grid], 0).loaded.mesh);
  function edgeNodes(mesh: typeof coarseMesh, column: number) {
    const {POSITION, NORMAL, TEXCOORD_0} = mesh.attributes;
    const nodes = new Map<number, {position: number[]; normal: number[]}>();
    for (let index = 0; index < TEXCOORD_0.value.length / 2; index++) if (TEXCOORD_0.value[index * 2 + configuration.axis] === column) nodes.set(POSITION.value[index * 3 + 1 - configuration.axis], {position: [...POSITION.value.slice(index * 3, index * 3 + 3)], normal: [...NORMAL.value.slice(index * 3, index * 3 + 3)]});
    return nodes;
  }
  const coarseEdge = edgeNodes(coarseMesh, configuration.coarseEdge);
  const fineEdge = new Map(fineMeshes.flatMap(mesh => [...edgeNodes(mesh, configuration.fineEdge)]));
  expect(coarseEdge.size).toBe(5);
  expect([...coarseEdge].sort()).toEqual([...fineEdge].sort());
  expect(buildTerrainRenderMesh(coarse, [lower.grid, upper.grid], 0).loaded.mesh).toEqual(coarseMesh);
  // Every refined edge node participates in the physical top topology, not just a skirt.
  const coordinates = coarseMesh.attributes.TEXCOORD_0.value;
  for (let index = 0; index < coordinates.length / 2; index++) if (coordinates[index * 2 + configuration.axis] === configuration.coarseEdge) expect([...coarseMesh.indices!.value]).toContain(index);
  expect(() => buildTerrainRenderMesh(coarse, [createTerrainStreamFixture(bounds([2, 0, 2.5, 0.5])).grid])).toThrow('2:1');
});

test('mixed-detail stitching preserves no-data holes and refuses overlapping parent footprints', () => {
  const coarse = createTerrainStreamFixture(), fine = createTerrainStreamFixture([2, 1, 3, 2]);
  fine.grid.valid[0] = 0; fine.grid.heights[0] = NaN;
  const mesh = buildTerrainRenderMesh(coarse, [fine.grid], 0);
  expect(mesh.loaded.surface.intersectRay({origin: [2, 1.75, 1000], direction: [0, 0, -1]})).toBeNull();
  expect(mesh.loaded.mesh.attributes.POSITION.value.every(Number.isFinite)).toBe(true);
  expect(() => buildTerrainRenderMesh(coarse, [createTerrainStreamFixture([0, 0, 1, 1]).grid])).toThrow('touching');
});

test('ground following samples rendered top triangles in physical meters, never skirts or absent terrain', () => {
  const data = createTerrainStreamFixture([0, 0, 2, 2], [100, 200, 300, 400]);
  const mesh = buildTerrainRenderMesh(data, [], 10000).loaded;
  const location = worldToLngLat([256 + 0.8 * 512 / (2 * Math.PI * 6378137), 256 + 1.2 * 512 / (2 * Math.PI * 6378137)]);
  const coordinate: [number, number] = [location[0], location[1]];
  const hit = mesh.surface.intersectRay({origin: [0.8, 1.2, 1000], direction: [0, 0, -1]});
  expect(sampleTerrainAnchor([mesh], coordinate, 250)).toBeCloseTo(hit!.position[2] + 250, 4);
  expect(sampleTerrainAnchor([], coordinate, 250)).toBeNull();
  const query = vi.spyOn(mesh.surface, 'intersectRay');
  expect(sampleTerrainAnchor([mesh], [180, 0], 250)).toBeNull();
  expect(query).not.toHaveBeenCalled();
  const negative = buildTerrainRenderMesh(createTerrainStreamFixture([0, 0, 2, 2], [-100, -100, -100, -100]), [], 0).loaded;
  expect(sampleTerrainAnchor([negative], coordinate, 250)).toBeCloseTo(150);
  const highest = buildTerrainRenderMesh(createTerrainStreamFixture([0, 0, 2, 2], [1000, 1000, 1000, 1000]), [], 0).loaded;
  expect(sampleTerrainAnchor([negative, mesh, highest], coordinate, 250)).toBeCloseTo(1250);
  const missing = createTerrainStreamFixture(); missing.grid.valid.fill(0); missing.grid.heights.fill(NaN);
  expect(sampleTerrainAnchor([buildTerrainRenderMesh(missing).loaded], coordinate, 250)).toBeNull();
  expect(() => sampleTerrainAnchor([mesh], coordinate, -1)).toThrow();
  expect(sampleTerrainAnchor([mesh], [0, 90], 1)).toBeNull();
  expect(sampleTerrainAnchor([mesh], [0, 85.051129], 1)).toBeNull();
  expect(() => sampleTerrainAnchor([mesh], [0, 91], 1)).toThrow();
  expect(() => sampleTerrainAnchor([mesh], [NaN, 0], 1)).toThrow();
});

test('adjacent adaptive meshes expose identical full-resolution edge heights and normals', () => {
  const first = createTerrainStreamFixture(), second = createTerrainStreamFixture([2, 0, 4, 2], [100, 200, 300, 400]);
  const left = buildTerrainRenderMesh(first, [second.grid], 0), right = buildTerrainRenderMesh(second, [first.grid], 0);
  function edge(mesh: typeof left.loaded.mesh, column: number) {
    const {POSITION, NORMAL, TEXCOORD_0} = mesh.attributes;
    const nodes: {row: number; position: number[]; normal: number[]}[] = [];
    for (let index = 0; index < TEXCOORD_0.value.length / 2; index++) if (TEXCOORD_0.value[index * 2] === column) nodes.push({row: TEXCOORD_0.value[index * 2 + 1], position: [...POSITION.value.slice(index * 3, index * 3 + 3)], normal: [...NORMAL.value.slice(index * 3, index * 3 + 3)]});
    return nodes.sort((first, second) => first.row - second.row);
  }
  expect(edge(left.loaded.mesh, 1)).toEqual(edge(right.loaded.mesh, 0));
  expect(edge(left.loaded.mesh, 1)).toHaveLength(3);
  expect(left.loaded.mesh.indices!.value.length).toBeGreaterThan(6);
  expect(left.loaded.mesh.schema.fields.find(field => field.name === 'NORMAL')?.type).toMatchObject({listSize: 3});
  for (let index = 0; index < left.loaded.mesh.attributes.NORMAL.value.length; index += 3) expect(Math.hypot(...left.loaded.mesh.attributes.NORMAL.value.slice(index, index + 3))).toBeCloseTo(1);
});

test('visual skirts do not change physical queries, topology or top-surface bounds', () => {
  const data = createTerrainStreamFixture([0, 0, 2, 2], [100, 100, 100, 100]);
  const plain = buildTerrainRenderMesh(data, [], 0), skirted = buildTerrainRenderMesh(data, [], 250);
  expect(skirted.loaded.mesh).toEqual(plain.loaded.mesh);
  expect(skirted.renderMesh.indices!.value.length).toBeGreaterThan(plain.renderMesh.indices!.value.length);
  expect(skirted.renderMesh.header?.boundingBox?.[0][2]).toBe(-150);
  expect(skirted.loaded.mesh.header?.boundingBox?.[0][2]).toBe(100);
  expect(skirted.loaded.surface.intersectRay({origin: [1, 1, 1000], direction: [0, 0, -1]})?.position[2]).toBeCloseTo(100);
  expect(skirted.loaded.surface.intersectRay({origin: [-1, 1, 0], direction: [1, 0, 0]})).toBeNull();
  expect(data.mesh.attributes.POSITION.value).toEqual(new Float32Array(12));
});

test('invalid samples form mesh holes, never giant adaptive triangles across missing pixels', () => {
  const data = createTerrainStreamFixture(); data.grid.valid[0] = 0; data.grid.heights[0] = NaN;
  const result = buildTerrainRenderMesh(data, [], 0);
  expect(result.loaded.mesh.indices!.value.length).toBeLessThan(buildTerrainRenderMesh(createTerrainStreamFixture(), [], 0).loaded.mesh.indices!.value.length);
  expect(result.loaded.surface.intersectRay({origin: [0.25, 1.75, 1000], direction: [0, 0, -1]})).toBeNull();
  expect(result.renderMesh.attributes.POSITION.value.every(Number.isFinite)).toBe(true);
  data.grid.valid.fill(0); data.grid.heights.fill(NaN);
  expect(buildTerrainRenderMesh(data).loaded.mesh.indices!.value).toHaveLength(0);
});

test('bad skirt units, incompatible neighbors and missing adaptive UVs reject explicitly', () => {
  const data = createTerrainStreamFixture();
  expect(() => buildTerrainRenderMesh(data, [], -1)).toThrow();
  expect(() => buildTerrainRenderMesh(data, [{...data.grid, verticalDatum: 'ellipsoidal'}])).toThrow();
  expect(() => buildTerrainRenderMesh(data, [createTerrainStreamFixture([0, 0, 4, 2]).grid])).toThrow();
  const missing = {...data, mesh: {...data.mesh, attributes: {POSITION: data.mesh.attributes.POSITION}}};
  expect(() => buildTerrainRenderMesh(missing)).toThrow('UV');
});

test.each([{heights: [10, 20, 10, 20], axis: 0}, {heights: [10, 10, 20, 20], axis: 1}])('outer boundaries retain one-sided slope normals along axis $axis', ({heights, axis}) => {
  const result = buildTerrainRenderMesh(createTerrainStreamFixture([0, 0, 2, 2], heights), [], 0);
  const {NORMAL, TEXCOORD_0} = result.loaded.mesh.attributes;
  let checked = 0;
  for (let index = 0; index < TEXCOORD_0.value.length / 2; index++) {
    const edge = TEXCOORD_0.value[index * 2 + axis];
    if (edge !== 0 && edge !== 1) continue;
    expect(Math.abs(NORMAL.value[index * 3 + axis])).toBeGreaterThan(0.8);
    expect(NORMAL.value[index * 3 + 2]).toBeGreaterThan(0);
    expect(NORMAL.value[index * 3 + 1 - axis]).toBeCloseTo(0);
    checked++;
  }
  expect(checked).toBeGreaterThanOrEqual(6);
});
