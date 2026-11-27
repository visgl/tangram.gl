// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Textures and night-side cells of the scene, made on an OffscreenCanvas.

import {createMilkyWayBackground} from '@math.gl/earth/sun';
import {DEG, SATURN_RINGS, dot, eclipticToEqj, type V3} from '../celestial';

/** Equirectangular Milky Way texture in ecliptic longitude/latitude (row 0 = ecliptic north). */
export async function getMilkyWayTexture(width = 1024, height = 512): Promise<ImageBitmap> {
  const milkyWay = createMilkyWayBackground(2000);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const lat = Math.PI / 2 - (Math.PI * (y + 0.5)) / height;
    for (let x = 0; x < width; x++) {
      const lon = -Math.PI + (2 * Math.PI * (x + 0.5)) / width;
      const direction = eclipticToEqj([Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)]);
      const {intensity, color} = milkyWay.sample(direction);
      const k = 5 + 150 * Math.min(1, intensity) ** 0.8;
      const i = (y * width + x) * 4;
      image.data[i] = k * color[0];
      image.data[i + 1] = k * color[1];
      image.data[i + 2] = k * color[2] + 4;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return createImageBitmap(canvas);
}

/**
 * Night cells for GlobeView (2 deg), each with an alpha from the solar altitude at its centre:
 * 0 above +1 deg, rising to `maxAlpha` at -12 deg (nautical twilight).
 */
export type NightCell = {polygon: V3[]; alpha: number};
export function getNightCells(sunDirection: V3, step = 2, maxAlpha = 170, z = 2000): NightCell[] {
  const cells: NightCell[] = [];
  const maxLat = 85.0511;
  for (let lat = -maxLat; lat < maxLat; lat += step) {
    const lat1 = Math.min(maxLat, lat + step);
    const latC = ((lat + lat1) / 2) * DEG;
    for (let lon = -180; lon < 180; lon += step) {
      const lonC = (lon + step / 2) * DEG;
      const sinAlt = dot([Math.cos(latC) * Math.cos(lonC), Math.cos(latC) * Math.sin(lonC), Math.sin(latC)], sunDirection);
      const alt = Math.asin(sinAlt) / DEG;
      const f = Math.max(0, Math.min(1, (1 - alt) / 13));
      if (f === 0) continue;
      const s = f * f * (3 - 2 * f);
      cells.push({
        polygon: [[lon, lat, z], [lon + step, lat, z], [lon + step, lat1, z], [lon, lat1, z], [lon, lat, z]],
        alpha: Math.round(maxAlpha * s)
      });
    }
  }
  return cells;
}

/**
 * Ring bands, km (NSSDC Saturnian Rings Fact Sheet). Only the inner and outer edges come from
 * math.gl; the B-ring, Cassini Division and A-ring edges are from the same fact sheet.
 */
export const RING_BANDS: {from: number; to: number; color: [number, number, number, number]}[] = [
  {from: SATURN_RINGS.innerKm, to: 92000, color: [120, 110, 95, 110]},
  {from: 92000, to: 117580, color: [222, 204, 168, 235]},
  {from: 117580, to: 122170, color: [40, 36, 32, 40]},
  {from: 122170, to: SATURN_RINGS.outerKm, color: [196, 180, 150, 200]}
];

/** Radial ring texture, 512 x 1: u = 0 at the inner edge, 1 at the outer edge. */
export async function getRingTexture(width = 512): Promise<ImageBitmap> {
  const canvas = new OffscreenCanvas(width, 1);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
  const image = ctx.createImageData(width, 1);
  const {innerKm, outerKm} = SATURN_RINGS;
  for (let x = 0; x < width; x++) {
    const r = innerKm + ((x + 0.5) / width) * (outerKm - innerKm);
    const band = RING_BANDS.find(b => r >= b.from && r < b.to) ?? RING_BANDS[RING_BANDS.length - 1];
    // A little radial structure, so the bands do not look flat.
    const ripple = 0.88 + 0.12 * Math.sin(r / 900) * Math.sin(r / 2300);
    image.data.set([band.color[0] * ripple, band.color[1] * ripple, band.color[2] * ripple, band.color[3]], x * 4);
  }
  ctx.putImageData(image, 0, 0);
  return createImageBitmap(canvas);
}

