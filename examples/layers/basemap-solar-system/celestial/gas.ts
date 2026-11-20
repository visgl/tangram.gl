// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Density models of the gas and dust that the example draws as volumes. The shader in
// scene/space-volumes.ts evaluates the same formulas; these copies are for tests and the UI.

/**
 * Electron density of the solar corona, cm^-3, at `r` solar radii from the centre: the Baumbach
 * model (Baumbach 1937, Astron. Nachr. 263, 121; as given by Allen, Astrophysical Quantities):
 * N(r) = 1e8 (0.036 r^-1.5 + 1.55 r^-6 + 2.99 r^-16).
 */
export function baumbachDensity(r: number): number {
  return 1e8 * (0.036 * r ** -1.5 + 1.55 * r ** -6 + 2.99 * r ** -16);
}

/**
 * Relative density of the smooth zodiacal dust cloud at `r` AU from the Sun and ecliptic
 * latitude `zeta = |z| / r`: the "widened fan" of Kelsall et al. (1998, ApJ 508, 44, COBE/DIRBE),
 * n = r^-1.34 exp(-4.14 g^0.942), g = zeta^2 / (2 mu) for zeta < mu, else zeta - mu / 2, mu = 0.189.
 * Normalised to 1 at 1 AU in the ecliptic. The cloud's tilt and offset are left out.
 */
export function kelsallDensity(r: number, zeta: number): number {
  const mu = 0.189;
  const g = zeta < mu ? (zeta * zeta) / (2 * mu) : zeta - mu / 2;
  return r ** -1.34 * Math.exp(-4.14 * g ** 0.942);
}
