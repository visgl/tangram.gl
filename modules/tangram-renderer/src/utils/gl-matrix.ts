// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// Compatibility-shaped math.gl adapter. The public helper names and mutation
// behavior stay the same while matrix calculations move to typed math.gl APIs.

import {Matrix3, Matrix4} from '@math.gl/core';

type NumericMatrix = Float32Array | Float64Array;
type NumericVector = number[] | Float32Array | Float64Array;

const matrix3Cache = new WeakMap<NumericMatrix, Matrix3>();
const matrix4Cache = new WeakMap<NumericMatrix, Matrix4>();

/** Create or retrieve the math.gl matrix associated with an output array. */
function getMatrix3(output: NumericMatrix): Matrix3 {
  let matrix = matrix3Cache.get(output);
  if (!matrix) {
    matrix = new Matrix3();
    matrix3Cache.set(output, matrix);
  }
  return matrix;
}

/** Create or retrieve the math.gl matrix associated with an output array. */
function getMatrix4(output: NumericMatrix): Matrix4 {
  let matrix = matrix4Cache.get(output);
  if (!matrix) {
    matrix = new Matrix4();
    matrix4Cache.set(output, matrix);
  }
  return matrix;
}

/** Copy a math.gl matrix into Tangram's caller-owned typed array. */
function writeMatrix(output: NumericMatrix, matrix: Matrix3 | Matrix4): NumericMatrix {
  matrix.toArray(output);
  return output;
}

/** High-precision vector operations used by the renderer. */
const vec3 = {
  /** Create a high-precision three-component vector. */
  fromValues(x: number, y: number, z: number): Float64Array {
    return new Float64Array([x, y, z]);
  }
};

/** Matrix operations with the legacy gl-mat call signatures. */
const mat3 = {
  /** Compute the inverse-transpose 3x3 normal matrix from a 4x4 matrix. */
  normalFromMat4(output: NumericMatrix, input: NumericVector): NumericMatrix | null {
    const matrix = getMatrix3(output).set(
      input[0], input[1], input[2],
      input[4], input[5], input[6],
      input[8], input[9], input[10]
    );
    const determinant = matrix.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) {
      return null;
    }
    return writeMatrix(output, matrix.invert().transpose());
  },

  /** Invert a 3x3 matrix into the caller-provided output array. */
  invert(output: NumericMatrix, input: NumericVector): NumericMatrix | null {
    const matrix = getMatrix3(output).copy(input);
    const determinant = matrix.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) {
      return null;
    }
    return writeMatrix(output, matrix.invert());
  }
};

/** Matrix operations with the legacy gl-mat call signatures. */
const mat4 = {
  /** Multiply two 4x4 matrices and write the result to the output array. */
  multiply(output: NumericMatrix, left: NumericVector, right: NumericVector): NumericMatrix {
    const matrix = getMatrix4(output).copy(left).multiplyRight(right);
    return writeMatrix(output, matrix);
  },

  /** Translate a 4x4 matrix by a three-component vector. */
  translate(output: NumericMatrix, input: NumericVector, vector: NumericVector): NumericMatrix {
    const matrix = getMatrix4(output).copy(input).translate(vector);
    return writeMatrix(output, matrix);
  },

  /** Scale a 4x4 matrix by a three-component vector. */
  scale(output: NumericMatrix, input: NumericVector, vector: NumericVector): NumericMatrix {
    const matrix = getMatrix4(output).copy(input).scale(vector);
    return writeMatrix(output, matrix);
  },

  /** Build a perspective projection matrix from the legacy positional arguments. */
  perspective(
    output: NumericMatrix,
    fieldOfView: number,
    aspect: number,
    near: number,
    far: number
  ): NumericMatrix {
    const matrix = getMatrix4(output).perspective({
      fovy: fieldOfView,
      aspect,
      near,
      far
    });
    return writeMatrix(output, matrix);
  },

  /** Build a look-at view matrix from eye, center, and up vectors. */
  lookAt(
    output: NumericMatrix,
    eye: NumericVector,
    center: NumericVector,
    up: NumericVector
  ): NumericMatrix {
    const matrix = getMatrix4(output).lookAt({eye, center, up});
    return writeMatrix(output, matrix);
  },

  /** Set a 4x4 matrix to identity. */
  identity(output: NumericMatrix): NumericMatrix {
    return writeMatrix(output, getMatrix4(output).identity());
  },

  /** Copy a 4x4 matrix into the caller-provided output array. */
  copy(output: NumericMatrix, input: NumericVector): NumericMatrix {
    for (let index = 0; index < 16; index++) {
      output[index] = input[index];
    }
    return output;
  }
};

/** High-precision vector and matrix operations used by the renderer. */
export {vec3, mat3, mat4};
