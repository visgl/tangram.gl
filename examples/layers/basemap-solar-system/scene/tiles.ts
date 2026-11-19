// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Raster tiles for BasemapLayer, and the textures of the overview spheres.
//
// NASA Trek serves its global mosaics in a geographic grid (2 x 1 tiles at z0, origin -180/90).
// BasemapLayer reads Web Mercator z/x/y tiles. The `fetch` in `loadOptions` (shimFetch) answers
// each Web Mercator tile of the host SHIM_HOST: a worker reads the geographic tiles that cover the
// tile, plus a margin of one source pixel, and resamples them bilinearly, pixel by pixel. Two
// neighbouring tiles read the same source pixels at their common edge, so there is no seam.
// Bodies without a tile source get plain-colour (or banded) tiles from the same host.

import type {BodyId} from '../celestial';
import {BODIES, SHIM_HOST, type Body, type GeoSource} from '../bodies';

/** Counters of this thread. */
export const stats = {served: 0, sourceTiles: 0, sourceMisses: 0};
/** JPEG: encoding is several times faster than PNG (the sources are JPEG). */
const TILE_TYPE = {type: 'image/jpeg', quality: 0.92};
const OUT = 256;
/** Source tiles kept per thread (256 kB each). */
const CACHE_SIZE = 192;

const mercatorToLat = (t: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) * 180) / Math.PI;

const sourceCache = new Map<string, Promise<ImageBitmap | null>>();
function getSourceTile(source: GeoSource, z: number, row: number, col: number): Promise<ImageBitmap | null> {
  const key = `${source.template}|${z}/${row}/${col}`;
  let tile = sourceCache.get(key);
  if (tile) {
    // Most recently used goes last.
    sourceCache.delete(key);
    sourceCache.set(key, tile);
    return tile;
  }
  const url = source.template.replace('{z}', String(z)).replace('{row}', String(row)).replace('{col}', String(col));
  tile = fetch(url, {mode: 'cors', signal: AbortSignal.timeout(20000)})
    .then(async response => {
      if (!response.ok) throw new Error(String(response.status));
      stats.sourceTiles++;
      return createImageBitmap(await response.blob());
    })
    .catch(() => {
      stats.sourceMisses++;
      // A failed tile is not kept: the next request tries again.
      sourceCache.delete(key);
      return null;
    });
  sourceCache.set(key, tile);
  while (sourceCache.size > CACHE_SIZE) {
    sourceCache.delete(sourceCache.keys().next().value as string);
  }
  return tile;
}

/**
 * Draws one source tile into a mosaic. A missing tile is replaced by the matching quarter of its
 * parent, so a failed request leaves a blurred patch, not a hole.
 */
async function drawSourceTile(
  context: OffscreenCanvasRenderingContext2D,
  source: GeoSource,
  z: number,
  row: number,
  col: number,
  dx: number,
  dy: number,
  size: number
): Promise<void> {
  const image = await getSourceTile(source, z, row, col);
  if (image) {
    context.drawImage(image, dx, dy, size, size);
    return;
  }
  if (z === 0) return;
  const parent = await getSourceTile(source, z - 1, row >> 1, col >> 1);
  if (!parent) return;
  const half = parent.width / 2;
  context.drawImage(parent, (col & 1) * half, (row & 1) * half, half, half, dx, dy, size, size);
}

/**
 * Source zoom for a Web Mercator tile: the same pixel size at the equator, and one level more
 * where Web Mercator stretches the map by more than 1.5 (latitude above 48 deg).
 */
function sourceZoomFor(source: GeoSource, z: number, polewardLatDeg: number) {
  const stretch = 1 / Math.cos((polewardLatDeg * Math.PI) / 180);
  const gz = z - 1 - Math.log2(source.tileSize / 256) + (stretch > 1.5 ? 1 : 0);
  return Math.min(Math.max(gz, 0), source.maxZoom);
}

