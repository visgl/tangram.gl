// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The coarse whole-world grid of one seed and sea level: elevation with erosion,
// moisture, temperature, flow accumulation and rivers, closed basins and lakes, towns, peaks
// and sea names. Computed once per (seed, sea level); tiles sample it.

import {makeName, NAME_KIND} from './names';
import {hashInts, mulberry32} from './noise';
import {
  TERRAIN,
  coarseElevation,
  coarseMoisture,
  coarseTemperatureNoise,
  createWorldNoise,
  detailElevation,
  temperatureAt,
  toNoise,
  type WorldNoise
} from './terrain';

export type WorldOptions = {seed: number; seaLevel?: number};

export type River = {
  /** [lon, lat] from source to mouth; lon is unwrapped (may pass +-180). */
  points: [number, number][];
  /** The flow accumulation at each point. */
  flow: number[];
  name?: string;
  maxFlow: number;
};

export type PlaceClass = 'city' | 'town' | 'village';
export type Town = {lon: number; lat: number; name: string; class: PlaceClass; rank: number};
export type Peak = {lon: number; lat: number; name: string; ele: number; rank: number};
export type WaterName = {lon: number; lat: number; name: string; class: 'ocean' | 'sea' | 'lake'};

export type World = {
  seed: number;
  /** The sea level offset given, and the absolute threshold on the elevation. */
  seaLevelOffset: number;
  seaLevel: number;
  noise: WorldNoise;
  width: number;
  height: number;
  /** Eroded elevation, moisture (0..1), temperature noise, lake mask (0/1). Row-major, north first. */
  elevation: Float32Array;
  moisture: Float32Array;
  temperatureNoise: Float32Array;
  lake: Float32Array;
  flow: Float32Array;
  riverThreshold: number;
  rivers: River[];
  towns: Town[];
  peaks: Peak[];
  waterNames: WaterName[];
  /** Milliseconds to build. */
  buildMs: number;
};

const W = TERRAIN.GRID_W;
const H = TERRAIN.GRID_H;
const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [-1, 1],
  [1, -1]
];

export const cellLon = (i: number) => -180 + ((i + 0.5) * 360) / W;
export const cellLat = (j: number) => 90 - ((j + 0.5) * 180) / H;
const wrapX = (i: number) => ((i % W) + W) % W;

/** Bilinear sample of a coarse grid at a longitude and latitude; wraps in x. */
export function sampleGrid(grid: Float32Array, lon: number, lat: number): number {
  const gx = ((lon + 180) / 360) * W - 0.5;
  const gy = Math.min(H - 1, Math.max(0, ((90 - lat) / 180) * H - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.min(H - 2, Math.floor(gy));
  const fx = gx - x0;
  const fy = gy - y0;
  const xa = wrapX(x0);
  const xb = wrapX(x0 + 1);
  const r0 = y0 * W;
  const r1 = r0 + W;
  const top = grid[r0 + xa] * (1 - fx) + grid[r0 + xb] * fx;
  const bottom = grid[r1 + xa] * (1 - fx) + grid[r1 + xb] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** The full-detail elevation at a point, minus the sea level: > 0 is land. */
export function heightAt(world: World, lon: number, lat: number): number {
  const [x, y] = toNoise(lon, lat);
  return sampleGrid(world.elevation, lon, lat) + detailElevation(world.noise, x, y) - world.seaLevel;
}

/** Thermal erosion, with x wrapping around the world. */
function applyErosion(elevation: Float32Array, hilliness: number): Float32Array {
  const eroded = Float32Array.from(elevation);
  const iterations = Math.floor(3 + hilliness * 5);
  for (let iter = 0; iter < iterations; iter++) {
    for (let y = 1; y < H - 1; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const up = eroded[i - W];
        const down = eroded[i + W];
        const left = eroded[y * W + wrapX(x - 1)];
        const right = eroded[y * W + wrapX(x + 1)];
        const current = eroded[i];
        const avg = (up + down + left + right) / 4;
        if (current > avg) {
          const erosion = Math.min(0.1, (current - avg) * 0.3);
          eroded[i] -= erosion;
          const lowest = Math.min(up, down, left, right);
          const dy = up === lowest ? -1 : down === lowest ? 1 : 0;
          const dx = left === lowest ? -1 : right === lowest ? 1 : 0;
          eroded[(y + dy) * W + wrapX(x + dx)] += erosion * 0.8;
        }
      }
    }
  }
  return eroded;
}

/** A binary min-heap of cell indices by value (for the priority-flood fill). */
class MinHeap {
  private idx: Int32Array;
  private val: Float64Array;
  private size = 0;
  constructor(capacity: number) {
    this.idx = new Int32Array(capacity);
    this.val = new Float64Array(capacity);
  }
  get length() {
    return this.size;
  }
  push(i: number, v: number) {
    let k = this.size++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (this.val[p] < v || (this.val[p] === v && this.idx[p] < i)) break;
      this.idx[k] = this.idx[p];
      this.val[k] = this.val[p];
      k = p;
    }
    this.idx[k] = i;
    this.val[k] = v;
  }
  pop(): number {
    const top = this.idx[0];
    const lastI = this.idx[--this.size];
    const lastV = this.val[this.size];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= this.size) break;
      if (
        c + 1 < this.size &&
        (this.val[c + 1] < this.val[c] || (this.val[c + 1] === this.val[c] && this.idx[c + 1] < this.idx[c]))
      )
        c++;
      if (lastV < this.val[c] || (lastV === this.val[c] && lastI < this.idx[c])) break;
      this.idx[k] = this.idx[c];
      this.val[k] = this.val[c];
      k = c;
    }
    this.idx[k] = lastI;
    this.val[k] = lastV;
    return top;
  }
}

