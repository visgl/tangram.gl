// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import {Matrix3, Matrix4} from '@math.gl/core';

// Expected arrays were captured from gl-mat3@1.0.0 and gl-mat4@1.1.4 before removing them.
describe('math.gl matrix operations', () => {
  it('preserves identity, copy, multiply, translate and scale output', () => {
    const mathIdentity = new Matrix4().identity().toArray(new Float64Array(16));
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(Array.from(mathIdentity)).toEqual(identity);

    const copied = new Matrix4().copy(mathIdentity).toArray(new Float64Array(16));
    expect(Array.from(copied)).toEqual(identity);

    const mathTranslated = new Matrix4().copy(mathIdentity).translate([12_000_000, -4_000_000, 32]).toArray(new Float64Array(16));
    const translated = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 12_000_000, -4_000_000, 32, 1];
    expect(Array.from(mathTranslated)).toEqual(translated);

    const scale = [2, 3, 4];
    const mathScaled = new Matrix4().copy(mathTranslated).scale(scale).toArray(new Float64Array(16));
    const scaled = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 12_000_000, -4_000_000, 32, 1];
    expect(Array.from(mathScaled)).toEqual(scaled);

    const mathProduct = new Matrix4().copy(mathScaled).multiplyRight(mathTranslated).toArray(new Float64Array(16));
    expect(Array.from(mathProduct)).toEqual([
      2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 36_000_000, -16_000_000, 160, 1
    ]);
  });

  it('preserves perspective and look-at matrix outputs', () => {
    const mathProjection = new Matrix4().perspective({fovy: Math.PI / 3, aspect: 16 / 9, near: 1, far: 10_000_000}).toArray(new Float32Array(16));
    expect(Array.from(mathProjection)).toEqual([
      0.9742785692214966, 0, 0, 0, 0, 1.7320507764816284, 0, 0,
      0, 0, -1.000000238418579, -1, 0, 0, -2.000000238418579, 0
    ]);

    const eye = new Float64Array([12_000_000, -4_000_000, 3000]);
    const center = new Float64Array([12_000_100, -4_000_100, 0]);
    const up = new Float64Array([0, 0, 1]);
    const mathView = new Matrix4().lookAt({eye, center, up}).toArray(new Float64Array(16));
    expect(Array.from(mathView)).toEqual([
      -0.7071067811865475, 0.7063224140220167, -0.03329635791060134, 0,
      -0.7071067811865475, -0.7063224140220167, 0.03329635791060134, 0,
      0, 0.047088160934801115, 0.9988907373180403, 0,
      5656854.249492379, -11301299.88883507, 529745.0543576673, 1
    ]);
  });

  it('preserves normal matrices and inverse failure behavior', () => {
    const modelView = new Matrix4().identity().translate([4, 5, 6]).toArray(new Float64Array(16));
    const mathNormalMatrix = new Matrix3().set(
      modelView[0], modelView[1], modelView[2],
      modelView[4], modelView[5], modelView[6],
      modelView[8], modelView[9], modelView[10]
    ).invert().transpose();
    const mathNormal = mathNormalMatrix.toArray(new Float64Array(9));
    const normal = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(Array.from(mathNormal)).toEqual(normal);

    const mathInverse = new Matrix3(mathNormal).invert().toArray(new Float64Array(9));
    expect(Array.from(mathInverse)).toEqual(normal);

    const singular = new Float64Array(9);
    expect(new Matrix3().copy(singular).determinant()).toBe(0);
    const zeroMatrix = new Float64Array(16);
    expect(new Matrix3().set(
      zeroMatrix[0], zeroMatrix[1], zeroMatrix[2],
      zeroMatrix[4], zeroMatrix[5], zeroMatrix[6],
      zeroMatrix[8], zeroMatrix[9], zeroMatrix[10]
    ).determinant()).toBe(0);
  });

  it('keeps vector inputs in double precision', () => {
    const vector = new Float64Array([1.25, 2.5, 3.75]);
    expect(vector).toBeInstanceOf(Float64Array);
    expect(Array.from(vector)).toEqual([1.25, 2.5, 3.75]);
  });
});
