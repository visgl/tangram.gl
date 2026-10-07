// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Legacy CSS parser dependency; returns byte RGB and normalized alpha, or no match. */
declare module 'csscolorparser' {
    const parser: {parseCSSColor(value: string): [number, number, number, number] | undefined};
    export default parser;
}
