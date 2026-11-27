// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {
  CLOUD_LUT_MAX_ALTITUDE,
  CLOUD_LUT_MIN_ALTITUDE,
  CLOUD_LUT_SIZE,
  CLOUD_MAP_FLOOR,
  chapmanColumn,
  cloudAlbedoFromMap,
  cloudLutAltitude,
  cloudLutCoordinate,
  cloudOpticalDepth,
  erfcx,
  getAtmosphere,
  getCloudLightTable,
  henyeyGreenstein,
  rayleighPhase,
  raySphere
} from '../examples/layers/basemap-solar-system/celestial/atmosphere';

const DEG = Math.PI / 180;

/** Integral of a phase function of cos(theta) over the sphere, and its mean cosine. */
function sphereIntegral(phase: (c: number) => number) {
  const n = 20000;
  let total = 0;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    const c = -1 + (2 * (i + 0.5)) / n;
    const w = (2 * Math.PI * 2) / n;
    total += phase(c) * w;
    mean += phase(c) * c * w;
  }
  return {total, mean};
}

/** Column of exp(-h) along a ray from height h (scale heights) above radius x, by quadrature. */
function columnByQuadrature(x: number, h: number, cosZenith: number) {
  const r0 = x + h;
  const sinZ = Math.sqrt(1 - cosZenith * cosZenith);
  let total = 0;
  const ds = 0.001;
  for (let s = ds / 2; ; s += ds) {
    const r = Math.hypot(r0 * sinZ, r0 * cosZenith + s);
    if (r - x > 40 && s > -2 * r0 * cosZenith) return total;
    total += Math.exp(-(r - x)) * ds;
  }
}

describe('phase functions', () => {
  test.each([-0.5, 0, 0.3, 0.7, 0.85])('Henyey-Greenstein g = %s integrates to one, mean cosine g', g => {
    const {total, mean} = sphereIntegral(c => henyeyGreenstein(c, g));
    expect(total).toBeCloseTo(1, 3);
    expect(mean).toBeCloseTo(g, 3);
  });

  test('Henyey-Greenstein peaks forward for g > 0', () => {
    expect(henyeyGreenstein(1, 0.7)).toBeGreaterThan(henyeyGreenstein(-1, 0.7) * 100);
  });

  test('Rayleigh phase integrates to one, symmetric, twice as strong along the beam as across it', () => {
    const {total, mean} = sphereIntegral(rayleighPhase);
    expect(total).toBeCloseTo(1, 4);
    expect(mean).toBeCloseTo(0, 6);
    expect(rayleighPhase(1) / rayleighPhase(0)).toBeCloseTo(2, 10);
  });
});

test.each([0, 0.3, 1, 3, 10, 30])('erfcx(%s) matches exp(y^2) erfc(y) by quadrature to 0.5 %%', y => {
  // erfc(y) = 2 / sqrt(pi) * integral from y to infinity of exp(-t^2) dt; times exp(y^2).
  let total = 0;
  const dt = 1e-4;
  for (let t = dt / 2; t < 12; t += dt) total += Math.exp(-(2 * y * t + t * t)) * dt;
  const exact = (2 / Math.sqrt(Math.PI)) * total;
  expect(Math.abs(erfcx(y) / exact - 1)).toBeLessThan(0.005);
});

