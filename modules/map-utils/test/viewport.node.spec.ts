// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {_GlobeViewport as GlobeViewport, WebMercatorViewport} from '@deck.gl/core';
import {describe, expect, test} from 'vitest';
import {isGlobeViewport} from '@tangram.gl/map-utils/viewport';

const dimensions = {width: 100, height: 100};

describe('isGlobeViewport', () => {
  test('recognizes projection mode across deck.gl copies', () => {
    expect(isGlobeViewport({projectionMode: 2})).toBe(true);
    expect(isGlobeViewport({projectionMode: 1})).toBe(false);
  });

  test('distinguishes deck.gl globe and Mercator viewports', () => {
    expect(isGlobeViewport(new GlobeViewport(dimensions))).toBe(true);
    expect(isGlobeViewport(new WebMercatorViewport(dimensions))).toBe(false);
  });

  test('falls back to the globe class when the numeric mode is unavailable', () => {
    const MinifiedViewport = class a extends GlobeViewport {
      static override displayName = 'a';
    };
    const viewport = new MinifiedViewport(dimensions);
    Object.defineProperty(viewport, 'projectionMode', {value: undefined});
    expect(isGlobeViewport(viewport)).toBe(true);
    expect(isGlobeViewport({projectionMode: '2'})).toBe(false);
  });

  test('gives numeric projection mode precedence over the viewport class', () => {
    const viewport = new GlobeViewport(dimensions);
    Object.defineProperty(viewport, 'projectionMode', {value: 1});
    expect(isGlobeViewport(viewport)).toBe(false);
  });

  test('rejects missing viewports', () => {
    expect(isGlobeViewport(null)).toBe(false);
    expect(isGlobeViewport(undefined)).toBe(false);
  });
});