function forNeighbors(i: number, fn: (n: number) => void) {
  const x = i % W;
  const y = (i - x) / W;
  for (const [dx, dy] of DIRS) {
    const ny = y + dy;
    if (ny < 0 || ny >= H) continue;
    fn(ny * W + wrapX(x + dx));
  }
}

/** Builds the coarse world of a seed and a sea level offset (in elevation units). */
export function buildWorld({seed, seaLevel: seaLevelOffset = 0}: WorldOptions): World {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const noise = createWorldNoise(seed);
  const N = W * H;
  const raw = new Float32Array(N);
  const moisture = new Float32Array(N);
  const temperatureNoise = new Float32Array(N);
  for (let j = 0; j < H; j++) {
    const lat = cellLat(j);
    for (let i = 0; i < W; i++) {
      const [x, y] = toNoise(cellLon(i), lat);
      const k = j * W + i;
      raw[k] = coarseElevation(noise, x, y);
      moisture[k] = Math.min(1, Math.max(0, 0.5 + 0.8 * coarseMoisture(noise, x, y)));
      temperatureNoise[k] = coarseTemperatureNoise(noise, x, y);
    }
  }
  const elevation = applyErosion(raw, TERRAIN.HILLINESS);

  // Sea level: 62% of the cells are below it at offset 0.
  const sorted = Float32Array.from(elevation).sort();
  const seaLevel = sorted[Math.floor(N * 0.62)] + seaLevelOffset;
  const isSea = new Uint8Array(N);
  for (let k = 0; k < N; k++) isSea[k] = elevation[k] < seaLevel ? 1 : 0;

  // Priority-flood depression filling from the sea; the filled surface drains.
  const filled = Float64Array.from(elevation);
  const done = new Uint8Array(N);
  const heap = new MinHeap(N);
  for (let k = 0; k < N; k++) {
    if (isSea[k]) {
      heap.push(k, elevation[k]);
      done[k] = 1;
    }
  }
  if (heap.length === 0) {
    heap.push(0, elevation[0]);
    done[0] = 1;
  }
  const EPS = 1e-5;
  while (heap.length) {
    const c = heap.pop();
    forNeighbors(c, n => {
      if (done[n]) return;
      done[n] = 1;
      filled[n] = Math.max(elevation[n], filled[c] + EPS);
      heap.push(n, filled[n]);
    });
  }

  // Lakes: closed basins deeper than LAKE_DEPTH, of at least LAKE_MIN_CELLS cells.
  const LAKE_DEPTH = 0.012;
  const LAKE_MIN_CELLS = 3;
  const lake = new Float32Array(N);
  const lakeComponent = new Int32Array(N).fill(-1);
  const lakeComponents: number[][] = [];
  for (let k = 0; k < N; k++) {
    if (isSea[k] || lakeComponent[k] >= 0 || filled[k] - elevation[k] < LAKE_DEPTH) continue;
    const cells = [k];
    lakeComponent[k] = lakeComponents.length;
    for (let q = 0; q < cells.length; q++) {
      forNeighbors(cells[q], n => {
        if (!isSea[n] && lakeComponent[n] < 0 && filled[n] - elevation[n] >= LAKE_DEPTH) {
          lakeComponent[n] = lakeComponents.length;
          cells.push(n);
        }
      });
    }
    lakeComponents.push(cells);
    if (cells.length >= LAKE_MIN_CELLS) for (const c of cells) lake[c] = 1;
  }

  // Flow accumulation: cells from the highest, each gives 1 + its flow to its lowest
  // neighbor. Here on the filled surface, so that the flow crosses lakes to the sea.
  const order = new Int32Array(N);
  for (let k = 0; k < N; k++) order[k] = k;
  order.sort((a, b) => filled[b] - filled[a] || a - b);
  const flow = new Float32Array(N);
  const receiver = new Int32Array(N).fill(-1);
  for (const c of order) {
    let lowest = filled[c];
    let r = -1;
    forNeighbors(c, n => {
      if (filled[n] < lowest) {
        lowest = filled[n];
        r = n;
      }
    });
    receiver[c] = r;
    if (r >= 0 && !isSea[c]) flow[r] += 1 + flow[c];
  }

  const riverThreshold = 16;
  const isRiver = (k: number) => !isSea[k] && !lake[k] && flow[k] >= riverThreshold;
  const rivers = traceRivers(isSea, lake, flow, receiver, isRiver, riverThreshold);
  const rng = mulberry32(hashInts(seed, 77));
  rivers.sort((a, b) => b.maxFlow - a.maxFlow || a.points[0][0] - b.points[0][0]);
  let riverNames = 0;
  for (const river of rivers) {
    if (river.points.length >= 10 && riverNames < 120) {
      river.name = makeName(seed, NAME_KIND.river, riverNames++);
    }
  }

  const world: World = {
    seed,
    seaLevelOffset,
    seaLevel,
    noise,
    width: W,
    height: H,
    elevation,
    moisture,
    temperatureNoise,
    lake,
    flow,
    riverThreshold,
    rivers,
    towns: [],
    peaks: [],
    waterNames: [],
    buildMs: 0
  };
  world.towns = placeTowns(world, isSea, isRiver, rng);
  world.peaks = placePeaks(world, isSea);
  world.waterNames = placeWaterNames(world, isSea, lakeComponents);
  world.buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
  return world;
}

