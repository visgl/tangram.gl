// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createIterable} from '@deck.gl/core';
import type {Attribute, Layer} from '@deck.gl/core';

/** The distances of one rendered segment of a path, in common units. */
export type SegmentDistances = {
  /** From the start of the path to the segment's start. */
  start: number;
  /** From the start of the path to the segment's end. */
  end: number;
  /** The path's length. */
  length: number;
};

/**
 * An attribute `update` for a `PathLayer` that writes `size` values per rendered segment, from
 * `getValues` given the segment's distances and its path's object. The distances are measured
 * between the positions as deck.gl projects them, in the order the path runs, from 0 at each
 * path's start: as MapLibre GL JS measures a line's distance from the start of the line within its
 * tile. Padding and joint vertices get 0.
 *
 * WebGL2 guarantees 16 vertex attributes, and a `PathLayer` with dashes and offsets uses all of
 * them: each value of a segment that a layer can compute on the CPU goes in one such attribute.
 */
export function createSegmentAttributeUpdate(
  getValues: (distances: SegmentDistances, object: any, objectInfo: any) => number[]
) {
  return function update(
    this: Layer,
    attribute: Attribute,
    {startRow, endRow}: {startRow: number; endRow: number}
  ): void {
    const tesselator = (this.state as any)?.pathTesselator;
    const vertexStarts = tesselator?.vertexStarts as number[] | undefined;
    const positions = tesselator?.get?.('positions') as ArrayLike<number> | null | undefined;
    const output = attribute.value as Float32Array;
    const {size} = attribute;
    if (!vertexStarts || !positions || typeof tesselator.getPathSegmentIndices !== 'function') {
      return;
    }
    attribute.startIndices = vertexStarts;
    const firstRow = Math.max(0, startRow);
    const lastRow = Math.min(endRow, vertexStarts.length);
    const first = vertexStarts[firstRow] ?? 0;
    const last = vertexStarts[lastRow] ?? output.length / size;
    output.fill(0, first * size, last * size);

    const project = (index: number) =>
      this.projectPosition(
        [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2] || 0],
        {autoOffset: false}
      );
    const starts: number[] = [];
    const ends: number[] = [];
    const {iterable, objectInfo} = createIterable(this.props.data, firstRow, lastRow);
    let row = firstRow;
    for (const object of iterable) {
      objectInfo.index++;
      const segments: number[] = tesselator.getPathSegmentIndices(row++);
      starts.length = 0;
      ends.length = 0;
      let distance = 0;
      let previous = -2;
      let previousEnd: number[] | null = null;
      for (const segment of segments) {
        const a = segment === previous + 1 && previousEnd ? previousEnd : project(segment);
        const b = project(segment + 1);
        starts.push(distance);
        distance += Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] || 0) - (a[2] || 0));
        ends.push(distance);
        previous = segment;
        previousEnd = b;
      }
      segments.forEach((segment, index) => {
        const values = getValues(
          {start: starts[index], end: ends[index], length: distance},
          object,
          objectInfo
        );
        output.set(values, segment * size);
      });
      if (row >= lastRow) {
        break;
      }
    }
  };
}
