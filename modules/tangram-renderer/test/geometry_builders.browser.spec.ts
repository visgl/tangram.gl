// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {buildPolylines} from '../src/builders/polylines';
import type {GeometryVertexData, PolylineStyle} from '../src/builders/geometry-types';
import {
  buildExtrudedPolygons,
  buildPolygons,
  triangulatePolygon
} from '../src/builders/polygons';

/** Recording sink that retains each template before the builder reuses it. */
function createVertexData(): GeometryVertexData & {vertices: number[][]; vertex_elements: number[]} {
  return {
    vertex_count: 0,
    vertex_elements: [],
    vertices: [],
    addVertex(vertex: number[]) {
      this.vertices.push([...vertex]);
      this.vertex_count++;
    }
  };
}

/** Build one deterministic polyline fixture through the production sink contract. */
function buildLine(lines: number[][][], style: Partial<PolylineStyle> = {}, options: {
  textured?: boolean;
  closed?: boolean;
  removeTileEdges?: boolean;
  tileEdgeTolerance?: number;
} = {}) {
  const vertexData = createVertexData();
  const vertexTemplate = new Array(10).fill(0);
  const triangles = buildPolylines(
    lines,
    {
      width: 20,
      cap: 'butt',
      join: 'miter',
      miter_limit: 3,
      texcoord_width: 20,
      offset: 0,
      ...style
    },
    vertexData,
    vertexTemplate,
    {
      a_extrude: 2,
      a_offset: 4,
      a_texcoord: options.textured ? 6 : null
    },
    options.closed || false,
    options.removeTileEdges || false,
    options.tileEdgeTolerance || 0
  );
  return {triangles, vertexData};
}

describe('polyline geometry builder', () => {
  test('builds open miter lines and ignores degenerate input', () => {
    const result = buildLine([
      [[100, -100], [200, -100], [200, -200]],
      [[10, -10]],
      [[20, -20], [20, -20]]
    ]);
    expect(result.triangles).toBeGreaterThan(0);
    expect(result.vertexData.vertex_count).toBeGreaterThan(4);
    expect(result.vertexData.vertex_elements).toHaveLength(result.triangles * 3);
  });

  test.each([
    ['square', 'bevel'],
    ['round', 'round'],
    ['butt', 'miter']
  ] as const)('builds %s caps with %s joins and texture coordinates', (cap, join) => {
    const result = buildLine(
      [[[100, -100], [200, -100], [260, -180], [340, -120]]],
      {cap, join, width: 32, offset: 4},
      {textured: true}
    );
    expect(result.triangles).toBeGreaterThan(2);
    expect(result.vertexData.vertices.some((vertex: number[]) => vertex[4] !== 0 || vertex[5] !== 0)).toBe(true);
    expect(result.vertexData.vertices.some((vertex: number[]) => vertex[6] !== 0 || vertex[7] !== 0)).toBe(true);
  });

  test('builds clockwise and counter-clockwise closed polygon joins', () => {
    const clockwise = buildLine(
      [[[100, -100], [100, -300], [300, -300], [300, -100], [100, -100]]],
      {join: 'round', width: 24},
      {closed: true, textured: true}
    );
    const counterClockwise = buildLine(
      [[[100, -100], [300, -100], [300, -300], [100, -300], [100, -100]]],
      {join: 'bevel', width: 24},
      {closed: true}
    );
    expect(clockwise.triangles).toBeGreaterThan(0);
    expect(counterClockwise.triangles).toBeGreaterThan(0);
  });

  test('removes tile-edge segments while retaining interior geometry', () => {
    const result = buildLine(
      [[[0, 0], [4096, 0], [4096, -100], [3000, -100]]],
      {join: 'miter'},
      {removeTileEdges: true, tileEdgeTolerance: 0}
    );
    expect(result.triangles).toBeGreaterThan(0);
    expect(result.vertexData.vertex_count).toBeGreaterThan(0);
  });

  test('permutes closed lines that encounter a tile boundary', () => {
    const result = buildLine(
      [[[100, -100], [200, -100], [4096, -100], [100, -100]]],
      {join: 'miter'},
      {closed: true}
    );
    expect(result.triangles).toBeGreaterThan(0);
  });
});

describe('polygon geometry builder', () => {
  const polygon = [[
    [100, -100],
    [300, -100],
    [300, -300],
    [100, -300],
    [100, -100]
  ]];

  test('triangulates flat polygons with normalized texture coordinates', () => {
    const vertexData = createVertexData();
    const template = new Array(10).fill(0);
    const triangles = buildPolygons([polygon], vertexData, template, {
      texcoord_index: 3,
      texcoord_scale: [0.25, 0.5, 0.75, 1],
      texcoord_normalize: 65535
    });
    expect(triangles).toBe(2);
    expect(vertexData.vertex_count).toBe(5);
    expect(vertexData.vertex_elements).toHaveLength(6);
    expect(vertexData.vertices.some((vertex: number[]) => vertex[3] > 0)).toBe(true);
    expect(triangulatePolygon({
      vertices: polygon[0].flat(),
      holes: [],
      dimensions: 2
    })).toHaveLength(6);
  });

  test.each(['CW', 'CCW'])('extrudes polygon walls with %s winding', winding => {
    const vertexData = createVertexData();
    const template = new Array(12).fill(0);
    const triangles = buildExtrudedPolygons(
      [polygon],
      2,
      20,
      5,
      vertexData,
      template,
      3,
      127,
      {
        remove_tile_edges: false,
        tile_edge_tolerance: 0,
        texcoord_index: 6,
        texcoord_scale: [0, 0, 1, 1],
        texcoord_normalize: 65535,
        winding
      }
    );
    expect(triangles).toBe(10);
    expect(vertexData.vertices.some((vertex: number[]) => vertex[2] === 22)).toBe(true);
    expect(vertexData.vertices.some((vertex: number[]) => vertex[2] === 7)).toBe(true);
    expect(vertexData.vertices.some((vertex: number[]) => vertex[3] !== 0 || vertex[4] !== 0)).toBe(true);
  });

  test('does not extrude walls along tile edges', () => {
    const edgePolygon = [[
      [0, 0],
      [4096, 0],
      [4096, -100],
      [0, -100],
      [0, 0]
    ]];
    const vertexData = createVertexData();
    const triangles = buildExtrudedPolygons(
      [edgePolygon],
      0,
      10,
      0,
      vertexData,
      new Array(8).fill(0),
      3,
      127,
      {
        remove_tile_edges: true,
        tile_edge_tolerance: 0,
        winding: 'CW'
      }
    );
    expect(triangles).toBeGreaterThan(2);
    expect(triangles).toBeLessThan(10);
  });

  test('skips invalid polygon triangulation', () => {
    const vertexData = createVertexData();
    expect(
      buildPolygons([[[[0, 0], [1, 0], [2, 0]]]], vertexData, [], {})
    ).toBe(0);
    expect(vertexData.vertex_count).toBe(0);
  });
});