/** Traces rivers upstream from each mouth, along the largest inflow */
function traceRivers(
  isSea: Uint8Array,
  lake: Float32Array,
  flow: Float32Array,
  receiver: Int32Array,
  isRiver: (k: number) => boolean,
  threshold: number
): River[] {
  const N = W * H;
  const upstream: number[][] = Array.from({length: N}, () => []);
  for (let k = 0; k < N; k++) {
    const r = receiver[k];
    if (r >= 0 && !isSea[k] && flow[k] >= threshold) upstream[r].push(k);
  }
  for (const list of upstream) list.sort((a, b) => flow[b] - flow[a] || a - b);

  const stack: Array<[number, number]> = [];
  for (let k = 0; k < N; k++) {
    if (!isRiver(k)) continue;
    const r = receiver[k];
    if (r < 0 || isSea[r] || lake[r]) stack.push([k, r]);
  }
  const rivers: River[] = [];
  while (stack.length) {
    const [mouth, below] = stack.pop()!;
    const cells = below >= 0 ? [below, mouth] : [mouth];
    let c = mouth;
    for (;;) {
      const ups = upstream[c].filter(n => isRiver(n) || lake[n]);
      if (!ups.length) break;
      for (let u = 1; u < ups.length; u++) if (isRiver(ups[u])) stack.push([ups[u], c]);
      const main = ups[0];
      cells.push(main);
      if (lake[main]) break;
      c = main;
    }
    if (cells.length < 3) continue;
    cells.reverse();
    const points: [number, number][] = [];
    const flows: number[] = [];
    let prevLon = 0;
    for (const k of cells) {
      const i = k % W;
      let lon = cellLon(i);
      if (points.length) {
        while (lon - prevLon > 180) lon -= 360;
        while (lon - prevLon < -180) lon += 360;
      }
      prevLon = lon;
      points.push([lon, cellLat((k - i) / W)]);
      flows.push(flow[k]);
    }
    const smooth = chaikin(points, flows, 2);
    rivers.push({...smooth, maxFlow: Math.max(...flows)});
  }
  return rivers;
}

