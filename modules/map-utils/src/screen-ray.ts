// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** A top-origin viewport in the same screen units as the input pixel. */
export type ScreenViewport = {
  /** Left edge, defaulting to zero. */
  x?: number;
  /** Top edge, defaulting to zero. */
  y?: number;
  /** Horizontal span. */
  width: number;
  /** Vertical span. */
  height: number;
};

/** Test a finite pixel against a half-open viewport. */
export function containsScreenPixel(
  viewport: ScreenViewport,
  pixel: readonly [number, number]
): boolean {
  const {x = 0, y = 0, width, height} = viewport;
  return pixel.length === 2 && pixel.every(Number.isFinite) &&
    [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 &&
    pixel[0] >= x && pixel[1] >= y && pixel[0] < x + width && pixel[1] < y + height;
}
