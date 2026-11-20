// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {
  BasemapHeatmapLayer,
  createHeatmapSubLayer,
  getHeatmapColorRamp,
  getHeatmapPoints,
  getTilesWithoutDrawnAncestor
} from '../src/heatmap-layer';
import {getBasemapLayers, getStyleLayerRuns} from '../src/globe-layers';

const SOURCES = {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}};

function heatmap(paint: Record<string, unknown> = {}, id = 'heat'): any {
  return {id, type: 'heatmap', source: 'tiles', 'source-layer': 'poi', paint};
}

function point(coordinates: number[], properties: Record<string, unknown> = {}): any {
  return {
    type: 'Feature',
    geometry: {type: 'Point', coordinates},
    properties: {layerName: 'poi', ...properties}
  };
}

function texel(ramp: Uint8Array, index: number): number[] {
  return [...ramp.slice(index * 4, index * 4 + 4)];
}

describe('heatmap color ramp', () => {
  test('renders the default heatmap-color at 256 densities, premultiplied', () => {
    const ramp = getHeatmapColorRamp(heatmap());
    expect(ramp.length).toBe(256 * 4);
    // `rgba(0, 0, 255, 0)` at density 0, `royalblue` at 0.1, `lime` at 0.5 and `red` at 1.
    expect(texel(ramp, 0)).toEqual([0, 0, 0, 0]);
    expect(texel(ramp, 255)).toEqual([255, 0, 0, 255]);
    // Density 0.5 is between texels 127 and 128; texel 128 is lime moving towards yellow.
    expect(texel(ramp, 128)[1]).toBe(255);
    // Density 0.1 is between texels 25 and 26: royalblue, fading in from density 0.
    const [r, g, b, a] = texel(ramp, 26);
    expect(a).toBeGreaterThan(240);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
    // Premultiplied: no channel is above alpha.
    for (let index = 0; index < 256; index++) {
      const [red, green, blue, alpha] = texel(ramp, index);
      expect(Math.max(red, green, blue)).toBeLessThanOrEqual(alpha);
    }
  });

  test('evaluates heatmap-color over heatmap-density, rounding as MapLibre GL JS', () => {
    const ramp = getHeatmapColorRamp(
      heatmap({
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0,
          'rgba(255, 255, 255, 0)',
          1,
          'rgba(200, 100, 50, 0.5)'
        ]
      })
    );
    expect(texel(ramp, 255)).toEqual([
      Math.round((200 * 128) / 255),
      Math.round((100 * 128) / 255),
      Math.round((50 * 128) / 255),
      128
    ]);
    // Alpha rises linearly with the density.
    expect(texel(ramp, 51)[3]).toBe(Math.round(0.5 * (51 / 255) * 255));
  });

  test('returns the same ramp while heatmap-color is unchanged', () => {
    const layer = heatmap({'heatmap-color': ['step', ['heatmap-density'], 'blue', 0.5, 'red']});
    expect(getHeatmapColorRamp(layer)).toBe(getHeatmapColorRamp(layer));
    expect(getHeatmapColorRamp(heatmap())).toBe(getHeatmapColorRamp(heatmap()));
  });
});

describe('heatmap points', () => {
  test('keeps the points inside the tile, with their longitude/latitude', () => {
    const inside = point([0.5, 0.5]);
    const multi = {
      ...point([0, 0]),
      geometry: {
        type: 'MultiPoint',
        coordinates: [
          [0, 0],
          [0.999, 0.25],
          [1, 0.5]
        ]
      }
    };
    const buffered = point([-0.01, 0.5]);
    const line = {...point([0, 0]), geometry: {type: 'LineString', coordinates: [[0, 0], [1, 1]]}};
    const points = getHeatmapPoints([inside, multi, buffered, line], {x: 0, y: 0, z: 0}, false);
    // A point on the tile's right or bottom edge belongs to the next tile, as in MapLibre.
    expect(points.map(({feature}) => feature)).toEqual([inside, multi, multi]);
    expect(points[0].position[0]).toBeCloseTo(0);
    expect(points[0].position[1]).toBeCloseTo(0);
    expect(points[1].position[0]).toBeCloseTo(-180);
    expect(points[1].position[1]).toBeCloseTo(85.0511, 3);
  });

  test('reads tile-local positions at the tile index', () => {
    const [{position}] = getHeatmapPoints([point([0.5, 0.5])], {x: 1, y: 0, z: 1}, false);
    expect(position[0]).toBeCloseTo(90);
    expect(position[1]).toBeCloseTo(66.513, 2);
  });

  test('tests longitude/latitude points against the tile bounds', () => {
    const features = [point([90, 66.5]), point([-90, 66.5]), point([90, -10])];
    const points = getHeatmapPoints(features, {x: 1, y: 0, z: 1}, true);
    expect(points.map(({feature}) => feature)).toEqual([features[0]]);
    expect(points[0].position).toEqual([90, 66.5]);
  });

  test('returns the same points for the same features and tile', () => {
    const features = [point([0.5, 0.5])];
    const index = {x: 3, y: 4, z: 5};
    expect(getHeatmapPoints(features, index, false)).toBe(getHeatmapPoints(features, index, false));
  });
});