/** Chaikin corner cutting, keeping the end points. */
function chaikin(points: [number, number][], flow: number[], iterations: number) {
  let p = points;
  let f = flow;
  for (let it = 0; it < iterations; it++) {
    const np: [number, number][] = [p[0]];
    const nf = [f[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, ay] = p[i];
      const [bx, by] = p[i + 1];
      np.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
      nf.push(f[i], f[i + 1]);
    }
    np.push(p[p.length - 1]);
    nf.push(f[f.length - 1]);
    p = np;
    f = nf;
  }
  return {points: p, flow: f};
}

function cellDistance(a: number, b: number): number {
  const ax = a % W;
  const bx = b % W;
  let dx = Math.abs(ax - bx);
  dx = Math.min(dx, W - dx);
  const dy = Math.abs((a - ax) / W - (b - bx) / W);
  return Math.max(dx, dy);
}

/** Towns at good river, lake and coast cells, spaced apart */
function placeTowns(
  world: World,
  isSea: Uint8Array,
  isRiver: (k: number) => boolean,
  rng: () => number
): Town[] {
  const N = W * H;
  const {elevation, lake, flow, moisture, temperatureNoise, seaLevel} = world;
  const candidates: Array<{k: number; score: number}> = [];
  for (let k = 0; k < N; k++) {
    if (isSea[k] || lake[k]) continue;
    const j = Math.floor(k / W);
    const lat = cellLat(j);
    if (Math.abs(lat) > 72) continue;
    let coast = 0;
    let lakeside = 0;
    forNeighbors(k, n => {
      if (isSea[n]) coast = 1;
      if (lake[n]) lakeside = 1;
    });
    const h = elevation[k] - seaLevel;
    const t = temperatureAt(lat, h, temperatureNoise[k]);
    const river = isRiver(k) ? Math.min(1, Math.log(flow[k]) / Math.log(world.riverThreshold * 40)) : 0;
    const score =
      1.2 * river +
      0.8 * coast +
      0.6 * lakeside +
      0.6 * (1 - Math.min(1, Math.abs(t - 0.25) * 2)) +
      0.3 * moisture[k] -
      2.5 * h +
      0.35 * rng();
    if (score > 0.9 && (river || coast || lakeside)) candidates.push({k, score});
  }
  candidates.sort((a, b) => b.score - a.score || a.k - b.k);
  const chosen: number[] = [];
  const towns: Town[] = [];
  for (const {k} of candidates) {
    if (towns.length >= 420) break;
    if (chosen.some(c => cellDistance(c, k) < 6)) continue;
    const i = k % W;
    const lon0 = cellLon(i);
    const lat0 = cellLat((k - i) / W);
    // Move the site to land of the full-detail coast, if the cell center is in the sea.
    let site: [number, number] | null = null;
    const step = 360 / W;
    for (const [dx, dy] of [[0, 0], ...DIRS.map(([a, b]) => [a * 0.3, b * 0.3]), ...DIRS.map(([a, b]) => [a * 0.6, b * 0.6])]) {
      const lon = lon0 + dx * step;
      const lat = lat0 - dy * step;
      if (heightAt(world, lon, lat) > 0.004) {
        site = [lon, lat];
        break;
      }
    }
    if (!site) continue;
    chosen.push(k);
    towns.push({lon: site[0], lat: site[1], name: '', class: 'village', rank: 0});
  }
  towns.forEach((town, index) => {
    town.name = makeName(world.seed, NAME_KIND.town, index);
    town.class = index < towns.length * 0.07 ? 'city' : index < towns.length * 0.3 ? 'town' : 'village';
    town.rank = index;
  });
  return towns;
}

