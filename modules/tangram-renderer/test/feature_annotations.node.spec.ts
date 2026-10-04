// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {getFeatureRenderedGeneration, markFeatureRendered} from '../src/styles/feature_annotations';

test('frozen decoded features remain unchanged while shared visibility keeps aggregate generation semantics', () => {
    const feature = Object.freeze({properties: Object.freeze({kind: 'road'})});
    markFeatureRendered(feature, 1); expect(getFeatureRenderedGeneration(feature)).toBe(1);
    markFeatureRendered(feature, 2); expect(getFeatureRenderedGeneration(feature)).toBe(2);
    expect(feature).not.toHaveProperty('generation');
});

test('legacy custom annotations remain readable, and unrelated features do not share sidecars', () => {
    const first = {generation: 1}, second = {generation: 3};
    expect(getFeatureRenderedGeneration(first)).toBe(1);
    markFeatureRendered(first, 2);
    expect(getFeatureRenderedGeneration(first)).toBe(2); expect(getFeatureRenderedGeneration(second)).toBe(3);
    expect(getFeatureRenderedGeneration({})).toBeUndefined(); expect(first.generation).toBe(1);
});
