// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {sampleTerrainNeighborhood, resampleTerrainNodes} from '../modules/tangram-renderer/src/map-logic/terrain-neighborhood';
import {createTerrainStreamFixture} from './terrain-stream-fixture';

test('pixel-center reconstruction makes adjacent boundary nodes identical without mutating samples', () => {
  const left = createTerrainStreamFixture().grid;
  const right = createTerrainStreamFixture([2, 0, 4, 2], [100, 200, 300, 400]).grid;
  const first = resampleTerrainNodes(left, [right]), second = resampleTerrainNodes(right, [left]);
  expect([first.width, first.height, first.registration]).toEqual([3, 3, 'grid-node']);
  for (let row = 0; row < 3; row++) expect(first.heights[row * 3 + 2]).toBe(second.heights[row * 3]);
  expect(first.heights[2]).toBe(60);
  expect(first.heights[8]).toBe(170);
  expect([...left.heights]).toEqual([10, 20, 30, 40]);
  expect(sampleTerrainNeighborhood([left, right], [2, 2])).toBe(sampleTerrainNeighborhood([right, left], [2, 2]));
  expect(sampleTerrainNeighborhood([left], [-1, 1])).toBeNull();
  expect(sampleTerrainNeighborhood([], [1, 1])).toBeNull();
  expect(sampleTerrainNeighborhood([left], [NaN, 1])).toBeNull();
});

test('four-way corners, floating boundary tolerance and touching holes preserve no-data', () => {
  const grids = [[0, 0, 2, 2], [2, 0, 4, 2], [0, 2, 2, 4], [2, 2, 4, 4]].map((bounds, index) => createTerrainStreamFixture([bounds[0], bounds[1], bounds[2], bounds[3]], Array(4).fill(index * 10)).grid);
  expect(sampleTerrainNeighborhood(grids, [2, 2])).toBe(15);
  expect(sampleTerrainNeighborhood(grids.slice(0, 2), [2 + 1e-12, 1])).toBe(5);
  grids[1].valid.fill(0);
  expect(sampleTerrainNeighborhood(grids, [2, 2])).toBeNull();
  const nodes = resampleTerrainNodes(grids[0], [grids[1]]);
  expect(nodes.valid[2]).toBe(0);
  expect(nodes.heights[2]).toBeNaN();
});

test('node grids retain dimensions and reject incompatible neighbor metadata', () => {
  const grid = {...createTerrainStreamFixture().grid, registration: 'grid-node' as const};
  const nodes = resampleTerrainNodes(grid, [grid]);
  expect([nodes.width, nodes.height]).toEqual([2, 2]);
  expect(nodes.heights).toEqual(grid.heights);
  expect(nodes.bounds).not.toBe(grid.bounds);
  for (const neighbor of [{...grid, width: 3}, {...grid, height: 3}, {...grid, bounds: [2, 0, 5, 2] as [number, number, number, number]}, {...grid, bounds: [2, 0, 4, 3] as [number, number, number, number]}, {...grid, verticalDatum: 'ellipsoidal' as const}]) expect(() => resampleTerrainNodes(grid, [neighbor])).toThrow('matching');
});
