// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {MakeTime} from 'astronomy-engine';

/** Days (TT) since J2000.0, from Astronomy Engine (TT = UTC + leap seconds + 32.184 s). */
export function getDaysTT(date: Date): number {
  return MakeTime(date).tt;
}

/** Julian centuries (TT) since J2000.0. */
export function getCenturiesTT(date: Date): number {
  return getDaysTT(date) / 36525;
}
