// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

const STORAGE_KEY = 'tangram.gl.examples.maplibreComparison';
type ComparisonStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Browsers may deny storage access; comparison remains usable for the current page. */
function getComparisonStorage(): ComparisonStorage | undefined {
  try {return typeof window === 'undefined' ? undefined : window.localStorage;}
  catch {return undefined;}
}

/** Explicit bookmarks override the saved choice; a new browser starts with comparison off. */
export function readComparisonPreference(parameters: URLSearchParams, storage = getComparisonStorage()): boolean {
  const explicit = parameters.get('compare');
  if (explicit !== null) return explicit === 'maplibre';
  try {return storage?.getItem(STORAGE_KEY) === 'true';}
  catch {return false;}
}

/** Remember only an explicit toggle, not an unsupported view, failed load or shared URL. */
export function writeComparisonPreference(enabled: boolean, storage = getComparisonStorage()): void {
  try {storage?.setItem(STORAGE_KEY, String(enabled));}
  catch { /* Storage is optional; do not prevent the current-page toggle. */ }
}
