// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** The part of pngjs that the sprite script and its test use. */
declare module 'pngjs' {
  export class PNG {
    constructor(options?: {width?: number; height?: number});
    width: number;
    height: number;
    data: Uint8Array;
    static sync: {
      read(buffer: Uint8Array): PNG;
      write(png: PNG, options?: {colorType?: number}): Uint8Array;
    };
  }
}
