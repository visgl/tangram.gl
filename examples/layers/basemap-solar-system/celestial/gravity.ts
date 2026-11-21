// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Normal gravity on the reference ellipsoid of a body: the closed formula of Somigliana, with the
// equator and pole values of the level ellipsoid (Heiskanen and Moritz, Physical Geodesy, 1967,
// equations 2-73, 2-74 and 2-78). With the WGS84 constants it gives 9.780325 m/s^2 at the
// equator and 9.832185 m/s^2 at the poles, as WGS84 does. A level ellipsoid is a poor model of the
// gas giants (large flattening, strong zonal harmonics).

import type {PhysicalConstants} from './constants';

export type NormalGravity = {
  /** Normal gravity at the surface, m/s^2, at a geodetic latitude in degrees. */
  surfaceGravity: (latitudeDeg: number) => number;
};

export function getNormalGravity(body: PhysicalConstants): NormalGravity {
  const a = body.radiusKm * 1000;
  const b = a * (1 - body.flattening);
  const gm = body.gm;
  // The sense of rotation does not change |g|.
  const omega = (2 * Math.PI) / (Math.abs(body.rotationHours) * 3600);
  const m = (omega * omega * a * a * b) / gm;
  let gammaA: number;
  let gammaB: number;
  if (body.flattening === 0) {
    // A sphere: gravitation less the centrifugal term at the equator.
    gammaA = gm / (a * a) - omega * omega * a;
    gammaB = gm / (a * a);
  } else {
    const e2 = Math.sqrt(a * a - b * b) / b;
    const q0 = 0.5 * ((1 + 3 / (e2 * e2)) * Math.atan(e2) - 3 / e2);
    const q0p = 3 * (1 + 1 / (e2 * e2)) * (1 - Math.atan(e2) / e2) - 1;
    gammaA = (gm / (a * b)) * (1 - m - ((m / 6) * e2 * q0p) / q0);
    gammaB = (gm / (a * a)) * (1 + ((m / 3) * e2 * q0p) / q0);
  }
  return {
    surfaceGravity: latitudeDeg => {
      const phi = (latitudeDeg * Math.PI) / 180;
      const c2 = Math.cos(phi) ** 2;
      const s2 = Math.sin(phi) ** 2;
      return (a * gammaA * c2 + b * gammaB * s2) / Math.sqrt(a * a * c2 + b * b * s2);
    }
  };
}
