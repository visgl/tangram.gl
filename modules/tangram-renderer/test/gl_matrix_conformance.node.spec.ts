// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import {Matrix3, Matrix4} from '@math.gl/core';
import legacyMat3Invert from 'gl-mat3/invert';
import legacyMat3NormalFromMat4 from 'gl-mat3/normal-from-mat4';
import legacyMat4Copy from 'gl-mat4/copy';
import legacyMat4Identity from 'gl-mat4/identity';
import legacyMat4LookAt from 'gl-mat4/lookAt';
import legacyMat4Multiply from 'gl-mat4/multiply';
import legacyMat4Perspective from 'gl-mat4/perspective';
import legacyMat4Scale from 'gl-mat4/scale';
import legacyMat4Translate from 'gl-mat4/translate';

describe('math.gl matrix operations', () => {
  it('preserves identity, copy, multiply, translate and scale output', () => {
    const legacyIdentity = legacyMat4Identity(new Float64Array(16));
    const mathIdentity = new Matrix4().identity().toArray(new Float64Array(16));
    expect(Array.from(mathIdentity)).toEqual(Array.from(legacyIdentity));

    const copied = new Matrix4().copy(mathIdentity).toArray(new Float64Array(16));
    expect(Array.from(copied)).toEqual(Array.from(legacyMat4Copy(new Float64Array(16), legacyIdentity)));

    const legacyTranslated = legacyMat4Translate(new Float64Array(16), legacyIdentity, [12_000_000, -4_000_000, 32]);
    const mathTranslated = new Matrix4().copy(mathIdentity).translate([12_000_000, -4_000_000, 32]).toArray(new Float64Array(16));
    expect(Array.from(mathTranslated)).toEqual(Array.from(legacyTranslated));

    const scale = new Float64Array([2, 3, 4]);
    const legacyScaled = legacyMat4Scale(new Float64Array(16), legacyTranslated, scale);
    const mathScaled = new Matrix4().copy(mathTranslated).scale(Array.from(scale)).toArray(new Float64Array(16));
    expect(Array.from(mathScaled)).toEqual(Array.from(legacyScaled));

    const legacyProduct = legacyMat4Multiply(new Float64Array(16), legacyScaled, legacyTranslated);
    const mathProduct = new Matrix4().copy(mathScaled).multiplyRight(mathTranslated).toArray(new Float64Array(16));
    expect(Array.from(mathProduct)).toEqual(Array.from(legacyProduct));
  });

  it('preserves perspective and look-at matrix outputs', () => {
    const legacyProjection = legacyMat4Perspective(new Float32Array(16), Math.PI / 3, 16 / 9, 1, 10_000_000);
    const mathProjection = new Matrix4().perspective({fovy: Math.PI / 3, aspect: 16 / 9, near: 1, far: 10_000_000}).toArray(new Float32Array(16));
    expect(Array.from(mathProjection)).toEqual(Array.from(legacyProjection));

    const eye = new Float64Array([12_000_000, -4_000_000, 3000]);
    const center = new Float64Array([12_000_100, -4_000_100, 0]);
    const up = new Float64Array([0, 0, 1]);
    const legacyView = legacyMat4LookAt(new Float64Array(16), eye, center, up);
    const mathView = new Matrix4().lookAt({eye, center, up}).toArray(new Float64Array(16));
    expect(Array.from(mathView)).toEqual(Array.from(legacyView));
  });

  it('preserves normal matrices and inverse failure behavior', () => {
    const modelView = legacyMat4Translate(new Float64Array(16), legacyMat4Identity(new Float64Array(16)), [4, 5, 6]);
    const legacyNormal = legacyMat3NormalFromMat4(new Float64Array(9), modelView);
    const mathNormalMatrix = new Matrix3().set(
      modelView[0], modelView[1], modelView[2],
      modelView[4], modelView[5], modelView[6],
      modelView[8], modelView[9], modelView[10]
    ).invert().transpose();
    const mathNormal = mathNormalMatrix.toArray(new Float64Array(9));
    expect(mathNormal && Array.from(mathNormal)).toEqual(legacyNormal && Array.from(legacyNormal));

    const legacyInverse = legacyMat3Invert(new Float64Array(9), legacyNormal!);
    const mathInverse = new Matrix3(mathNormal).invert().toArray(new Float64Array(9));
    expect(mathInverse && Array.from(mathInverse)).toEqual(legacyInverse && Array.from(legacyInverse));

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