describe('chapmanColumn (Schüler 2012)', () => {
  // Earth (R / H = 797), Mars (306), Venus haze above the deck (1255).
  test.each([
    [797, 0, 1],
    [797, 0, 0.5],
    [797, 1, 0.2],
    [797, 0, 0.05],
    [797, 2, 0],
    [306, 0.5, 0.3],
    [306, 3, -0.05],
    [1255, 0, 0.1]
  ])('x = %s, h = %s, cos z = %s matches quadrature to 2 %%', (x, h, cz) => {
    const exact = columnByQuadrature(x, h, cz);
    expect(chapmanColumn(x, h, cz) / exact).toBeGreaterThan(0.98);
    expect(chapmanColumn(x, h, cz) / exact).toBeLessThan(1.02);
  });

  test('a vertical ray from the base has a column of one scale height', () => {
    expect(chapmanColumn(797, 0, 1)).toBeCloseTo(1, 2);
  });

  test('a horizontal ray has the column sqrt(pi x / 2)', () => {
    expect(chapmanColumn(797, 0, 0)).toBeCloseTo(Math.sqrt((Math.PI / 2) * 797), 10);
  });

  test('the column falls off as exp(-h)', () => {
    expect(chapmanColumn(797, 3, 0.4) / chapmanColumn(797, 0, 0.4)).toBeCloseTo(Math.exp(-3), 2);
  });
});

describe('raySphere', () => {
  test('a ray from outside enters and leaves', () => {
    expect(raySphere([0, 0, -5], [0, 0, 1], 2)).toEqual([3, 7]);
  });
  test('a ray that misses gives null', () => {
    expect(raySphere([0, 3, -5], [0, 0, 1], 2)).toBeNull();
  });
  test('from inside, entry is behind and exit ahead', () => {
    const [t0, t1] = raySphere([0, 0.5, 0], [1, 0, 0], 1) as [number, number];
    expect(t0).toBeCloseTo(-Math.sqrt(0.75), 12);
    expect(t1).toBeCloseTo(Math.sqrt(0.75), 12);
  });
  test('a tangent ray touches once', () => {
    const [t0, t1] = raySphere([0, 1, -4], [0, 0, 1], 1) as [number, number];
    expect(t0).toBeCloseTo(4, 12);
    expect(t1).toBeCloseTo(4, 12);
  });
});

describe('clouds', () => {
  test.each([0.05, 0.2, 0.5, 0.75, 0.8])('cloudOpticalDepth inverts the two-stream albedo, A = %s', a => {
    const tau = cloudOpticalDepth(a);
    expect((0.15 * tau) / (2 + 0.15 * tau)).toBeCloseTo(a, 10);
  });

  test('cloudOpticalDepth: zero albedo, no cloud; bright clouds limited to the maximum', () => {
    expect(cloudOpticalDepth(0)).toBe(0);
    expect(cloudOpticalDepth(-1)).toBe(0);
    expect(cloudOpticalDepth(0.85)).toBe(60);
    expect(cloudOpticalDepth(1)).toBe(60);
    expect(cloudOpticalDepth(0.6)).toBeGreaterThan(cloudOpticalDepth(0.5));
  });

  test('cloudAlbedoFromMap: clear below the floor, linear above it, below one', () => {
    expect(cloudAlbedoFromMap(0)).toBe(0);
    expect(cloudAlbedoFromMap(CLOUD_MAP_FLOOR)).toBe(0);
    expect(cloudAlbedoFromMap((1 + CLOUD_MAP_FLOOR) / 2)).toBeCloseTo(0.5, 12);
    expect(cloudAlbedoFromMap(1)).toBe(0.999);
  });

  test('light table coordinate and altitude are inverse, and the ends map to 0 and 1', () => {
    for (const s of [0, 0.1, 0.37, 0.5, 0.9, 1]) expect(cloudLutCoordinate(cloudLutAltitude(s))).toBeCloseTo(s, 12);
    expect(cloudLutCoordinate(CLOUD_LUT_MIN_ALTITUDE - 1)).toBe(0);
    expect(cloudLutCoordinate(CLOUD_LUT_MAX_ALTITUDE)).toBe(1);
    // Denser near the horizon than at the zenith.
    expect(cloudLutAltitude(0.25) - cloudLutAltitude(0.2)).toBeLessThan(cloudLutAltitude(1) - cloudLutAltitude(0.95));
  });

  test('light table: dark below the cloud horizon, white at the zenith, red at sunset', () => {
    const table = getCloudLightTable();
    expect(table.length).toBe(CLOUD_LUT_SIZE * 2 * 4);
    const direct = (i: number) => [table[i * 4], table[i * 4 + 1], table[i * 4 + 2]];
    const sky = (i: number) => [table[(CLOUD_LUT_SIZE + i) * 4], table[(CLOUD_LUT_SIZE + i) * 4 + 1], table[(CLOUD_LUT_SIZE + i) * 4 + 2]];
    const at = (altitude: number) => Math.round(cloudLutCoordinate(altitude) * (CLOUD_LUT_SIZE - 1));
    // From 7 km the horizon is 2.7 degrees down: at -3.5 degrees the Sun is set, the sky nearly dark.
    expect(direct(at(-3.5 * DEG))).toEqual([0, 0, 0]);
    expect(Math.max(...sky(at(-3.5 * DEG)))).toBeLessThan(5);
    // At the zenith the beam is near white (white-balanced to the Sun above the air).
    // At 7 km about 10 % of the beam is lost on the way down.
    for (const c of direct(CLOUD_LUT_SIZE - 1)) expect(c).toBeGreaterThan(215);
    const [zr, zg, zb] = direct(CLOUD_LUT_SIZE - 1);
    expect(Math.max(zr, zg, zb) - Math.min(zr, zg, zb)).toBeLessThan(25);
    // At the horizon it is red: red > green > blue.
    const [r, g, b] = direct(at(0));
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    // The beam grows with the Sun's altitude in every channel.
    for (let i = 1; i < CLOUD_LUT_SIZE; i++) {
      for (let c = 0; c < 3; c++) expect(direct(i)[c]).toBeGreaterThanOrEqual(direct(i - 1)[c]);
    }
    // The sky is bluer than the beam by day.
    const zenithSky = sky(CLOUD_LUT_SIZE - 1);
    expect(zenithSky[2]).toBeGreaterThan(zenithSky[0]);
  });
});

