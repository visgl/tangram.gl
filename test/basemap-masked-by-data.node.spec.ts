// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {
  getStyleLayerIds,
  type LayerNode
} from '../examples/layers/basemap-masked-by-data/basemap-mask-extension';

// The ids of the style layers that a sublayer of `BasemapLayer` draws, read from the ids of the
// sublayer and of the composite layers that render it.

/** A chain of layers: the first id is the top-level layer, the last one is the returned layer. */
function createLayer(...ids: string[]): LayerNode {
  let layer: LayerNode | null = null;
  for (const id of ids) {
    layer = {id, parent: layer};
  }
  return layer!;
}

describe('getStyleLayerIds', () => {
  test('reads the JSON id of a style layer of a vector source', () => {
    const layer = createLayer('basemap', 'basemap-openmaptiles', 'basemap-openmaptiles-"water"-fill');
    expect(getStyleLayerIds(layer)).toEqual(['water']);
  });

  test('reads the JSON ids of style layers that draw together', () => {
    const layer = createLayer('basemap', 'basemap-openmaptiles-["road","road-casing"]-path');
    expect(getStyleLayerIds(layer)).toEqual(['road', 'road-casing']);
  });

  test('reads the id of a background style layer, which has no quotes', () => {
    expect(getStyleLayerIds(createLayer('basemap', 'basemap-background'))).toEqual(['background']);
  });

  test('reads the id of a raster style layer from the sublayer that the basemap renders', () => {
    const layer = createLayer(
      'basemap',
      'basemap-natural_earth',
      'basemap-natural_earth-2-1-1',
      'basemap-natural_earth-2-1-1-bitmap'
    );
    expect(getStyleLayerIds(layer)).toEqual(['natural_earth']);
  });

  test('returns no ids for a layer that a basemap does not render', () => {
    expect(getStyleLayerIds(createLayer('basemap'))).toEqual([]);
    expect(getStyleLayerIds(createLayer('track', 'mask-polygons'))).toEqual([]);
  });
});
