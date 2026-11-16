// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Map projections written from their published formulas, for tests. They share no code with
 * math.gl, which deck.gl draws with: a test that compares the two does not check a projection
 * against itself.
 */

/** An ellipsoid: semi-major axis in meters and flattening. */
export type Ellipsoid = {a: number; f: number};

export const WGS84: Ellipsoid = {a: 6378137, f: 1 / 298.257223563};
export const GRS80: Ellipsoid = {a: 6378137, f: 1 / 298.257222101};
export const CLARKE_1866: Ellipsoid = {a: 6378206.4, f: 1 - 6356583.8 / 6378206.4};

const RADIANS = Math.PI / 180;

/**
 * Transverse Mercator, by the Krueger series in the third flattening to its fourth power
 * (Karney 2011, equations 35 and 36). Returns easting and northing in meters.
 */
export function projectTransverseMercator(
  [longitude, latitude]: number[],
  {
    ellipsoid = WGS84,
    centralMeridian,
    scaleFactor = 0.9996,
    falseEasting = 500000,
    falseNorthing = 0
  }: {
    ellipsoid?: Ellipsoid;
    centralMeridian: number;
    scaleFactor?: number;
    falseEasting?: number;
    falseNorthing?: number;
  }
): [number, number] {
  const {a, f} = ellipsoid;
  const n = f / (2 - f);
  const e = Math.sqrt(f * (2 - f));
  const A = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
  const alpha = [
    n / 2 - (2 * n ** 2) / 3 + (5 * n ** 3) / 16 + (41 * n ** 4) / 180,
    (13 * n ** 2) / 48 - (3 * n ** 3) / 5 + (557 * n ** 4) / 1440,
    (61 * n ** 3) / 240 - (103 * n ** 4) / 140,
    (49561 * n ** 4) / 161280
  ];
  const phi = latitude * RADIANS;
  const lambda = (longitude - centralMeridian) * RADIANS;
  // The tangent of the conformal latitude.
  const tau = Math.tan(phi);
  const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
  const tauPrime = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const xiPrime = Math.atan2(tauPrime, Math.cos(lambda));
  const etaPrime = Math.asinh(Math.sin(lambda) / Math.sqrt(tauPrime * tauPrime + Math.cos(lambda) ** 2));
  let xi = xiPrime;
  let eta = etaPrime;
  alpha.forEach((coefficient, index) => {
    const j = 2 * (index + 1);
    xi += coefficient * Math.sin(j * xiPrime) * Math.cosh(j * etaPrime);
    eta += coefficient * Math.cos(j * xiPrime) * Math.sinh(j * etaPrime);
  });
  return [falseEasting + scaleFactor * A * eta, falseNorthing + scaleFactor * A * xi];
}

/**
 * The inverse of `projectTransverseMercator` (Karney 2011, equations 36 and 7 to 9). Returns
 * longitude and latitude in degrees.
 */