describe('getAtmosphere', () => {
  test('Earth: Bruneton constants in body radii', () => {
    const earth = getAtmosphere('earth');
    const radiusM = 6378137;
    expect(earth?.baseRadius).toBe(1);
    expect(earth?.topRadius).toBeCloseTo(1 + 60000 / radiusM, 12);
    expect(earth?.rayleighHeight).toBeCloseTo(8000 / radiusM, 12);
    expect(earth?.mieHeight).toBeCloseTo(1200 / radiusM, 12);
    expect(earth?.rayleigh[2]).toBeCloseTo(33.1e-6 * radiusM, 6);
    // Optical depth of the vertical column at 440 nm: about 0.26.
    expect((earth?.rayleigh[2] ?? 0) * (earth?.rayleighHeight ?? 0)).toBeCloseTo(0.265, 2);
  });

  test('Mars: dust dominates, optical depth 0.5; Rayleigh about 2 % of the Earth per metre', () => {
    const mars = getAtmosphere('mars');
    const radiusM = 3396200;
    expect((mars?.mieExtinction[1] ?? 0) * (mars?.mieHeight ?? 0)).toBeCloseTo(0.5, 10);
    const ratio = (mars?.rayleigh[1] ?? 0) / radiusM / 13.558e-6;
    expect(ratio).toBeGreaterThan(0.015);
    expect(ratio).toBeLessThan(0.03);
    // Dust absorbs blue more than red.
    expect(mars?.mieScattering[2]).toBeLessThan(mars?.mieScattering[0] as number);
  });

  test('Venus: the atmosphere starts at the cloud deck, 70 km up', () => {
    const venus = getAtmosphere('venus');
    expect(venus?.baseRadius).toBeCloseTo(1 + 70 / 6051.8, 12);
    expect(venus?.deckAlbedo).toBeDefined();
    expect(venus?.topRadius).toBeGreaterThan(venus?.baseRadius as number);
  });

  test('bodies without an atmosphere in the example', () => {
    for (const id of ['moon', 'mercury', 'sun', 'jupiter'] as const) expect(getAtmosphere(id)).toBeNull();
  });
});
