// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** What the status line of the readout shows. */
export type StatusState = {
  /** Why the basemap style did not load, or null. */
  styleError: string | null;
  /** For each raster, why its last read failed. A later read that succeeds removes the error. */
  rasterErrors: (string | undefined)[];
  /** Whether the raster is drawn. */
  imagery: boolean;
  /** The size of the finest pixels that are drawn, in metres, or Infinity before the first read. */
  finest: number;
  pendingReads: number;
};

/**
 * The status line of the readout. An error stays in it until the read that failed succeeds, or the
 * scene changes, so that a render does not replace it.
 */
export function getStatusText({
  styleError,
  rasterErrors,
  imagery,
  finest,
  pendingReads
}: StatusState): string {
  const lines = [styleError];
  if (imagery) {
    lines.push(rasterErrors.find(Boolean) ?? null);
    const loading = pendingReads > 0 ? ' · loading…' : '';
    lines.push(
      Number.isFinite(finest) ? `Raster: ${Math.round(finest)} m pixels${loading}` : `Raster${loading}`
    );
  }
  return lines.filter(Boolean).join('\n');
}
