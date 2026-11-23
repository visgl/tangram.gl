// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Marching squares to closed, oriented polygon rings, and small geometry helpers.

export type Ring = [number, number][];

/**
 * The rings of the region `values > threshold` of a grid of `nx` by `ny` samples (row-major,
 * y down). The grid is padded with an outside value, so every ring closes; rings that meet the
 * grid edge run along it. Each ring has the inside on its right in y-down coordinates: exterior
 * rings are clockwise on screen (positive area, as Mapbox Vector Tiles want), holes are not.
 * Coordinates are in sample units: sample (i, j) is at (i, j).
 */
export function contourRings(values: Float32Array, nx: number, ny: number, threshold: number): Ring[] {
  const px = nx + 2;
  const py = ny + 2;
  const OUT = threshold - 1e6;
  const v = new Float64Array(px * py).fill(OUT);
  let any = false;
  let all = true;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const value = values[j * nx + i];
      v[(j + 1) * px + i + 1] = value;
      if (value > threshold) any = true;
      else all = false;
    }
  if (!any) return [];
  if (all) {
    return [
      [
        [0, 0],
        [nx - 1, 0],
        [nx - 1, ny - 1],
        [0, ny - 1]
      ]
    ];
  }
  // Edge ids: horizontal edge from (i, j) to (i + 1, j) is 2 * (j * px + i); vertical edge from
  // (i, j) to (i, j + 1) is 2 * (j * px + i) + 1.
  const point = (edge: number): [number, number] => {
    const base = edge >> 1;
    const i = base % px;
    const j = (base - i) / px;
    const a = v[base];
    const b = (edge & 1) === 0 ? v[base + 1] : v[base + px];
    let t = (threshold - a) / (b - a);
    if (!(t >= 0)) t = 0;
    if (t > 1) t = 1;
    return (edge & 1) === 0 ? [i + t - 1, j - 1] : [i - 1, j + t - 1];
  };
  const next = new Map<number, number>();
  for (let j = 0; j < py - 1; j++) {
    for (let i = 0; i < px - 1; i++) {
      const k = j * px + i;
      const c = [v[k], v[k + 1], v[k + px + 1], v[k + px]];
      const inside = c.map(value => value > threshold);
      const count = inside.filter(Boolean).length;
      if (count === 0 || count === 4) continue;
      // Corners clockwise: top-left, top-right, bottom-right, bottom-left; edge e goes from corner
      // e to corner e + 1.
      const edges = [2 * k, 2 * (k + 1) + 1, 2 * (k + px), 2 * k + 1];
      const crossings: Array<{edge: number; out: boolean}> = [];
      for (let e = 0; e < 4; e++) {
        const a = inside[e];
        const b = inside[(e + 1) % 4];
        if (a !== b) crossings.push({edge: edges[e], out: a});
      }
      const joined = count === 2 && crossings.length === 4 && (c[0] + c[1] + c[2] + c[3]) / 4 > threshold;
      for (let n = 0; n < crossings.length; n++) {
        if (!crossings[n].out) continue;
        const partner = joined
          ? crossings[(n + 1) % crossings.length]
          : crossings[(n - 1 + crossings.length) % crossings.length];
        next.set(crossings[n].edge, partner.edge);
      }
    }
  }
  const rings: Ring[] = [];
  const used = new Set<number>();
  for (const startEdge of next.keys()) {
    if (used.has(startEdge)) continue;
    const ring: Ring = [];
    let edge = startEdge;
    while (!used.has(edge)) {
      used.add(edge);
      ring.push(point(edge));
      const following = next.get(edge);
      if (following === undefined) break;
      edge = following;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

export function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas-Peucker simplification of an open or closed line. */
export function simplify(points: Ring, tolerance: number): Ring {
  if (points.length <= 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = points[i];
      let d2: number;
      if (len2 === 0) d2 = (x - ax) ** 2 + (y - ay) ** 2;
      else {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        d2 = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
      }
      if (d2 > maxD) {
        maxD = d2;
        maxI = i;
      }
    }
    if (maxD > tol2) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Sutherland-Hodgman clip of a ring to an axis-aligned box. */
export function clipRing(ring: Ring, min: number, max: number): Ring {
  let out = ring;
  for (let axis = 0; axis < 2; axis++) {
    for (const [bound, keepBelow] of [
      [min, false],
      [max, true]
    ] as const) {
      const input = out;
      out = [];
      for (let i = 0; i < input.length; i++) {
        const p = input[i];
        const q = input[(i + 1) % input.length];
        const pIn = keepBelow ? p[axis] <= bound : p[axis] >= bound;
        const qIn = keepBelow ? q[axis] <= bound : q[axis] >= bound;
        if (pIn) out.push(p);
        if (pIn !== qIn) {
          const t = (bound - p[axis]) / (q[axis] - p[axis]);
          const r: [number, number] = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
          r[axis] = bound;
          out.push(r);
        }
      }
      if (!out.length) return out;
    }
  }
  return out;
}

/** Clips a polyline to an axis-aligned box; returns the pieces inside (Liang-Barsky per segment). */
export function clipLine(line: Ring, min: number, max: number): Ring[] {
  const pieces: Ring[] = [];
  let current: Ring = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [x0, y0] = line[i];
    const [x1, y1] = line[i + 1];
    let t0 = 0;
    let t1 = 1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    let visible = true;
    for (const [p, q] of [
      [-dx, x0 - min],
      [dx, max - x0],
      [-dy, y0 - min],
      [dy, max - y0]
    ]) {
      if (p === 0) {
        if (q < 0) visible = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!visible || t0 > t1) {
      if (current.length > 1) pieces.push(current);
      current = [];
      continue;
    }
    const a: [number, number] = [x0 + t0 * dx, y0 + t0 * dy];
    const b: [number, number] = [x0 + t1 * dx, y0 + t1 * dy];
    if (!current.length) current.push(a);
    current.push(b);
    if (t1 < 1) {
      pieces.push(current);
      current = [];
    }
  }
  if (current.length > 1) pieces.push(current);
  return pieces;
}

/**
 * Groups rings into polygons, as Mapbox Vector Tiles want them: each exterior ring (positive
 * area) followed by the holes inside it.
 */
export function groupRings(rings: Ring[]): Ring[][] {
  const exteriors: Array<{ring: Ring; area: number; holes: Ring[]}> = [];
  const holes: Ring[] = [];
  for (const ring of rings) {
    const area = signedArea(ring);
    if (area > 0) exteriors.push({ring, area, holes: []});
    else if (area < 0) holes.push(ring);
  }
  for (const hole of holes) {
    const x = (hole[0][0] + hole[1][0]) / 2;
    const y = (hole[0][1] + hole[1][1]) / 2;
    let best: (typeof exteriors)[number] | null = null;
    for (const exterior of exteriors) {
      if ((!best || exterior.area < best.area) && pointInRing(x, y, exterior.ring)) best = exterior;
    }
    best?.holes.push(hole);
  }
  return exteriors.map(e => [e.ring, ...e.holes]);
}
