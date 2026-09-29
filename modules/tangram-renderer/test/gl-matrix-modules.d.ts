// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

type TangramGlMatrixOutput = Float32Array | Float64Array;
type TangramGlMatrixInput = number[] | Float32Array | Float64Array;

declare module 'gl-mat3/normal-from-mat4' {
  function normalFromMat4(
    output: TangramGlMatrixOutput,
    input: TangramGlMatrixInput
  ): TangramGlMatrixOutput | null;
  export default normalFromMat4;
}

declare module 'gl-mat3/invert' {
  function invert(
    output: TangramGlMatrixOutput,
    input: TangramGlMatrixInput
  ): TangramGlMatrixOutput | null;
  export default invert;
}

declare module 'gl-mat4/multiply' {
  function multiply(
    output: TangramGlMatrixOutput,
    left: TangramGlMatrixInput,
    right: TangramGlMatrixInput
  ): TangramGlMatrixOutput;
  export default multiply;
}

declare module 'gl-mat4/translate' {
  function translate(
    output: TangramGlMatrixOutput,
    input: TangramGlMatrixInput,
    vector: TangramGlMatrixInput
  ): TangramGlMatrixOutput;
  export default translate;
}

declare module 'gl-mat4/scale' {
  function scale(
    output: TangramGlMatrixOutput,
    input: TangramGlMatrixInput,
    vector: TangramGlMatrixInput
  ): TangramGlMatrixOutput;
  export default scale;
}

declare module 'gl-mat4/perspective' {
  function perspective(
    output: TangramGlMatrixOutput,
    fieldOfView: number,
    aspect: number,
    near: number,
    far: number
  ): TangramGlMatrixOutput;
  export default perspective;
}

declare module 'gl-mat4/lookAt' {
  function lookAt(
    output: TangramGlMatrixOutput,
    eye: TangramGlMatrixInput,
    center: TangramGlMatrixInput,
    up: TangramGlMatrixInput
  ): TangramGlMatrixOutput;
  export default lookAt;
}

declare module 'gl-mat4/identity' {
  function identity(output: TangramGlMatrixOutput): TangramGlMatrixOutput;
  export default identity;
}

declare module 'gl-mat4/copy' {
  function copy(output: TangramGlMatrixOutput, input: TangramGlMatrixInput): TangramGlMatrixOutput;
  export default copy;
}
