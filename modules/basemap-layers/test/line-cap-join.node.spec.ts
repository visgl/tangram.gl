// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {testLayer} from '@deck.gl/test-utils/vitest';
import {NullDevice} from '@luma.gl/core/test-utils';
import {describe, expect, test} from 'vitest';
import {getLineShape} from '../src/globe-layers';
import {getBasemapLayers} from '../src/index.ts';
import {LineDashExtension} from '../src/line-dash-extension';
import {LineShapeExtension} from '../src/line-shape-extension';

const SOURCES = {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}};

function lineFeature(properties: Record<string, unknown> = {}) {
  return {
    type: 'Feature',
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1]
      ]
    },
    properties: {layerName: 'transportation', ...properties}
  };
}

/** Renders one style layer for one tile and returns its sublayers. */
function sublayersFor(
  styleLayer: Record<string, unknown>,
  features: unknown[] = [lineFeature()],
  zoom = 12
): any[] {
  const vectorLayer: any = getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom,
    styleDefinition: {
      version: 8,
      sources: SOURCES,
      layers: [{id: 'road', source: 'tiles', 'source-layer': 'transportation', ...styleLayer}]
    } as any
  }).find(layer => layer.id === 'test-tiles');
  // deck.gl flattens nested sublayer arrays, as a style layer split by shape returns.
  return vectorLayer.props
    .renderSubLayers({
      id: 'test-tiles-tile',
      data: features,
      tile: {index: {x: 0, y: 0, z: zoom}}
    })
    .flat();
}

function lineSublayerFor(layout?: Record<string, unknown>): any {
  const sublayers = sublayersFor({type: 'line', paint: {'line-width': 4}, layout});
  expect(sublayers).toHaveLength(1);
  return sublayers[0];
}

/** The cap, join and miter limit props of a sublayer. */
function shapeOf(sublayer: any) {
  const {lineCapRounded, lineCapSquare, lineJointRounded, lineMiterLimit} = sublayer.props;
  return {lineCapRounded, lineCapSquare, lineJointRounded, lineMiterLimit};
}

const webglPath = {context: {device: {type: 'webgl'}}, state: {pathTesselator: {}}};

test('square cap shifts are gated by the path endpoint flags', () => {
  const extension = new LineShapeExtension();
  const {plugins} = Reflect.apply(extension.getShaders, webglPath, []);
  const vertex = plugins[0].injections.find(({target}: {target: string}) => target === '#main-end').glsl;
  expect(vertex).toContain('if (!endVertex && isPathStart)');
  expect(vertex).toContain('else if (endVertex && isPathEnd)');
});

test('round dash shaders intersect the resolved cap with the stroke fade', () => {
  const extension = new LineDashExtension();
  const {plugins} = Reflect.apply(extension.getShaders, webglPath, [extension]);
  const fragment = plugins[0].injections.find(
    ({stage, target}: {stage: string; target: string}) => stage === 'fragment' && target === '#main-end'
  ).glsl;
  expect(fragment).toContain('strokeCoverage = lineBlur_fade;');
  expect(fragment).toContain('min(strokeCoverage, lineDash_coverage)');
});

