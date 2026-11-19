// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {getBasemapLayers, getGlobeBaseLayers} from '../src/index.ts';
import {
  type BasemapFeatureState,
  getFeatureStateId,
  getPickedFeature
} from '../src/feature-state';

// `["feature-state", key]` in paint reads the `featureState` the layers are made with. A change of
// state gives the style layers that read it new paint update triggers, and the same data: deck.gl
// then computes their paint attributes again, and keeps their geometry.

const square = (x: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [x, 0],
      [x + 0.2, 0],
      [x + 0.2, 0.2],
      [x, 0.2],
      [x, 0]
    ]
  ]
});

const CONTENT = [
  {type: 'Feature', id: 1, geometry: square(0), properties: {layerName: 'building', ref: 'a'}},
  {type: 'Feature', id: 2, geometry: square(0.4), properties: {layerName: 'building', ref: 'b'}},
  {
    type: 'Feature',
    id: 1,
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0.5],
        [1, 0.5]
      ]
    },
    properties: {layerName: 'road', ref: 'c'}
  }
];

const HOVER_COLOR = [
  'case',
  ['boolean', ['feature-state', 'hover'], false],
  '#ff0000',
  '#0000ff'
];

const STYLE_LAYERS = [
  {
    id: 'building',
    type: 'fill',
    source: 'tiles',
    'source-layer': 'building',
    paint: {'fill-color': HOVER_COLOR, 'fill-antialias': false}
  },
  {
    id: 'road',
    type: 'line',
    source: 'tiles',
    'source-layer': 'road',
    paint: {'line-color': '#00ff00', 'line-width': 2}
  }
];

function getTileLayer(
  featureState: BasemapFeatureState | null,
  styleLayers: any[] = STYLE_LAYERS,
  source: Record<string, unknown> = {}
): any {
  return getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom: 8.1,
    featureState,
    styleDefinition: {
      version: 8,
      sources: {
        tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt'], ...source}
      },
      layers: styleLayers
    } as any
  }).find((layer: any) => layer.id === 'test-tiles');
}

/** Renders one tile of the tile layer, as deck.gl does after an update of its triggers. */
function render(tileLayer: any, state?: any) {
  tileLayer.context = {viewport: {zoom: 8.1, resolution: 0}, device: {type: 'webgl'}};
  tileLayer.internalState = {};
  tileLayer.state = state ?? {
    tileLayers: new Map(),
    tilesetViews: new Map([['default', {isTileVisible: () => true}]]),
    tileset: {
      tiles: [
        {
          id: 'a',
          index: {x: 0, y: 0, z: 8},
          bbox: {west: 0, south: 0, east: 1, north: 1},
          isLoaded: true,
          content: CONTENT
        }
      ]
    }
  };
  tileLayer.state.tileLayers.clear();
  const layers: any[] = tileLayer.renderLayers();
  return {state: tileLayer.state, layers: new Map(layers.map(layer => [layer.id, layer]))};
}

const BUILDING = 'test-tiles-a-"building"';
const ROAD = 'test-tiles-a-"road"';

describe('feature-state in paint', () => {
  test('reads the state of each feature by source, source layer and id', () => {
    const {layers} = render(getTileLayer({tiles: {building: {2: {hover: true}}}}));
    const getFillColor = layers.get(BUILDING).props.getFillColor;
    expect(typeof getFillColor).toBe('function');
    expect(getFillColor(CONTENT[0], {index: 0})).toEqual([0, 0, 255, 255]);
    expect(getFillColor(CONTENT[1], {index: 1})).toEqual([255, 0, 0, 255]);
  });

  test('is empty without states, as before', () => {
    const {layers} = render(getTileLayer(null));
    const getFillColor = layers.get(BUILDING).props.getFillColor;
    expect(getFillColor(CONTENT[1], {index: 1})).toEqual([0, 0, 255, 255]);
  });

  test('does not read the states of another source layer', () => {
    // The road's feature 1 shares its id with building 1.
    const {layers} = render(getTileLayer({tiles: {road: {1: {hover: true}}}}));
    const getFillColor = layers.get(BUILDING).props.getFillColor;
    expect(getFillColor(CONTENT[0], {index: 0})).toEqual([0, 0, 255, 255]);
  });

  test("keeps a state under a vector source's promoteId", () => {
    const tileLayer = getTileLayer({tiles: {building: {b: {hover: true}}}}, STYLE_LAYERS, {
      promoteId: {building: 'ref'}
    });
    const getFillColor = render(tileLayer).layers.get(BUILDING).props.getFillColor;
    expect(getFillColor(CONTENT[0], {index: 0})).toEqual([0, 0, 255, 255]);
    expect(getFillColor(CONTENT[1], {index: 1})).toEqual([255, 0, 0, 255]);
  });
});

