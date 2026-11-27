// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export type V3 = [number, number, number];

export const DEG = Math.PI / 180;

export const norm = (v: readonly number[]): number => Math.hypot(v[0], v[1], v[2]);
export const unit = (v: readonly number[]): V3 => {
  const n = norm(v);
  return [v[0] / n, v[1] / n, v[2] / n];
};
export const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const angleDeg = (a: readonly number[], b: readonly number[]): number =>
  Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) / DEG;
