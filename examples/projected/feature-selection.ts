// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {FeatureSelectionResult} from '@vis.gl/tangram-renderer/core';

/** Query one click without publishing results after navigation, scene changes or disposal. */
export async function queryProjectedFeature(
  query: () => Promise<FeatureSelectionResult | undefined>,
  isCurrent: () => boolean,
  updateText: (text: string) => void
): Promise<void> {
  try {
    const result = await query();
    if (!isCurrent()) return;
    const feature = result?.feature;
    const properties = feature && typeof feature === 'object' && 'properties' in feature ? feature.properties : undefined;
    const name = properties && typeof properties === 'object' && 'name' in properties ? properties.name : undefined;
    updateText(result?.error ? `Selection failed: ${formatError(result.error)}` :
      typeof name === 'string' ? name : 'No interactive feature');
  } catch (error) {
    if (isCurrent()) updateText(`Selection failed: ${formatError(error)}`);
  }
}

/** Preserve useful messages without assuming a rejected value is an Error instance. */
function formatError(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ?
    error.message : String(error);
}