/** Named peaks at local maxima of the coarse elevation */
function placePeaks(world: World, isSea: Uint8Array): Peak[] {
  const {elevation, seaLevel} = world;
  const top = 1 - seaLevel;
  const candidates: Array<{k: number; h: number}> = [];
  for (let j = 4; j < H - 4; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const h = (elevation[k] - seaLevel) / top;
      if (isSea[k] || h < 0.35) continue;
      let isMax = true;
      for (let dy = -4; dy <= 4 && isMax; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          if ((dx || dy) && elevation[(j + dy) * W + wrapX(i + dx)] > elevation[k]) {
            isMax = false;
            break;
          }
        }
      if (isMax) candidates.push({k, h});
    }
  }
  candidates.sort((a, b) => b.h - a.h || a.k - b.k);
  const peaks: Peak[] = [];
  const chosen: number[] = [];
  for (const {k, h} of candidates) {
    if (peaks.length >= 90) break;
    if (chosen.some(c => cellDistance(c, k) < 9)) continue;
    chosen.push(k);
    const i = k % W;
    const name = makeName(world.seed, NAME_KIND.peak, peaks.length);
    peaks.push({
      lon: cellLon(i),
      lat: cellLat((k - i) / W),
      name: peaks.length % 3 === 0 ? `${name} Peak` : `Mount ${name}`,
      ele: Math.round((800 + h * 5200) / 10) * 10,
      rank: peaks.length
    });
  }
  return peaks;
}

/** Ocean and sea names at the sea cells farthest from land; lake names */
function placeWaterNames(world: World, isSea: Uint8Array, lakeComponents: number[][]): WaterName[] {
  const N = W * H;
  const dist = new Int32Array(N).fill(-1);
  const queue: number[] = [];
  for (let k = 0; k < N; k++) {
    if (!isSea[k]) {
      dist[k] = 0;
      queue.push(k);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q];
    forNeighbors(c, n => {
      if (dist[n] < 0) {
        dist[n] = dist[c] + 1;
        queue.push(n);
      }
    });
  }
  const candidates: Array<{k: number; d: number}> = [];
  for (let j = 0; j < H; j++) {
    if (Math.abs(cellLat(j)) > 70) continue;
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const d = dist[k];
      if (!isSea[k] || d < 4) continue;
      let isMax = true;
      for (let dy = -5; dy <= 5 && isMax; dy++) {
        const y = j + dy;
        if (y < 0 || y >= H) continue;
        for (let dx = -5; dx <= 5; dx++) {
          if (dist[y * W + wrapX(i + dx)] > d) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) candidates.push({k, d});
    }
  }
  candidates.sort((a, b) => b.d - a.d || a.k - b.k);
  // The six widest open waters are oceans; the others are seas.
  const names: WaterName[] = [];
  const chosen: Array<{k: number; ocean: boolean}> = [];
  let index = 0;
  let oceans = 0;
  for (const {k, d} of candidates) {
    if (names.length >= 40) break;
    const ocean = oceans < 6 && d >= 10;
    if (chosen.some(c => cellDistance(c.k, k) < (ocean || c.ocean ? 70 : 28))) continue;
    if (ocean) oceans++;
    chosen.push({k, ocean});
    const i = k % W;
    const base = makeName(world.seed, NAME_KIND.sea, index++);
    names.push({
      lon: cellLon(i),
      lat: cellLat((k - i) / W),
      name: ocean ? `${base} Ocean` : index % 2 ? `${base} Sea` : `Sea of ${base}`,
      class: ocean ? 'ocean' : 'sea'
    });
  }
  let lakeIndex = 0;
  const big = lakeComponents.filter(c => c.length >= 5).sort((a, b) => b.length - a.length || a[0] - b[0]);
  for (const cells of big.slice(0, 40)) {
    let sx = 0;
    let sy = 0;
    const x0 = cells[0] % W;
    for (const c of cells) {
      let dx = (c % W) - x0;
      if (dx > W / 2) dx -= W;
      if (dx < -W / 2) dx += W;
      sx += dx;
      sy += Math.floor(c / W);
    }
    const cx = x0 + sx / cells.length;
    const cy = sy / cells.length;
    let best = cells[0];
    let bestD = Infinity;
    for (const c of cells) {
      let dx = Math.abs((c % W) - cx);
      dx = Math.min(dx, W - dx);
      const dd = dx * dx + (Math.floor(c / W) - cy) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = c;
      }
    }
    const i = best % W;
    names.push({
      lon: cellLon(i),
      lat: cellLat((best - i) / W),
      name: `Lake ${makeName(world.seed, NAME_KIND.lake, lakeIndex++)}`,
      class: 'lake'
    });
  }
  return names;
}
