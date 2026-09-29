// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {Vector2} from '@math.gl/core';
import type {MutableNumericVector, NumericVector} from './vector';

type Quad = [number, number, number, number, number, number, number, number];
type Extent = [number, number, number, number];

const ZERO_AXES: MutableNumericVector[] = [[1, 0], [0, 1]];
const projectionA: MutableNumericVector = [];
const projectionB: MutableNumericVector = [];

/** Two-dimensional oriented bounding box. */
export default class OBB {
  /** Half-width and half-height. */
  readonly dimension: [number, number];
  /** Rotation angle in radians. */
  angle: number;
  /** Box center. */
  readonly centroid: [number, number];
  /** Flattened corner coordinates. */
  quad!: Quad;
  /** First normalized separating axis. */
  axis_0!: MutableNumericVector;
  /** Second normalized separating axis. */
  axis_1!: MutableNumericVector;

  constructor(x: number, y: number, angle: number, width: number, height: number) {
    this.dimension = [width / 2, height / 2];
    this.angle = angle;
    this.centroid = [x, y];
    this.update();
  }

  /** Returns a serializable representation of the box. */
  toJSON(): {x: number; y: number; a: number; w: number; h: number} {
    return {
      x: this.centroid[0],
      y: this.centroid[1],
      a: this.angle,
      w: this.dimension[0],
      h: this.dimension[1]
    };
  }

  /** Returns the axis-aligned extent containing the box. */
  getExtent(): Extent {
    if (this.angle === 0) {
      return [this.quad[0], this.quad[1], this.quad[4], this.quad[5]];
    }

    return [
      Math.min(this.quad[0], this.quad[2], this.quad[4], this.quad[6]),
      Math.min(this.quad[1], this.quad[3], this.quad[5], this.quad[7]),
      Math.max(this.quad[0], this.quad[2], this.quad[4], this.quad[6]),
      Math.max(this.quad[1], this.quad[3], this.quad[5], this.quad[7])
    ];
  }

  /** Recalculates the normalized box axes. */
  updateAxes(): void {
    this.axis_0 = new Vector2([
      this.quad[4] - this.quad[6],
      this.quad[5] - this.quad[7]
    ]).normalize().toArray([]);
    this.axis_1 = new Vector2([
      this.quad[4] - this.quad[2],
      this.quad[5] - this.quad[3]
    ]).normalize().toArray([]);
  }

  /** Recalculates corners and axes from the current center, dimensions, and angle. */
  update(): void {
    const [centerX, centerY] = this.centroid;
    const [halfWidth, halfHeight] = this.dimension;

    if (this.angle === 0) {
      this.quad = [
        centerX - halfWidth, centerY - halfHeight,
        centerX + halfWidth, centerY - halfHeight,
        centerX + halfWidth, centerY + halfHeight,
        centerX - halfWidth, centerY + halfHeight
      ];
      this.axis_0 = ZERO_AXES[0];
      this.axis_1 = ZERO_AXES[1];
      return;
    }

    const widthX = Math.cos(this.angle) * halfWidth;
    const widthY = Math.sin(this.angle) * halfWidth;
    const heightX = -Math.sin(this.angle) * halfHeight;
    const heightY = Math.cos(this.angle) * halfHeight;
    this.quad = [
      centerX - widthX - heightX, centerY - widthY - heightY,
      centerX + widthX - heightX, centerY + widthY - heightY,
      centerX + widthX + heightX, centerY + widthY + heightY,
      centerX - widthX + heightX, centerY - widthY + heightY
    ];
    this.updateAxes();
  }

  /** Projects a box onto an axis and writes its minimum and maximum values. */
  static projectToAxis(box: OBB, axis: NumericVector, projection: MutableNumericVector): MutableNumericVector {
    const dot0 = box.quad[0] * axis[0] + box.quad[1] * axis[1];
    const dot1 = box.quad[2] * axis[0] + box.quad[3] * axis[1];
    const dot2 = box.quad[4] * axis[0] + box.quad[5] * axis[1];
    const dot3 = box.quad[6] * axis[0] + box.quad[7] * axis[1];
    projection[0] = Math.min(dot0, dot1, dot2, dot3);
    projection[1] = Math.max(dot0, dot1, dot2, dot3);
    return projection;
  }

  /** Tests two separating axes for overlap. */
  static axisCollide(first: OBB, second: OBB, axis0: NumericVector, axis1: NumericVector): boolean {
    OBB.projectToAxis(first, axis0, projectionA);
    OBB.projectToAxis(second, axis0, projectionB);
    if (projectionB[0] > projectionA[1] || projectionB[1] < projectionA[0]) {
      return false;
    }

    OBB.projectToAxis(first, axis1, projectionA);
    OBB.projectToAxis(second, axis1, projectionB);
    return !(projectionB[0] > projectionA[1] || projectionB[1] < projectionA[0]);
  }

  /** Tests whether two oriented boxes intersect. */
  static intersect(first: OBB, second: OBB): boolean {
    return OBB.axisCollide(first, second, first.axis_0, first.axis_1) &&
      OBB.axisCollide(first, second, second.axis_0, second.axis_1);
  }
}
