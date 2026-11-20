// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Bounds in the units of a projected coordinate reference system: `[minX, minY, maxX, maxY]`. */
export type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

/** One line of a projected grid. */
export type GridLine = {
  /** `'x'`: a line of constant x (an easting). `'y'`: a line of constant y (a northing). */
  axis: 'x' | 'y';
  /** The constant coordinate of the line. */
  value: number;
  /** Whether the line is on the major step. */
  major: boolean;
  /** The vertices of the line, in projected coordinates. */
  path: [number, number][];
};

/**
 * Returns the grid step for a view scale: the 1, 2 or 5 times a power of ten nearest to
 * `targetPixels` on the screen.
 */
export function getGridStep(unitsPerPixel: number, targetPixels = 120): number {
  const raw = unitsPerPixel * targetPixels;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / magnitude;
  let factor = 10;
  if (fraction < 1.5) {
    factor = 1;
  } else if (fraction < 3.5) {
    factor = 2;
  } else if (fraction < 7.5) {
    factor = 5;
  }
  return factor * magnitude;
}

/** Returns the major step of a grid step: the next power of ten. */
export function getMajorGridStep(step: number): number {
  return 10 ** Math.ceil(Math.log10(step) + 1e-9);
}

/** Moves bounds out to multiples of `cell`. */
export function snapBoundsOut(bounds: Bounds, cell: number): Bounds {
  return [
    Math.floor(bounds[0] / cell) * cell,
    Math.floor(bounds[1] / cell) * cell,
    Math.ceil(bounds[2] / cell) * cell,
    Math.ceil(bounds[3] / cell) * cell
  ];
}

/** Returns the part of `bounds` in `limit`, or `null` when they do not meet. */
export function intersectBounds(bounds: Bounds, limit: Bounds): Bounds | null {
  const result: Bounds = [
    Math.max(bounds[0], limit[0]),
    Math.max(bounds[1], limit[1]),
    Math.min(bounds[2], limit[2]),
    Math.min(bounds[3], limit[3])
  ];
  return result[0] < result[2] && result[1] < result[3] ? result : null;
}

/**
 * Returns the lines of a projected grid in `bounds`. Each line has `segments` segments, so that a
 * view in another projection can draw it as a curve.
 */
export function getGridLines(bounds: Bounds, step: number, segments = 32): GridLine[] {
  const [minX, minY, maxX, maxY] = bounds;
  const majorStep = getMajorGridStep(step);
  const lines: GridLine[] = [];
  const isMajor = (value: number) => {
    const ratio = value / majorStep;
    return Math.abs(ratio - Math.round(ratio)) < 1e-6;
  };
  for (let index = Math.ceil(minX / step); index * step <= maxX; index++) {
    const value = index * step;
    const path: [number, number][] = [];
    for (let segment = 0; segment <= segments; segment++) {
      path.push([value, minY + ((maxY - minY) * segment) / segments]);
    }
    lines.push({axis: 'x', value, major: isMajor(value), path});
  }
  for (let index = Math.ceil(minY / step); index * step <= maxY; index++) {
    const value = index * step;
    const path: [number, number][] = [];
    for (let segment = 0; segment <= segments; segment++) {
      path.push([minX + ((maxX - minX) * segment) / segments, value]);
    }
    lines.push({axis: 'y', value, major: isMajor(value), path});
  }
  return lines;
}

/** Formats a projected coordinate in metres with digit groups: `6 750 000`. */
export function formatGridValue(value: number): string {
  const rounded = Math.round(value);
  const digits = `${Math.abs(rounded)}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return rounded < 0 ? `−${digits}` : digits;
}

/** Formats a distance in metres as metres or kilometres. */
export function formatDistance(metres: number): string {
  return metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
}
