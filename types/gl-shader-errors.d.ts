// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Exact diagnostics returned by the legacy compiler-log parser. */
declare module 'gl-shader-errors' {
    export default function parseShaderErrors(log: string | null): {message: string; file: number; line: number}[];
}