export function unprojectTransverseMercator(
  [easting, northing]: number[],
  {
    ellipsoid = WGS84,
    centralMeridian,
    scaleFactor = 0.9996,
    falseEasting = 500000,
    falseNorthing = 0
  }: {
    ellipsoid?: Ellipsoid;
    centralMeridian: number;
    scaleFactor?: number;
    falseEasting?: number;
    falseNorthing?: number;
  }
): [number, number] {
  const {a, f} = ellipsoid;
  const n = f / (2 - f);
  const e = Math.sqrt(f * (2 - f));
  const A = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
  const beta = [
    n / 2 - (2 * n ** 2) / 3 + (37 * n ** 3) / 96 - n ** 4 / 360,
    n ** 2 / 48 + n ** 3 / 15 - (437 * n ** 4) / 1440,
    (17 * n ** 3) / 480 - (37 * n ** 4) / 840,
    (4397 * n ** 4) / 161280
  ];
  const xi = (northing - falseNorthing) / (scaleFactor * A);
  const eta = (easting - falseEasting) / (scaleFactor * A);
  let xiPrime = xi;
  let etaPrime = eta;
  beta.forEach((coefficient, index) => {
    const j = 2 * (index + 1);
    xiPrime -= coefficient * Math.sin(j * xi) * Math.cosh(j * eta);
    etaPrime -= coefficient * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  const tauPrime = Math.sin(xiPrime) / Math.sqrt(Math.sinh(etaPrime) ** 2 + Math.cos(xiPrime) ** 2);
  const lambda = Math.atan2(Math.sinh(etaPrime), Math.cos(xiPrime));
  // The tangent of the latitude from that of the conformal latitude, by Newton's method.
  let tau = tauPrime;
  for (let iteration = 0; iteration < 8; iteration++) {
    const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
    const estimate = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    tau +=
      ((tauPrime - estimate) / Math.sqrt(1 + estimate * estimate)) *
      ((1 + (1 - e * e) * tau * tau) / ((1 - e * e) * Math.sqrt(1 + tau * tau)));
  }
  return [centralMeridian + lambda / RADIANS, Math.atan(tau) / RADIANS];
}

/**
 * A coordinate reference system for deck.gl's `_CustomProjectionViewport`: a transverse Mercator
 * projection of the whole world, without an area of use. math.gl's own transverse Mercator
 * moves positions more than 30 degrees from the central meridian to that limit; an application
 * that supplies its own projection may not. Near the two points of the equator a quarter turn
 * from the central meridian this projection stretches the map without bound.
 */
export function createWorldTransverseMercatorCRS(centralMeridian: number) {
  const linear = {name: 'meters', metersPerUnit: 1};
  const copy = (values: number[], output?: number[]) => {
    if (!output) return values;
    values.forEach((value, index) => (output[index] = value));
    return output;
  };
  const getScale = () => [0.9996, 0.9996, 0.9996];
  return {
    signature: `test:tmerc:${centralMeridian}`,
    projection: 'tmerc',
    parameters: {proj: 'tmerc'},
    coordinateFrame: 'projected',
    ellipsoid: {semiMajorAxis: WGS84.a, semiMinorAxis: WGS84.a * (1 - WGS84.f)},
    axis: 'enu',
    xUnit: linear,
    yUnit: linear,
    zUnit: linear,
    lossy: false,
    renderingBounds: [
      [-2e7, -2e7, 0],
      [2e7, 2e7, 0]
    ],
    renderingScale: getScale,
    getRenderingScale: getScale,
    converter: {
      WGS84: {
        from: (position: ArrayLike<number>, output?: number[]) =>
          copy([...projectTransverseMercator([position[0], position[1]], {centralMeridian}), position[2] ?? 0], output),
        to: (position: ArrayLike<number>, output?: number[]) =>
          copy([...unprojectTransverseMercator([position[0], position[1]], {centralMeridian}), position[2] ?? 0], output),
        normalize: (position: ArrayLike<number>, output?: number[]) => copy(Array.from(position), output)
      }
    }
  };
}

/** UTM zone 32 north on WGS84 (EPSG:32632). */
export function projectUtm32N(lngLat: number[]): [number, number] {
  return projectTransverseMercator(lngLat, {centralMeridian: 9});
}

/**
 * Albers Equal-Area Conic on an ellipsoid (Snyder 1987, equations 14-1 to 14-12 and 3-12).
 * Returns x and y in meters.
 */
export function projectAlbers(
  [longitude, latitude]: number[],
  {
    ellipsoid = GRS80,
    latitudeOfOrigin,
    centralMeridian,
    standardParallels
  }: {
    ellipsoid?: Ellipsoid;
    latitudeOfOrigin: number;
    centralMeridian: number;
    standardParallels: [number, number];
  }
): [number, number] {
  const {a, f} = ellipsoid;
  const e2 = f * (2 - f);
  const e = Math.sqrt(e2);
  const getM = (phi: number) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const getQ = (phi: number) => {
    const sine = Math.sin(phi);
    return (
      (1 - e2) *
      (sine / (1 - e2 * sine * sine) - (1 / (2 * e)) * Math.log((1 - e * sine) / (1 + e * sine)))
    );
  };
  const phi1 = standardParallels[0] * RADIANS;
  const phi2 = standardParallels[1] * RADIANS;
  const m1 = getM(phi1);
  const m2 = getM(phi2);
  const q1 = getQ(phi1);
  const q2 = getQ(phi2);
  const n = (m1 * m1 - m2 * m2) / (q2 - q1);
  const C = m1 * m1 + n * q1;
  const getRho = (phi: number) => (a * Math.sqrt(C - n * getQ(phi))) / n;
  const rho0 = getRho(latitudeOfOrigin * RADIANS);
  const rho = getRho(latitude * RADIANS);
  const theta = n * (longitude - centralMeridian) * RADIANS;
  return [rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
}

/** The PROJ definition of NAD83 / Conus Albers (EPSG:5070). */
export const CONUS_ALBERS_PROJ =
  '+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs';

/** NAD83 / Conus Albers (EPSG:5070). */
export function projectConusAlbers(lngLat: number[]): [number, number] {
  return projectAlbers(lngLat, {
    latitudeOfOrigin: 23,
    centralMeridian: -96,
    standardParallels: [29.5, 45.5]
  });
}

/** The length of the equator that deck.gl's 512 common units stand for, in meters. */
const COMMON_WORLD_METERS = 40075016.6855;

/**
 * The top-left pixel at which an unpitched, unrotated deck.gl `_CustomProjectionView` draws a
 * position: 2 ** zoom pixels per common unit, 512 common units per `COMMON_WORLD_METERS` of the
 * coordinate reference system, around the projected view center.
 */
export function getProjectedPixel(
  project: (lngLat: number[]) => [number, number],
  lngLat: number[],
  view: {center: number[]; zoom: number; width: number; height: number}
): [number, number] {
  const scale = (2 ** view.zoom * 512) / COMMON_WORLD_METERS;
  const [x, y] = project(lngLat);
  const [centerX, centerY] = project(view.center);
  return [view.width / 2 + (x - centerX) * scale, view.height / 2 - (y - centerY) * scale];
}
