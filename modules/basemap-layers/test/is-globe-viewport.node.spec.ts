// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {_GlobeViewport as GlobeViewport, WebMercatorViewport} from '@deck.gl/core';
import {describe, expect, test} from 'vitest';
import {isGlobeViewport} from '../src/is-globe-viewport';

describe('isGlobeViewport', () => {
  test('recognizes projection mode across deck.gl copies', () => {
    expect(isGlobeViewport({projectionMode: 2})).toBe(true);
    expect(isGlobeViewport({projectionMode: 1})).toBe(false);
    expect(isGlobeViewport(null)).toBe(false);
  });

  test('recognizes deck.gl globe but not Mercator', () => {
    expect(isGlobeViewport(new GlobeViewport({width: 100, height: 100}))).toBe(true);
    expect(isGlobeViewport(new WebMercatorViewport({width: 100, height: 100}))).toBe(false);
  });
});
