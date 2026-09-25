// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {buildQuadForPoint} from '../src/builders/points';
import {isCoordOutsideTile, outsideTile} from '../src/builders/common';
import {buildFilter} from '../src/styles/filter';
import {TangramSourceSchema, TangramStyleSheetSchema} from '../src/styles/style-schema';
import PointAnchor from '../src/labels/point_anchor';
import {boxIntersectsBox, boxIntersectsList} from '../src/labels/intersect';
import {isTextNeutral, isTextRTL, splitLabelText} from '../src/styles/text/text_segments';
import MultiLine from '../src/styles/text/text_wrap';

describe('renderer pure logic', () => {
  test('classifies segments and coordinates at tile boundaries', () => {
    expect(outsideTile([0, 0], [1, 1], 0)).toBe(true);
    expect(outsideTile([10, -10], [20, -20], 0)).toBe(false);
    expect(isCoordOutsideTile([0, -1])).toBe(true);
    expect(isCoordOutsideTile([10, -10])).toBe(false);
    expect(isCoordOutsideTile([1, -2], 1)).toBe(true);
  });

  test('builds a point quad and optional curved-label attributes', () => {
    const vertices: any[] = [];
    const vertexData: any = {
      vertex_elements: [],
      vertex_count: 0,
        addVertex(vertex: number[]) {
        vertices.push(vertex.slice());
        this.vertex_count++;
      }
    };
    const vertexTemplate = new Array(24).fill(0);
    const vertexIndex = {
      a_position: 0,
      a_shape: 2,
      a_offset: 5,
      a_texcoord: 7,
      a_pre_angles: 9,
      a_angles: 13,
      a_offsets: 17
    };

    const triangleCount = buildQuadForPoint(
      [10, 20],
      vertexData,
      vertexTemplate,
      vertexIndex,
      [2, 4],
      [3, 5],
      [1, 2, 3, 4],
      [0.1, 0.2, 0.3, 0.4],
      0.5,
      [0.5, 0.6, 0.7, 0.8],
      [0.1, 0.2, 0.8, 0.9],
      true
    );

    expect(triangleCount).toBe(2);
    expect(vertexData.vertex_count).toBe(4);
    expect(vertexData.vertex_elements).toEqual([0, 1, 2, 2, 3, 0]);
    expect(vertices[0].slice(0, 9)).toEqual([10, 20, -256, -512, 0.5, 3, 5, 6553.5, 13107]);
    expect(vertices[2][9]).toBeCloseTo(0.1 * (128 / Math.PI));
    expect(vertices[3][20]).toBe(4 * 64);
  });

  test('evaluates Tangram filter expressions', () => {
    const context = {
      feature: {
        properties: {
          kind: 'road',
          nested: {rank: 3},
          tags: ['primary', 'paved'],
          optional: null
        }
      },
      zoom: 12
    };

    expect(buildFilter({kind: 'road'})(context)).toBe(true);
    expect(buildFilter({kind: ['road', 'rail']})(context)).toBe(true);
    expect(buildFilter({'nested.rank': {min: 2, max: 4}})(context)).toBe(true);
    expect(buildFilter({tags: {includes_any: 'primary'}})(context)).toBe(true);
    expect(buildFilter({tags: {includes_all: ['primary', 'paved']}})(context)).toBe(true);
    expect(buildFilter({any: [{kind: 'building'}, {kind: 'road'}]})(context)).toBe(true);
    expect(buildFilter({all: [{kind: 'road'}, {optional: null}]})(context)).toBe(true);
    expect(buildFilter({none: [{kind: 'building'}]})(context)).toBe(true);
    expect(buildFilter({not: {kind: 'building'}})(context)).toBe(true);
    expect(buildFilter({optional: true})(context)).toBe(false);
    expect(buildFilter(null)(context)).toBe(true);

    const transformed = buildFilter({zoom: {min: 3}}, {rangeTransform: (value: number) => value + 8});
    expect(transformed({feature: {properties: {zoom: 12}}})).toBe(true);
    expect(buildFilter((value: any) => value.feature.properties.kind === 'road')(context)).toBe(true);
    expect(buildFilter((value: any) => value.feature.properties.kind === 'building')(context)).toBe(false);
  });

  test('handles point anchors and collision boxes', () => {
    expect(PointAnchor.computeOffset([10, 20], [8, 4], 'top-left')).toEqual([6, 18]);
    expect(PointAnchor.computeOffset([10, 20], [8, 4], 'right', [1, 2, 3, 4])).toEqual([16, 20]);
    expect(PointAnchor.computeOffset([10, 20], [8, 4], 'center')).toEqual([10, 20]);
    expect(PointAnchor.alignForAnchor('left')).toBe('right');
    expect(PointAnchor.alignForAnchor('bottom')).toBe('center');
    expect(PointAnchor.isLeftAnchor('bottom-left')).toBe(true);
    expect(PointAnchor.isRightAnchor('top-right')).toBe(true);
    expect(PointAnchor.isTopAnchor('top-right')).toBe(true);
    expect(PointAnchor.isBottomAnchor('bottom-left')).toBe(true);

    expect(boxIntersectsBox([0, 0, 5, 5], [4, 4, 8, 8])).toBe(true);
    expect(boxIntersectsBox([0, 0, 2, 2], [3, 3, 8, 8])).toBe(false);
    const hits: number[] = [];
    boxIntersectsList([0, 0, 5, 5], [[10, 10, 12, 12], [1, 1, 2, 2]], (index: number) => hits.push(index));
    expect(hits).toEqual([1]);
  });

  test('segments directional text and caches results', () => {
    const cache = {segment: {}, stats: {segment_hits: 0, segment_misses: 0}};
    expect(splitLabelText('abcd', false, cache)).toEqual(['ab', 'cd']);
    expect(splitLabelText('abcd', false, cache)).toEqual(['ab', 'cd']);
    expect(cache.stats.segment_hits).toBe(1);
    expect(splitLabelText('אב', true, cache)).toEqual(['ב', 'א']);
    expect(isTextRTL('שלום')).toBe(true);
    expect(isTextRTL('road')).toBe(false);
    expect(isTextNeutral('-')).toBe(true);
    expect(isTextNeutral('A')).toBe(false);
  });

  test('wraps text by words, explicit breaks, and line limits', () => {
    const context = {measureText: (text: string) => ({width: text.length * 2})};
    const wrapped = MultiLine.parse('one two three', 7, Infinity, 10, context);
    expect(wrapped.lines.map(line => line.text)).toEqual(['one two', 'three']);
    expect(wrapped.width).toBe(14);
    expect(wrapped.height).toBe(20);

    const limited = MultiLine.parse('one two three', 7, 1, 10, context);
    expect(limited.lines).toHaveLength(1);
    expect(limited.lines[0].text.endsWith('...')).toBe(true);
    expect(MultiLine.parse('first\nsecond', Infinity, Infinity, 8, context).lines).toHaveLength(2);
  });

  test('validates style-sheet structure while preserving extensions', () => {
    const result = TangramStyleSheetSchema.safeParse({
      scene: {animated: true},
      sources: {
        map: {
          type: 'MVT',
          url: 'https://example.com/{z}/{x}/{y}.pmtiles',
          decoder: 'loaders-mlt',
          tile_provider: 'loaders-pmtiles',
          parse_json: ['metadata']
        }
      },
      styles: {roads: {base: 'lines', draw: {color: '#fff'}}},
      custom_extension: {enabled: true}
    });
    expect(result.success).toBe(true);
    expect(TangramSourceSchema.shape.decoder).toBeDefined();
    expect(TangramSourceSchema.shape.tile_provider).toBeDefined();
    expect((result.data as any).custom_extension).toEqual({enabled: true});
    expect(TangramStyleSheetSchema.safeParse({sources: {map: {tile_size: -1}}}).success).toBe(false);
    expect(TangramStyleSheetSchema.safeParse({
      import: ['base.yaml', {layers: {roads: {draw: {lines: {color: '#fff'}}}}}],
      styles: {
        roads: {base: 'lines', lighting: 'vertex', raster: 'color'},
        terrain: {base: 'polygons', lighting: 'fragment', raster: 'normal'},
        custom: {base: 'polygons', raster: 'custom'}
      }
    }).success).toBe(true);
    expect(TangramStyleSheetSchema.safeParse({
      styles: {roads: {lighting: 'pixel', raster: 'height'}}
    }).success).toBe(false);
  });
});
