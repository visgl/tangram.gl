// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {buildTerrainRenderMesh} from '../examples/terrain/terrain-mesh';
import {createTerrainStreamFixture} from './terrain-stream-fixture';

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
  expect(skirted.renderMesh.header?.boundingBox[0][2]).toBe(-150);
  expect(skirted.loaded.mesh.header?.boundingBox[0][2]).toBe(100);
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