describe('line-cap and line-join', () => {
  test('defaults to butt caps and miter joins with a miter limit of 2', () => {
    // deck.gl cuts joins at miterLimit + 1 half widths, MapLibre at line-miter-limit.
    expect(shapeOf(lineSublayerFor())).toEqual({
      lineCapRounded: false,
      lineCapSquare: false,
      lineJointRounded: false,
      lineMiterLimit: 1
    });
  });

  test.each([
    ['round', true, false],
    ['butt', false, false],
    ['square', false, true]
  ])('line-cap %s', (cap, lineCapRounded, lineCapSquare) => {
    expect(shapeOf(lineSublayerFor({'line-cap': cap}))).toMatchObject({lineCapRounded, lineCapSquare});
  });

  test('installs the shape extension for square caps even with round joins', () => {
    const square = lineSublayerFor({'line-cap': 'square', 'line-join': 'round'});
    const round = lineSublayerFor({'line-cap': 'round', 'line-join': 'round'});
    expect(square.props.extensions.some((extension: unknown) => extension instanceof LineShapeExtension))
      .toBe(true);
    expect(round.props.extensions.some((extension: unknown) => extension instanceof LineShapeExtension))
      .toBe(false);
  });

  test('keeps default miter bevels and skips joins the shape shader cannot change', () => {
    expect(lineSublayerFor().props.extensions).toContainEqual(new LineShapeExtension());
    const [offset] = sublayersFor({
      type: 'line',
      layout: {'line-join': 'bevel'},
      paint: {'line-offset': 3}
    });
    expect(offset.props.extensions).not.toContainEqual(new LineShapeExtension());
    const unlimited = lineSublayerFor({'line-miter-limit': 1000});
    expect(unlimited.props.extensions).not.toContainEqual(new LineShapeExtension());
  });

  test('square gap caps use the per-feature gap and unblurred width on both sides', () => {
    const features = [lineFeature({gap: 10}), lineFeature({gap: 0})];
    const layers = sublayersFor(
      {
        type: 'line',
        layout: {'line-cap': 'square'},
        paint: {
          'line-width': 2,
          'line-gap-width': ['get', 'gap'],
          'line-offset': 3,
          'line-blur': 4,
          'line-dasharray': [2, 2]
        }
      },
      features
    );
    expect(layers).toHaveLength(2);
    for (const layer of layers) {
      expect(features.map(layer.props.getSquareGapCap)).toEqual([7, 0]);
    }
    const device = new NullDevice({_cachePipelines: false});
    Object.defineProperty(device, 'type', {value: 'webgl'});
    try {
      testLayer({
        Layer: layers[0].constructor,
        device,
        draw: false,
        onError: error => { throw error; },
        testCases: [{
          title: 'assembles the dashed square gap line',
          props: {
            ...layers[0].props,
            data: features,
            coordinateOrigin: [0, 0, 0],
            coordinateSystem: 'default',
            opacity: 1,
            visible: true
          },
          onAfterUpdate: ({subLayer}) => {
            const offset = subLayer?.getAttributeManager()?.getAttributes().instanceOffsets;
            expect(offset?.size).toBe(2);
            expect(offset?.value?.[0]).toBeCloseTo(7 / 6);
            expect(offset?.value?.[1]).toBe(7);
            const [model] = subLayer?.getModels() ?? [];
            expect(model.vs).toContain('in vec2 instanceOffsetAndCap;');
            expect(model.vs).toContain('#define instanceOffsets instanceOffsetAndCap.x');
            expect(model.vs).toContain('capLength = project_pixel_size(instanceOffsetAndCap.y);');
            expect(model.vs).not.toContain('in float instanceOffsets;');
          }
        }]
      });
    } finally {
      device.destroy();
    }
  });

  test('line-join round', () => {
    const sublayer = lineSublayerFor({'line-join': 'round'});
    expect(sublayer.props.lineJointRounded).toBe(true);
  });

  test('bevel joins use the fixed 1.05 miter limit', () => {
    const shape = getLineShape(['square', 'bevel', 10]);
    expect(shape).toEqual({
      lineCapRounded: false, lineCapSquare: true, lineJointRounded: false, lineMiterLimit: 0.05
    });
    expect(shapeOf(lineSublayerFor({
      'line-cap': 'square', 'line-join': 'bevel', 'line-miter-limit': 10
    }))).toEqual(shape);
  });

  test.each([
    [4, 3],
    [1, 0],
    [0.5, 0]
  ])('line-miter-limit %s is deck.gl miterLimit %s', (limit, miterLimit) => {
    expect(
      lineSublayerFor({'line-join': 'miter', 'line-miter-limit': limit}).props.lineMiterLimit
    ).toBe(miterLimit);
  });

  test('evaluates zoom-dependent values at the style zoom', () => {
    const layout = {
      'line-cap': ['step', ['zoom'], 'butt', 13, 'round'],
      'line-join': ['step', ['zoom'], 'miter', 13, 'round']
    };
    const [low] = sublayersFor({type: 'line', layout}, [lineFeature()], 12);
    const [high] = sublayersFor({type: 'line', layout}, [lineFeature()], 13);
    expect(shapeOf(low)).toMatchObject({lineCapRounded: false, lineJointRounded: false});
    expect(shapeOf(high)).toMatchObject({lineCapRounded: true, lineJointRounded: true});
  });

  test('per-feature values split the features into one sublayer per shape', () => {
    const features = [
      lineFeature({kind: 'rail'}),
      lineFeature({kind: 'road'}),
      lineFeature({kind: 'rail'}),
      lineFeature({kind: 'path'}),
      lineFeature({kind: 'square'})
    ];
    const sublayers = sublayersFor(
      {
        type: 'line',
        layout: {
          'line-cap': ['match', ['get', 'kind'], 'road', 'round', 'square', 'square', 'butt'],
          'line-join': ['match', ['get', 'kind'], 'path', 'bevel', 'round']
        }
      },
      features
    );

    expect(sublayers).toHaveLength(4);
    expect(
      sublayers.map(sublayer => sublayer.props.data.map((f: any) => f.properties.kind))
    ).toEqual([['rail', 'rail'], ['road'], ['path'], ['square']]);
    expect(sublayers.map(shapeOf)).toEqual([
      {lineCapRounded: false, lineCapSquare: false, lineJointRounded: true, lineMiterLimit: 0},
      {lineCapRounded: true, lineCapSquare: false, lineJointRounded: true, lineMiterLimit: 0},
      {lineCapRounded: false, lineCapSquare: false, lineJointRounded: false, lineMiterLimit: 0.05},
      {lineCapRounded: false, lineCapSquare: true, lineJointRounded: true, lineMiterLimit: 0}
    ]);
    expect(new Set(sublayers.map(sublayer => sublayer.id)).size).toBe(4);
  });

  describe('per-feature shape groups across zoom steps', () => {
    const features = [lineFeature({kind: 'road'}), lineFeature({kind: 'rail'})];

    /** Renders the same style and tile at each zoom and returns each zoom's sublayer data. */
    function groupDataAt(layout: Record<string, unknown>, zooms: number[]): any[][][] {
      const style = {
        version: 8,
        sources: SOURCES,
        layers: [
          {id: 'road', type: 'line', source: 'tiles', 'source-layer': 'transportation', layout}
        ]
      } as any;
      return zooms.map(zoom => {
        const vectorLayer: any = getBasemapLayers({
          idPrefix: 'test',
          mode: 'map',
          zoom,
          styleDefinition: style
        }).find(layer => layer.id === 'test-tiles');
        return vectorLayer.props
          .renderSubLayers({
            id: 'test-tiles-tile',
            data: features,
            tile: {index: {x: 0, y: 0, z: 12}}
          })
          .flat()
          .map((sublayer: any) => sublayer.props.data);
      });
    }

    test('reuse their feature arrays when the values do not depend on zoom', () => {
      const [first, second] = groupDataAt(
        {'line-cap': ['match', ['get', 'kind'], 'road', 'round', 'butt']},
        [12, 12.5]
      );
      expect(first).toHaveLength(2);
      expect(second[0]).toBe(first[0]);
      expect(second[1]).toBe(first[1]);
    });

    test('regroup at each zoom step when the values depend on zoom', () => {
      const [first, second, third] = groupDataAt(
        {
          'line-cap': [
            'step',
            ['zoom'],
            ['match', ['get', 'kind'], 'road', 'round', 'butt'],
            13,
            'round'
          ]
        },
        [12, 12, 13]
      );
      expect(second[0]).toBe(first[0]);
      expect(first).toHaveLength(2);
      expect(third).toHaveLength(1);
      expect(third[0]).toHaveLength(2);
    });
  });

  test('per-feature values that agree draw one sublayer', () => {
    const sublayers = sublayersFor(
      {type: 'line', layout: {'line-join': ['coalesce', ['get', 'join'], 'round']}},
      [lineFeature(), lineFeature()]
    );
    expect(sublayers).toHaveLength(1);
    expect(sublayers[0].props.data).toHaveLength(2);
    expect(sublayers[0].props.lineJointRounded).toBe(true);
  });

  test('fill outlines keep square joins', () => {
    const square = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0]
          ]
        ]
      },
      properties: {layerName: 'transportation'}
    };
    const [sublayer] = sublayersFor({type: 'fill', paint: {'fill-outline-color': '#000000'}}, [
      square
    ]);
    expect(sublayer.props.lineCapRounded).toBe(false);
    expect(sublayer.props.lineJointRounded).toBe(false);
    expect(sublayer.props.extensions.some((extension: unknown) => extension instanceof LineShapeExtension))
      .toBe(false);
  });
});
