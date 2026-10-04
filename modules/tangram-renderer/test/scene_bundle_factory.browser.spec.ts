// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {SceneBundle, ZipSceneBundle, createSceneBundle} from '../src/scene/scene_bundle';

test.each(['scene.yaml', 'scene.zip'])('accepts omitted factory path and parent for %s', url => {
    // Keep these calls in a checked TypeScript test so optional arguments cannot regress.
    const inferred = createSceneBundle(url);
    const explicitUndefined = createSceneBundle(url, undefined, undefined);
    const explicitPath = createSceneBundle(url, 'https://example.com/maps/');
    const expectedType = url.endsWith('.zip') ? ZipSceneBundle : SceneBundle;
    expect(inferred).toBeInstanceOf(expectedType);
    expect(explicitUndefined).toBeInstanceOf(expectedType);
    expect(explicitPath).toBeInstanceOf(expectedType);
    expect(inferred.parent).toBeNull();
    expect(explicitUndefined.parent).toBeNull();
    expect(explicitPath.path_for_parent).toBe('https://example.com/maps/');
    expect(explicitPath.path).toBe(url.endsWith('.zip') ? '' : 'https://example.com/maps/');
    expect(explicitPath.parent).toBeNull();
});
