// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Equirectangular (plate carree) textures of the vector maps, for the overview spheres. They use
// the same data and colours as the globe styles in styles.ts, so the overview sphere and the
// globe match at the hand-off. Row 0 is latitude +90, column 0 is longitude -180.
//
// - Moon, Mars, Mercury, Venus: the GeoJSON of the body, drawn in plate carree.
// - Earth: the OpenFreeMap tiles of zoom 2 (the "liberty" water, ice and Natural Earth relief),
//   drawn in Web Mercator and resampled by row; beyond +-85.05 deg the water colour (north) or the
//   ice colour (south).

import type {BodyId} from '../celestial';
import {decodeMVT} from './mvt';
import {BODIES} from './registry';
import {VECTOR_LOOK, dataUrl, getLiberty, type Look, type Style, type StyleLayer} from './styles';

type Ctx = OffscreenCanvasRenderingContext2D;
type Position = number[];
type Geometry = {type: string; coordinates: unknown};
type Feature = {properties: Record<string, unknown>; geometry: Geometry};

/** The GlobeView tile zoom at the hand-off: the zoom at which the textures copy the style. */
export const TEXTURE_STYLE_ZOOM = 4;

/** Line width in texture pixels for a line `px` wide on the globe at the hand-off. */
const lineScale = (width: number) => width / 360 / 4;

function pathRing(ctx: Ctx, ring: Position[], width: number, height: number) {
  ring.forEach(([lon, lat], i) => {
    const x = ((lon + 180) / 360) * width;
    const y = ((90 - lat) / 180) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
}

function pathGeometry(ctx: Ctx, geometry: Geometry, width: number, height: number) {
  const c = geometry.coordinates;
  switch (geometry.type) {
    case 'LineString':
      pathRing(ctx, c as Position[], width, height);
      break;
    case 'MultiLineString':
    case 'Polygon':
      for (const ring of c as Position[][]) pathRing(ctx, ring, width, height);
      break;
    case 'MultiPolygon':
      for (const polygon of c as Position[][][]) for (const ring of polygon) pathRing(ctx, ring, width, height);
      break;
    default:
  }
}

function graticulePath(ctx: Ctx, width: number, height: number, meridian: boolean) {
  for (let lon = -180; lon < 180; lon += 10) {
    if ((lon === 0) !== meridian) continue;
    pathRing(ctx, [[lon, -80], [lon, 80]], width, height);
  }
  for (let lat = -80; lat <= 80; lat += 10) {
    if ((lat === 0) !== meridian) continue;
    pathRing(ctx, [[-180, lat], [180, lat]], width, height);
  }
}

/** The vector map of a body other than the Earth, as in styles.ts vectorStyle. */
async function drawBody(ctx: Ctx, look: Look, file: string, width: number, height: number) {
  const response = await fetch(dataUrl(file));
  if (!response.ok) throw new Error(`${file}: ${response.status}`);
  const {features} = (await response.json()) as {features: Feature[]};
  const k = lineScale(width);
  const z = TEXTURE_STYLE_ZOOM;
  ctx.fillStyle = look.land;
  ctx.fillRect(0, 0, width, height);
  // Units.
  ctx.globalAlpha = 0.9;
  for (const f of features) {
    if (f.properties.kind !== 'unit') continue;
    ctx.fillStyle = look.units?.[String(f.properties.unit)] ?? look.dark;
    ctx.beginPath();
    pathGeometry(ctx, f.geometry, width, height);
    ctx.fill('evenodd');
  }
  // Contours.
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = (0.5 + ((1.4 - 0.5) * (z - 2)) / 6) * k;
  for (const below of [true, false]) {
    ctx.strokeStyle = below ? look.dark : look.rim;
    ctx.beginPath();
    for (const f of features) {
      if (f.properties.kind === 'contour' && (Number(f.properties.elevation_m) < 0) === below) pathGeometry(ctx, f.geometry, width, height);
    }
    ctx.stroke();
  }
  // Graticule.
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = look.grid;
  for (const meridian of [false, true]) {
    ctx.lineWidth = (meridian ? 1.2 : 0.6) * k;
    ctx.beginPath();
    graticulePath(ctx, width, height, meridian);
    ctx.stroke();
  }
  // Crater rims and basin rings.
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = look.rim;
  for (const kind of ['crater', 'ring']) {
    const [w2, w8] = kind === 'ring' ? [1.2, 2.4] : [0.5, 1.4];
    ctx.lineWidth = (w2 + ((w8 - w2) * (z - 2)) / 6) * k;
    ctx.beginPath();
    for (const f of features) if (f.properties.kind === kind) pathGeometry(ctx, f.geometry, width, height);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/** A number paint value of a style at a zoom: a constant or a zoom `interpolate` expression. */
function numberAt(value: unknown, zoom: number, fallback: number): number {
  if (typeof value === 'number') return value;
  if (!Array.isArray(value) || value[0] !== 'interpolate') return fallback;
  const [, curve, , ...stops] = value as [string, [string, number?], unknown, ...number[]];
  const base = curve[0] === 'exponential' ? (curve[1] ?? 1) : 1;
  if (zoom <= stops[0]) return stops[1];
  for (let i = 0; i + 3 < stops.length; i += 2) {
    const [z0, v0, z1, v1] = stops.slice(i, i + 4);
    if (zoom > z1) continue;
    const t = base === 1 ? (zoom - z0) / (z1 - z0) : (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1);
    return v0 + (v1 - v0) * t;
  }
  return stops[stops.length - 1];
}

const layerById = (style: Style, id: string): StyleLayer | undefined => style.layers.find(layer => layer.id === id);
const paintOf = (layer: StyleLayer | undefined, key: string) => layer?.paint?.[key];

async function loadImage(url: string): Promise<ImageBitmap | null> {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
    return response.ok ? await createImageBitmap(await response.blob()) : null;
  } catch {
    return null;
  }
}

async function loadTile(url: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(20000)});
    return response.ok ? await response.arrayBuffer() : null;
  } catch {
    return null;
  }
}

