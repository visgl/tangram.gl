// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

declare module '*.glsl' {
    const source: string;
    export default source;
}

/** Vite raw shader assets used by the real-device conformance tests. */
declare module '*.glsl?raw' {
    const source: string;
    export default source;
}
