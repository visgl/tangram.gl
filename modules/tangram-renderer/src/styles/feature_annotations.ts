// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Shared feature visibility keeps the legacy aggregate-generation semantics without mutating content. */
const renderedGenerations = new WeakMap<object, number>();

/** Mark successful built-in geometry generation in sidecar state, never on decoded features. */
export function markFeatureRendered(feature: object, generation: number): void {
    renderedGenerations.set(feature, generation);
}

/** Read built-in sidecar visibility, falling back to annotations supplied by legacy custom code. */
export function getFeatureRenderedGeneration(feature: object): unknown {
    return renderedGenerations.get(feature) ?? ('generation' in feature ? feature.generation : undefined);
}