describe('a change of feature state', () => {
  test('changes only the paint update triggers of the style layers that read it', () => {
    const first = render(getTileLayer({tiles: {building: {1: {hover: true}}}}));
    const secondTileLayer = getTileLayer({tiles: {building: {2: {hover: true}}}});
    const second = render(secondTileLayer, first.state);

    const before = first.layers.get(BUILDING);
    const after = second.layers.get(BUILDING);
    expect(after).not.toBe(before);
    // The same data: deck.gl does not tessellate the polygons again.
    expect(after.props.data).toBe(before.props.data);
    const changed = Object.keys(after.props.updateTriggers).filter(
      name => after.props.updateTriggers[name] !== before.props.updateTriggers[name]
    );
    // Paint only: a fill's outline color is its `fill-color` too.
    expect(changed.sort()).toEqual(['getFillColor', 'getLineColor']);
    expect(after.props.getFillColor(CONTENT[1], {index: 1})).toEqual([255, 0, 0, 255]);

    // A style layer that does not read feature state keeps its sublayer.
    expect(second.layers.get(ROAD)).toBe(first.layers.get(ROAD));
  });

  test('regenerates the tiles only when a state that the paint reads changes', () => {
    const trigger = (featureState: BasemapFeatureState | null) =>
      getTileLayer(featureState).props.updateTriggers.renderSubLayers;
    const buildings = {1: {hover: true}};
    expect(trigger({tiles: {building: buildings}})).toEqual(
      trigger({tiles: {building: buildings}})
    );
    // The road does not read feature state, and no style layer reads another source's.
    expect(trigger({tiles: {building: buildings, road: {1: {hover: true}}}})).toEqual(
      trigger({tiles: {building: buildings}})
    );
    expect(trigger({other: {x: {}}, tiles: {building: buildings}})).toEqual(
      trigger({tiles: {building: buildings}})
    );
    expect(trigger({tiles: {building: {...buildings}}})).not.toEqual(
      trigger({tiles: {building: buildings}})
    );
  });

  test('leaves the update triggers of a style without feature-state as they are', () => {
    const styleLayers = [
      STYLE_LAYERS[1],
      {...STYLE_LAYERS[0], paint: {'fill-color': ['get', 'color']}}
    ];
    const a = getTileLayer(null, styleLayers).props.updateTriggers.renderSubLayers;
    const b = getTileLayer({tiles: {building: {1: {hover: true}}}}, styleLayers).props
      .updateTriggers.renderSubLayers;
    expect(b).toEqual(a);
  });
});

describe('the globe helper', () => {
  function getGlobeTileLayer(featureState: BasemapFeatureState | null, pickable?: boolean): any {
    return getGlobeBaseLayers({
      idPrefix: 'globe',
      zoom: 8.1,
      featureState,
      pickable,
      styleDefinition: {
        version: 8,
        sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
        layers: STYLE_LAYERS
      } as any,
      globe: {config: {atmosphere: false, basemap: true, labels: true}}
    } as any).find((layer: any) => layer.id === 'globe-tiles');
  }

  test('forwards the feature states and pickable', () => {
    const trigger = (featureState: BasemapFeatureState | null) =>
      getGlobeTileLayer(featureState).props.updateTriggers.renderSubLayers;
    expect(trigger({tiles: {building: {1: {hover: true}}}})).not.toEqual(trigger(null));
    expect(getGlobeTileLayer(null, true).props.pickable).toBe(true);
  });
});

describe('picked features', () => {
  test('name their source, source layer, style layer and id, as MapLibre GL JS does', () => {
    const picked = getPickedFeature(
      CONTENT[1] as any,
      'tiles',
      {type: 'vector'},
      'building'
    );
    expect(picked).toEqual({
      id: 2,
      source: 'tiles',
      sourceLayer: 'building',
      styleLayerId: 'building',
      properties: {ref: 'b'}
    });
  });

  test("of a GeoJSON source have no source layer, and keep every property", () => {
    const feature = {id: 'x', properties: {layerName: 'kept'}};
    expect(getPickedFeature(feature, 'shapes', {type: 'geojson'}, 'shape')).toEqual({
      id: 'x',
      source: 'shapes',
      sourceLayer: undefined,
      styleLayerId: 'shape',
      properties: {layerName: 'kept'}
    });
  });

  test('take the id from promoteId', () => {
    const feature = {id: 2, properties: {ref: 'b'}};
    expect(getFeatureStateId(feature, {type: 'vector', promoteId: 'ref'}, 'building')).toBe('b');
    expect(
      getFeatureStateId(feature, {type: 'vector', promoteId: {road: 'ref'}}, 'building')
    ).toBe(undefined);
    expect(getFeatureStateId(feature, {type: 'vector'}, 'building')).toBe(2);
  });
});