/** The Earth with the "liberty" style at zoom 2: background, Natural Earth relief, ice, water. */
async function drawEarth(ctx: Ctx, width: number, height: number) {
  const style = await getLiberty();
  const zoom = TEXTURE_STYLE_ZOOM;
  const background = String(paintOf(layerById(style, 'background'), 'background-color') ?? '#f8f4f0');
  const water = String(paintOf(layerById(style, 'water'), 'fill-color') ?? '#9ebdff');
  const ice = layerById(style, 'landcover_ice');
  const relief = layerById(style, 'natural_earth');
  const countries = layerById(style, 'boundary_2');
  const disputed = layerById(style, 'boundary_disputed');
  const sources = style.sources as Record<string, {url?: string; tiles?: string[]}>;
  const rasterTemplate = relief ? sources[String(relief.source)]?.tiles?.[0] : undefined;
  const vectorSource = sources.openmaptiles;
  const tileJson = vectorSource?.url ? ((await (await fetch(vectorSource.url)).json()) as {tiles: string[]}) : vectorSource;
  const vectorTemplate = tileJson?.tiles?.[0];

  const z = 2;
  const n = 2 ** z;
  const size = 256;
  const mercator = new OffscreenCanvas(n * size, n * size);
  const m = mercator.getContext('2d') as Ctx;
  m.fillStyle = background;
  m.fillRect(0, 0, n * size, n * size);
  const tiles: {x: number; y: number}[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) tiles.push({x, y});
  const url = (template: string, x: number, y: number) => template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const [images, vectors] = await Promise.all([
    Promise.all(tiles.map(({x, y}) => (rasterTemplate ? loadImage(url(rasterTemplate, x, y)) : null))),
    Promise.all(tiles.map(({x, y}) => (vectorTemplate ? loadTile(url(vectorTemplate, x, y)) : null)))
  ]);
  m.globalAlpha = numberAt(paintOf(relief, 'raster-opacity'), zoom, 0.4);
  tiles.forEach(({x, y}, i) => {
    const image = images[i];
    if (image) m.drawImage(image, x * size, y * size, size, size);
  });
  const fill = (features: ReturnType<typeof decodeMVT>, x: number, y: number) => {
    m.beginPath();
    for (const f of features) {
      const s = size / f.extent;
      for (const ring of f.geometry) {
        ring.forEach(([px, py], j) => {
          if (j === 0) m.moveTo(x * size + px * s, y * size + py * s);
          else m.lineTo(x * size + px * s, y * size + py * s);
        });
      }
    }
    m.fill('evenodd');
  };
  tiles.forEach(({x, y}, i) => {
    const data = vectors[i];
    if (!data) return;
    m.save();
    m.beginPath();
    m.rect(x * size, y * size, size, size);
    m.clip();
    const all = decodeMVT(data, ['water', 'landcover', 'boundary']);
    const features = all.filter(f => f.type === 3);
    m.globalAlpha = numberAt(paintOf(ice, 'fill-opacity'), zoom, 0.8);
    m.fillStyle = String(paintOf(ice, 'fill-color') ?? '#e0ecec');
    fill(features.filter(f => f.layer === 'landcover' && f.properties.class === 'ice'), x, y);
    m.globalAlpha = 1;
    m.fillStyle = water;
    fill(features.filter(f => f.layer === 'water' && f.properties.brunnel !== 'tunnel'), x, y);
    // Country boundaries on land, as the style's boundary_2 and boundary_disputed layers draw them.
    const lines = all.filter(f => f.layer === 'boundary' && f.type === 2 && f.properties.admin_level === 2 && f.properties.maritime !== 1 && !('claimed_by' in f.properties));
    m.lineWidth = 0.4;
    m.lineJoin = 'round';
    for (const [layer, dash, isDisputed] of [[countries, [], false], [disputed, [1.5, 3], true]] as const) {
      m.strokeStyle = String(paintOf(layer, 'line-color') ?? '#696969');
      m.globalAlpha = 0.75 * numberAt(paintOf(layer, 'line-opacity'), zoom, 1);
      m.setLineDash([...dash]);
      m.beginPath();
      for (const f of lines.filter(l => (l.properties.disputed === 1) === isDisputed)) {
        const s = size / f.extent;
        for (const part of f.geometry) part.forEach(([px, py], j) => (j === 0 ? m.moveTo : m.lineTo).call(m, x * size + px * s, y * size + py * s));
      }
      m.stroke();
    }
    m.setLineDash([]);
    m.globalAlpha = 1;
    m.restore();
  });

  // Web Mercator rows to plate carree rows.
  const maxLat = 85.0511287798;
  for (let row = 0; row < height; row++) {
    const lat = 90 - ((row + 0.5) / height) * 180;
    if (Math.abs(lat) > maxLat) {
      ctx.fillStyle = lat > 0 ? water : String(paintOf(ice, 'fill-color') ?? background);
      ctx.fillRect(0, row, width, 1);
      continue;
    }
    const phi = (lat * Math.PI) / 180;
    const my = ((1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2) * n * size;
    ctx.drawImage(mercator, 0, Math.min(n * size - 1, Math.floor(my)), n * size, 1, 0, row, width, 1);
  }
}

/**
 * The plate carree texture of the vector map of a body, or null when the body has no vector map
 * (the Sun and the giant planets).
 */
export async function getVectorTexture(id: BodyId, width = 2048, height = 1024): Promise<ImageBitmap | null> {
  const body = BODIES[id];
  const look = VECTOR_LOOK[id];
  if (id !== 'earth' && (!look || !body.vector)) return null;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as Ctx;
  if (id === 'earth') await drawEarth(ctx, width, height);
  else if (look && body.vector) await drawBody(ctx, look, body.vector.file, width, height);
  return createImageBitmap(canvas);
}