async function renderMercatorTile(source: GeoSource, z: number, x: number, y: number) {
  const n = 2 ** z;
  const size = source.tileSize;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = mercatorToLat(y / n);
  const south = mercatorToLat((y + 1) / n);
  const gz = sourceZoomFor(source, z, Math.max(Math.abs(north), Math.abs(south)));
  const columns = 2 ** (gz + 1);
  const rows = 2 ** gz;
  const tileDegrees = 180 / rows;
  const pixelsPerDegree = size / tileDegrees;
  // Global source pixel coordinates of the output pixel centres (-0.5: pixel centres at +0.5).
  const us = new Float64Array(OUT);
  const vs = new Float64Array(OUT);
  for (let k = 0; k < OUT; k++) {
    us[k] = (west + ((k + 0.5) / OUT) * (east - west) + 180) * pixelsPerDegree - 0.5;
    vs[k] = Math.min(Math.max((90 - mercatorToLat((y + (k + 0.5) / OUT) / n)) * pixelsPerDegree - 0.5, 0), rows * size - 1);
  }
  // The source tiles under the bilinear footprint of the output pixels; columns wrap around the
  // antimeridian, so the edge pixels blend with the tile across it.
  const c0 = Math.floor(Math.floor(us[0]) / size);
  const c1 = Math.floor(Math.ceil(us[OUT - 1]) / size);
  const r0 = Math.floor(Math.floor(vs[0]) / size);
  const r1 = Math.min(rows - 1, Math.floor(Math.ceil(vs[OUT - 1]) / size));
  const width = (c1 - c0 + 1) * size;
  const height = (r1 - r0 + 1) * size;
  const mosaic = new OffscreenCanvas(width, height);
  const mosaicContext = mosaic.getContext('2d', {willReadFrequently: true}) as OffscreenCanvasRenderingContext2D;
  const draws: Promise<void>[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const wrapped = ((col % columns) + columns) % columns;
      draws.push(drawSourceTile(mosaicContext, source, gz, row, wrapped, (col - c0) * size, (row - r0) * size, size));
    }
  }
  await Promise.all(draws);
  const pixels = mosaicContext.getImageData(0, 0, width, height).data;
  const out = new ImageData(OUT, OUT);
  for (let py = 0; py < OUT; py++) {
    const v = Math.min(vs[py] - r0 * size, height - 1);
    const v0 = Math.floor(v);
    const v1 = Math.min(v0 + 1, height - 1);
    const fv = v - v0;
    for (let px = 0; px < OUT; px++) {
      const u = Math.min(Math.max(us[px] - c0 * size, 0), width - 1);
      const u0 = Math.floor(u);
      const u1 = Math.min(u0 + 1, width - 1);
      const fu = u - u0;
      const i00 = (v0 * width + u0) * 4;
      const i01 = (v0 * width + u1) * 4;
      const i10 = (v1 * width + u0) * 4;
      const i11 = (v1 * width + u1) * 4;
      const o = (py * OUT + px) * 4;
      for (let k = 0; k < 3; k++) {
        const top = pixels[i00 + k] + (pixels[i01 + k] - pixels[i00 + k]) * fu;
        const bottom = pixels[i10 + k] + (pixels[i11 + k] - pixels[i10 + k]) * fu;
        out.data[o + k] = top + (bottom - top) * fv;
      }
      out.data[o + 3] = 255;
    }
  }
  const canvas = new OffscreenCanvas(OUT, OUT);
  (canvas.getContext('2d') as OffscreenCanvasRenderingContext2D).putImageData(out, 0, 0);
  stats.served++;
  return canvas.convertToBlob(TILE_TYPE);
}

/** Colour of a plain body at a latitude: flat, or banded for the gas giants. */
export function bodyColorAt(body: Body, lat: number): [number, number, number] {
  const [r, g, b] = body.color;
  const k = body.bands
    ? 1 + 0.16 * Math.sin(lat * 0.21) + 0.08 * Math.sin(lat * 0.57 + 1) - 0.1 * Math.abs(lat / 90) ** 3
    : 1 - 0.05 * Math.abs(lat / 90);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return [c(r), c(g), c(b)];
}
const css = ([r, g, b]: [number, number, number]) => `rgb(${r},${g},${b})`;

async function renderPlainTile(body: Body, z: number, y: number) {
  const n = 2 ** z;
  const out = new OffscreenCanvas(OUT, OUT);
  const context = out.getContext('2d') as OffscreenCanvasRenderingContext2D;
  for (let py = 0; py < OUT; py += 2) {
    context.fillStyle = css(bodyColorAt(body, mercatorToLat((y + (py + 1) / OUT) / n)));
    context.fillRect(0, py, OUT, 2);
  }
  stats.served++;
  return out.convertToBlob(TILE_TYPE);
}