describe('heatmap tiles', () => {
  test('leaves out the tiles whose ancestor is drawn', () => {
    const parent = {index: {x: 1, y: 1, z: 1}};
    const child = {index: {x: 2, y: 3, z: 2}};
    const grandchild = {index: {x: 5, y: 6, z: 3}};
    const other = {index: {x: 0, y: 0, z: 2}};
    expect(getTilesWithoutDrawnAncestor([child, parent, grandchild, other])).toEqual([
      parent,
      other
    ]);
    expect(getTilesWithoutDrawnAncestor([child, grandchild])).toEqual([child]);
  });
});

describe('heatmap layers', () => {
  const points = [
    {position: [1, 2] as [number, number], feature: point([0, 0], {mag: 2})},
    {position: [3, 4] as [number, number], feature: point([0, 0], {mag: 4})}
  ];

  test('evaluates heatmap paint into the layer props', () => {
    const layer = createHeatmapSubLayer({
      props: {id: 'heat', opacity: 1},
      styleLayer: heatmap({
        'heatmap-radius': ['*', 5, ['get', 'mag']],
        'heatmap-weight': ['interpolate', ['linear'], ['zoom'], 0, 0, 10, ['get', 'mag']],
        'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 3],
        'heatmap-opacity': 0.5
      }),
      points,
      zoom: 5
    })!;
    expect(layer).toBeInstanceOf(BasemapHeatmapLayer);
    const props = layer.props as any;
    expect(props.data).toBe(points);
    expect(props.coordinateSystem).toBe('lnglat');
    expect(props.pickable).toBe(false);
    expect(props.opacity).toBe(0.5);
    expect(props.intensity).toBe(2);
    expect(points.map(props.getRadius)).toEqual([10, 20]);
    expect(points.map(props.getWeight)).toEqual([1, 2]);
    // The weight is data-driven and changes with zoom.
    expect(props.updateTriggers.getWeight).toBe(5);
    expect(props.getPosition(points[0])).toEqual([1, 2]);
  });

  test('takes the style specification defaults', () => {
    const props = createHeatmapSubLayer({
      props: {id: 'heat'},
      styleLayer: heatmap(),
      points,
      zoom: 5
    })!.props as any;
    expect(props.getRadius).toBe(30);
    expect(props.getWeight).toBe(1);
    expect(props.intensity).toBe(1);
    expect(props.opacity).toBe(1);
  });

  test('draws nothing at heatmap-opacity 0 or without points', () => {
    const styleLayer = heatmap({'heatmap-opacity': 0});
    expect(createHeatmapSubLayer({props: {id: 'heat'}, styleLayer, points, zoom: 5})).toBeNull();
    expect(
      createHeatmapSubLayer({props: {id: 'heat'}, styleLayer: heatmap(), points: [], zoom: 5})
    ).toBeNull();
  });
});

describe('heatmap style layers', () => {
  const style = (layers: any[]) => ({version: 8, sources: SOURCES, layers}) as any;
  const circle = (id: string) => ({id, type: 'circle', source: 'tiles', 'source-layer': 'poi'});

  test('draw in a run of their own, in style order', () => {
    const layers = [circle('before'), heatmap({}, 'heat'), circle('after'), heatmap({}, 'heat-2')];
    const runs = getStyleLayerRuns(layers, style(layers));
    expect(runs.map(run => run.styleLayers.map(layer => layer.id))).toEqual([
      ['before'],
      ['heat'],
      ['after'],
      ['heat-2']
    ]);
    expect(new Set(runs.map(run => run.id)).size).toBe(4);
  });

  test('record the points of each tile for the tile layer to draw', () => {
    const layers = [heatmap({'heatmap-radius': 12})];
    const tileLayer: any = getBasemapLayers({
      idPrefix: 'test',
      mode: 'map',
      zoom: 12,
      styleDefinition: style(layers)
    }).find(layer => layer.id === 'test-tiles');
    const recorded = new Map();
    const features = [point([0.5, 0.25]), point([1.5, 0.25])];
    const sublayers = tileLayer.props.renderSubLayers({
      id: 'test-tiles-tile',
      data: features,
      coordinateSystem: 'cartesian',
      tile: {index: {x: 0, y: 0, z: 12}},
      tileHeatmapPoints: recorded
    });
    // No sublayer per tile: the tile layer draws one layer for all tiles.
    expect(sublayers).toEqual([]);
    expect(recorded.get(0).map(({feature}: any) => feature)).toEqual([features[0]]);

    const [layer] = tileLayer.props.renderHeatmapLayers(recorded, (id: string) => ({id}));
    expect(layer).toBeInstanceOf(BasemapHeatmapLayer);
    expect(layer.props.data).toBe(recorded.get(0));
    expect(layer.props.getRadius).toBe(12);
  });
});
