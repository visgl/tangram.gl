// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Physical constants of the bodies: NASA GSFC Planetary Fact Sheets
// (nssdc.gsfc.nasa.gov/planetary/factsheet): equatorial radius, flattening, GM and sidereal
// rotation period. The Earth uses WGS84. Obliquity is to the orbit.

export type BodyId =
  | 'sun' | 'mercury' | 'venus' | 'earth' | 'moon' | 'mars'
  | 'jupiter' | 'saturn' | 'uranus' | 'neptune';

export type PlanetId = Exclude<BodyId, 'sun' | 'moon'>;

export type PhysicalConstants = {
  readonly id: BodyId;
  readonly label: string;
  /** Equatorial radius, km. */
  readonly radiusKm: number;
  readonly flattening: number;
  /** GM, m^3/s^2. */
  readonly gm: number;
  /** Sidereal rotation period, hours; negative is retrograde. */
  readonly rotationHours: number;
  readonly obliquityDeg: number;
  /** Where the constants come from. */
  readonly constantsSource: string;
};

const FACT = 'NASA GSFC Planetary Fact Sheet';
const body = (
  id: BodyId, label: string, radiusKm: number, flattening: number, gm: number,
  rotationHours: number, obliquityDeg: number, constantsSource = FACT
): PhysicalConstants =>
  Object.freeze({id, label, radiusKm, flattening, gm, rotationHours, obliquityDeg, constantsSource});

// prettier-ignore
export const PHYSICAL_CONSTANTS: Readonly<Record<BodyId, PhysicalConstants>> = Object.freeze({
  sun: body('sun', 'Sun', 695700, 0.00005, 1.32712440018e20, 609.12, 7.25),
  mercury: body('mercury', 'Mercury', 2440.5, 0.0009, 2.2032e13, 1407.6, 0.034),
  venus: body('venus', 'Venus', 6051.8, 0, 3.24859e14, -5832.6, 177.4),
  earth: body('earth', 'Earth', 6378.137, 1 / 298.257223563, 3.986004418e14, 23.9345, 23.4393, 'WGS84'),
  moon: body('moon', 'Moon', 1738.1, 0.0012, 4.9028e12, 655.72, 6.68),
  mars: body('mars', 'Mars', 3396.2, 0.00589, 4.282837e13, 24.6229, 25.19),
  jupiter: body('jupiter', 'Jupiter', 71492, 0.06487, 1.26686534e17, 9.925, 3.13),
  saturn: body('saturn', 'Saturn', 60268, 0.09796, 3.7931187e16, 10.656, 26.73),
  uranus: body('uranus', 'Uranus', 25559, 0.02293, 5.793939e15, -17.24, 97.77),
  neptune: body('neptune', 'Neptune', 24764, 0.01708, 6.836529e15, 16.11, 28.32)
});

export const BODY_IDS: readonly BodyId[] = Object.freeze(Object.keys(PHYSICAL_CONSTANTS) as BodyId[]);
export const PLANET_IDS: readonly PlanetId[] = Object.freeze([
  'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'
] as PlanetId[]);
