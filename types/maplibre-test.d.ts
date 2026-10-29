// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Signatures of the pinned MapLibre source helpers used in comparative tests.
// Vitest resolves these aliases to MapLibre's actual source; it is not bundled
// or typechecked as part of the Tangram workspace.
declare module '@maplibre-test/projection' {
  import type Point from '@mapbox/point-geometry';
  export function placeGlyphAlongLine(
    offsetX: number, lineOffsetX: number, lineOffsetY: number, flip: boolean,
    anchorSegment: number, lineStartIndex: number, lineEndIndex: number,
    projectionContext: unknown, rotateToLine: boolean
  ): {point: Point; angle: number} | null;
}
declare module '@maplibre-test/path-interpolator' {
  import type Point from '@mapbox/point-geometry';
  export class PathInterpolator {
    constructor(points?: Point[] | null, padding?: number | null);
    length: number;
    paddedLength: number;
    lerp(t: number): Point;
  }
}
declare module '@maplibre-test/merge-lines' {
  type Point = {x: number; y: number};
  export function mergeLines<T extends {geometry: Point[][]}>(features: T[]): T[];
}