/** One Web Mercator tile of a body. */
export function renderTile(body: Body, z: number, x: number, y: number) {
  return body.source ? renderMercatorTile(body.source, z, x, y) : renderPlainTile(body, z, y);
}

type WorkerReply = {n: number; blob?: Blob; error?: string; stats: typeof stats};

/** Tile workers (tile-worker.ts), started on the first tile request. */
const WORKER_COUNT = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
let workers: Worker[] = [];
const workerStats = new Map<Worker, typeof stats>();
let nextRequest = 0;
const pending = new Map<number, {resolve: (blob: Blob) => void; reject: (error: Error) => void}>();

function startWorkers() {
  workers = Array.from({length: WORKER_COUNT}, () => {
    const worker = new Worker(new URL('./tile-worker.ts', import.meta.url), {type: 'module'});
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const {n, blob, error} = event.data;
      workerStats.set(worker, event.data.stats);
      const request = pending.get(n);
      pending.delete(n);
      if (blob) request?.resolve(blob);
      else request?.reject(new Error(error));
    };
    return worker;
  });
}

function renderInWorker(id: BodyId, z: number, x: number, y: number): Promise<Blob> {
  if (!workers.length) startWorkers();
  const n = nextRequest++;
  return new Promise((resolve, reject) => {
    pending.set(n, {resolve, reject});
    workers[n % WORKER_COUNT].postMessage({n, id, z, x, y});
  });
}

/** Counters of this thread and of the tile workers. */
export function getTileStats(): typeof stats {
  const total = {...stats};
  for (const s of workerStats.values()) {
    for (const key of Object.keys(total) as (keyof typeof stats)[]) total[key] += s[key];
  }
  return total;
}

/** `fetch` for BasemapLayer: tiles of SHIM_HOST come from the workers, other URLs pass through. */
export const shimFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const parsed = new URL(url, location.href);
  if (parsed.hostname !== SHIM_HOST) return fetch(input, init);
  const match = parsed.pathname.match(/^\/(\w+)\/(\d+)\/(\d+)\/(\d+)/);
  const body = match && BODIES[match[1] as BodyId];
  if (!match || !body) return new Response(null, {status: 404});
  const blob = await renderInWorker(body.id, Number(match[2]), Number(match[3]), Number(match[4]));
  return new Response(blob, {headers: {'content-type': TILE_TYPE.type}});
};

/**
 * An equirectangular image of a body (2:1, north up) for its overview sphere: the imagery of the
 * low zoom globe tiles. Earth: NASA GIBS Blue Marble; Trek bodies: the z2 geographic tiles; the
 * others: the colour function of the plain tiles.
 */
const TEXTURE_W = 2048;
const TEXTURE_H = 1024;
export async function getEquirectTexture(body: Body): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(TEXTURE_W, TEXTURE_H);
  const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  if (body.id === 'earth') {
    const url =
      'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0' +
      `&LAYERS=BlueMarble_ShadedRelief_Bathymetry&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=${TEXTURE_W}&HEIGHT=${TEXTURE_H}&FORMAT=image/jpeg`;
    try {
      const response = await fetch(url, {mode: 'cors', signal: AbortSignal.timeout(20000)});
      context.drawImage(await createImageBitmap(await response.blob()), 0, 0, TEXTURE_W, TEXTURE_H);
      return createImageBitmap(canvas);
    } catch {
      // Falls through to plain colour.
    }
  }
  if (body.source) {
    const z = 2;
    const columns = 2 ** (z + 1);
    const rows = 2 ** z;
    const w = TEXTURE_W / columns;
    const h = TEXTURE_H / rows;
    const draws: Promise<void>[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        draws.push(drawSourceTile(context, body.source, z, row, col, col * w, row * h, w));
      }
    }
    await Promise.all(draws);
    return createImageBitmap(canvas);
  }
  for (let py = 0; py < TEXTURE_H; py += 2) {
    context.fillStyle = css(bodyColorAt(body, 90 - ((py + 1) / TEXTURE_H) * 180));
    context.fillRect(0, py, TEXTURE_W, 2);
  }
  return createImageBitmap(canvas);
}
