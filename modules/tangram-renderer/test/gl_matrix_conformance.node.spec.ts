// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import legacyMat3Invert from 'gl-mat3/invert';
import legacyMat3NormalFromMat4 from 'gl-mat3/normal-from-mat4';
import legacyMat4Copy from 'gl-mat4/copy';
import legacyMat4Identity from 'gl-mat4/identity';
import legacyMat4LookAt from 'gl-mat4/lookAt';
import legacyMat4Multiply from 'gl-mat4/multiply';
import legacyMat4Perspective from 'gl-mat4/perspective';
import legacyMat4Scale from 'gl-mat4/scale';
import legacyMat4Translate from 'gl-mat4/translate';
import {mat3, mat4, vec3} from '../src/utils/gl-matrix';

describe('math.gl matrix adapter', () => {
  it('preserves identity, copy, multiply, translate and scale output', () => {
    const legacyIdentity = legacyMat4Identity(new Float64Array(16));
    const mathIdentity = mat4.identity(new Float64Array(16));
    expect(Array.from(mathIdentity)).toEqual(Array.from(legacyIdentity));

    const copied = mat4.copy(new Float64Array(16), mathIdentity);
    expect(Array.from(copied)).toEqual(Array.from(legacyMat4Copy(new Float64Array(16), legacyIdentity)));

    const legacyTranslated = legacyMat4Translate(new Float64Array(16), legacyIdentity, [12_000_000, -4_000_000, 32]);
    const mathTranslated = mat4.translate(new Float64Array(16), mathIdentity, [12_000_000, -4_000_000, 32]);
    expect(Array.from(mathTranslated)).toEqual(Array.from(legacyTranslated));

    const legacyScaled = legacyMat4Scale(new Float64Array(16), legacyTranslated, [2, 3, 4]);
    const mathScaled = mat4.scale(new Float64Array(16), mathTranslated, [2, 3, 4]);
    expect(Array.from(mathScaled)).toEqual(Array.from(legacyScaled));

    const legacyProduct = legacyMat4Multiply(new Float64Array(16), legacyScaled, legacyTranslated);
    const mathProduct = mat4.multiply(new Float64Array(16), mathScaled, mathTranslated);
    expect(Array.from(mathProduct)).toEqual(Array.from(legacyProduct));
  });

  it('preserves perspective and look-at matrix outputs', () => {
    const legacyProjection = legacyMat4Perspective(new Float32Array(16), Math.PI / 3, 16 / 9, 1, 10_000_000);
    const mathProjection = mat4.perspective(new Float32Array(16), Math.PI / 3, 16 / 9, 1, 10_000_000);
    expect(Array.from(mathProjection)).toEqual(Array.from(legacyProjection));

    const eye = new Float64Array([12_000_000, -4_000_000, 3000]);
    const center = new Float64Array([12_000_100, -4_000_100, 0]);
    const up = new Float64Array([0, 0, 1]);
    const legacyView = legacyMat4LookAt(new Float64Array(16), eye, center, up);
    const mathView = mat4.lookAt(new Float64Array(16), eye, center, up);
    expect(Array.from(mathView)).toEqual(Array.from(legacyView));
  });

  it('preserves normal matrices and inverse failure behavior', () => {
    const modelView = legacyMat4Translate(new Float64Array(16), legacyMat4Identity(new Float64Array(16)), [4, 5, 6]);
    const legacyNormal = legacyMat3NormalFromMat4(new Float64Array(9), modelView);
    const mathNormal = mat3.normalFromMat4(new Float64Array(9), modelView);
    expect(mathNormal && Array.from(mathNormal)).toEqual(legacyNormal && Array.from(legacyNormal));

    const legacyInverse = legacyMat3Invert(new Float64Array(9), legacyNormal!);
    const mathInverse = mat3.invert(new Float64Array(9), mathNormal!);
    expect(mathInverse && Array.from(mathInverse)).toEqual(legacyInverse && Array.from(legacyInverse));

    const singular = new Float64Array(9);
    expect(mat3.invert(new Float64Array(9), singular)).toBeNull();
    expect(mat3.normalFromMat4(new Float64Array(9), new Float64Array(16))).toBeNull();
  });

  it('keeps vector inputs in double precision', () => {
    const vector = vec3.fromValues(1.25, 2.5, 3.75);
    expect(vector).toBeInstanceOf(Float64Array);
    expect(Array.from(vector)).toEqual([1.25, 2.5, 3.75]);
  });
});
