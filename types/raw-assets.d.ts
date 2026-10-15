// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Vite's raw asset imports expose emitted JavaScript bytes without transforming them. */
declare module '*.js?raw' {
  const source: string;
  export default source;
}
