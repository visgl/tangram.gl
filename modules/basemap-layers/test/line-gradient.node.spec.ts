// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import {log} from '@deck.gl/core';
import {getBasemapLayers} from '../src/index';
import {getGeoJsonTileFeatures, getGeoJsonVtOptions} from '../src/geojson-source';
import {
  LineGradientExtension,
  getLineClip,
  getLineGradientRamp
} from '../src/line-gradient-extension';
import {createSegmentAttributeUpdate} from '../src/line-metrics';

afterEach(() => {
  vi.restoreAllMocks();
});

const LINE = {
  type: 'Feature',
  properties: {name: 'route'},
  geometry: {
    type: 'LineString',
    coordinates: [
      [-90, 20],
      [-10, 20],
      [90, 20]
    ]
  }
};

const RAINBOW = [
  'interpolate',
  ['linear'],
  ['line-progress'],
  0,
  '#0000ff',
  0.5,
  '#00ff00',
  1,
  '#ff0000'
];

function evaluate(accessor: unknown, object: unknown) {
  return typeof accessor === 'function' ? accessor(object, {index: 0}) : accessor;
}

/** The RGBA pixel of a ramp at `index`. */
function pixel(ramp: ReturnType<typeof getLineGradientRamp>, index: number): number[] {
  return Array.from(ramp!.image.data.subarray(index * 4, index * 4 + 4));
}

describe('lineMetrics', () => {
  test('is passed to geojson-vt', () => {
    expect(getGeoJsonVtOptions({type: 'geojson', data: LINE}).lineMetrics).toBe(false);
    const options = getGeoJsonVtOptions({type: 'geojson', data: LINE, lineMetrics: true});
    expect(options.lineMetrics).toBe(true);
  });

  test("records each tiled line's part of its whole line, as MapLibre reads it", async () => {
    const source = {type: 'geojson', data: LINE, lineMetrics: true, buffer: 0};
    // The zoom 1 tiles split the line at longitude 0, half way along it.
    const [west] = await getGeoJsonTileFeatures(source, {x: 0, y: 0, z: 1});
    const [east] = await getGeoJsonTileFeatures(source, {x: 1, y: 0, z: 1});
    expect(getLineClip(west as any)).toEqual([0, expect.closeTo(0.5, 6)]);
    expect(getLineClip(east as any)).toEqual([expect.closeTo(0.5, 6), 1]);
    expect(west.properties).toMatchObject({name: 'route'});
    // Without lineMetrics, a line runs over its whole length.
    const [plain] = await getGeoJsonTileFeatures(
      {...source, lineMetrics: false},
      {x: 0, y: 0, z: 1}
    );
    expect(getLineClip(plain as any)).toEqual([0, 1]);
  });
});

describe('getLineGradientRamp', () => {
  test('evaluates line-progress from 0 at the first pixel to the last, unpremultiplied', () => {
    const ramp = getLineGradientRamp({
      paint: {
        'line-gradient': [
          'interpolate',
          ['linear'],
          ['line-progress'],
          0,
          'rgba(0, 0, 255, 0.5)',
          1,
          '#ff0000'
        ]
      }
    });
    expect(ramp!.image.width).toBe(256);
    expect(ramp!.image.height).toBe(1);
    expect(pixel(ramp, 0)).toEqual([0, 0, 255, 128]);
    expect(pixel(ramp, 255)).toEqual([255, 0, 0, 255]);
    expect(ramp!.textureParameters).toMatchObject({
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'none'
    });
  });

  test('interpolates between stops', () => {
    const ramp = getLineGradientRamp({paint: {'line-gradient': RAINBOW}});
    // Pixel 51 is at progress 0.2: 40% of the way from blue to green.
    const [r, g, b] = pixel(ramp, 51);
    expect(r).toBe(0);
    expect(g).toBeGreaterThan(90);
    expect(g).toBeLessThan(115);
    expect(b).toBeGreaterThan(140);
  });

  test('draws a step gradient wider and with the nearest pixel, as MapLibre', () => {
    const ramp = getLineGradientRamp({
      paint: {'line-gradient': ['step', ['line-progress'], '#0000ff', 0.5, '#ff0000']}
    });
    const {width} = ramp!.image;
    expect(width).toBe(2048);
    expect(ramp!.textureParameters).toMatchObject({minFilter: 'nearest', magFilter: 'nearest'});
    expect(pixel(ramp, Math.floor((width - 1) / 2))).toEqual([0, 0, 255, 255]);
    expect(pixel(ramp, Math.ceil((width - 1) / 2))).toEqual([255, 0, 0, 255]);
  });

  test('is null without a valid gradient, and cached while the value is unchanged', () => {
    vi.spyOn(log, 'warn').mockReturnValue(() => {});
    expect(getLineGradientRamp({paint: {}})).toBeNull();
    expect(getLineGradientRamp({paint: {'line-gradient': ['zoom']}})).toBeNull();
    const styleLayer = {paint: {'line-gradient': RAINBOW} as Record<string, unknown>};
    const ramp = getLineGradientRamp(styleLayer);
    expect(getLineGradientRamp(styleLayer)).toBe(ramp);
    styleLayer.paint['line-gradient'] = [...RAINBOW];
    expect(getLineGradientRamp(styleLayer)).not.toBe(ramp);
  });
});

describe('segment distances', () => {
  /** A `PathLayer` stand-in holding two paths: three vertices, then two, each with padding. */
  function fakePathLayer() {
    // Path 0: (0, 0) - (3, 4) - (3, 10), 5 + 6 long. Path 1: (0, 0) - (0, 2).
    const positions = [0, 0, 0, 3, 4, 0, 3, 10, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0];
    return {
      props: {data: [{clip: [0.5, 1]}, {clip: [0, 0.25]}]},
      state: {
        pathTesselator: {
          vertexStarts: [0, 4],
          instanceCount: 7,
          get: (name: string) => (name === 'positions' ? positions : null),
          getPathSegmentIndices: (row: number) => (row === 0 ? [0, 1] : [4])
        }
      },
      projectPosition: (position: number[]) => position
    };
  }

  test('measure each segment from its path start, with its path object; padding gets 0', () => {
    const attribute: any = {size: 3, value: new Float32Array(7 * 3).fill(-1)};
    const indices: number[] = [];
    const update = createSegmentAttributeUpdate(({start, end, length}, object, info) => {
      indices.push(info.index);
      return [start, end, length * object.clip[1]];
    });
    update.call(fakePathLayer() as any, attribute, {startRow: 0, endRow: 2});
    expect(Array.from(attribute.value)).toEqual(
      [0, 5, 11, 5, 11, 11, 0, 0, 0, 0, 0, 0, 0, 2, 0.5, 0, 0, 0, 0, 0, 0].map(Math.fround)
    );
    expect(indices).toEqual([0, 0, 1]);
  });

  test('update only the rows asked for', () => {
    const attribute: any = {size: 1, value: new Float32Array(7).fill(-1)};
    const update = createSegmentAttributeUpdate(({end}) => [end]);
    update.call(fakePathLayer() as any, attribute, {startRow: 1, endRow: 2});
    expect(Array.from(attribute.value)).toEqual([-1, -1, -1, -1, 2, 0, 0]);
  });
});

describe('line-gradient sublayers', () => {
  function sublayers(source: Record<string, unknown>, paint: Record<string, unknown>) {
    const layers = getBasemapLayers({
      idPrefix: 'test',
      mode: 'map',
      zoom: 4,
      styleDefinition: {
        version: 8,
        sources: {routes: {type: 'geojson', data: LINE, ...source}},
        layers: [
          {
            id: 'route',
            type: 'line',
            source: 'routes',
            paint: {'line-color': '#ff00ff', 'line-gradient': RAINBOW, ...paint}
          }
        ]
      } as any
    });
    const vectorLayer: any = layers.find(layer => layer.id === 'test-routes');
    return vectorLayer.props
      .renderSubLayers({
        pickable: false,
        visible: true,
        opacity: 1,
        modelMatrix: null,
        coordinateSystem: 'default',
        coordinateOrigin: [0, 0, 0],
        extensions: [],
        highlightedObjectIndex: -1,
        highlightColor: [0, 0, 128, 128],
        wrapLongitude: false,
        id: 'test-routes-tile',
        data: [{...LINE, properties: {geojsonvt_clip_start: 0.25, geojsonvt_clip_end: 0.75}}],
        tile: {index: {x: 0, y: 0, z: 4}}
      })
      .flat()
      .filter(Boolean);
  }

  test('draw the ramp in white, at line-opacity, with each line clip', () => {
    const [layer] = sublayers({lineMetrics: true}, {'line-opacity': 0.5});
    expect(layer.props.extensions.some((e: any) => e instanceof LineGradientExtension)).toBe(true);
    expect(layer.props.getLineColor).toEqual([255, 255, 255, 128]);
    expect(layer.props.lineGradientImage.width).toBe(256);
    expect(layer.props.textureParameters).toMatchObject({mipmapFilter: 'none'});
    expect(layer.props.getLineClip(layer.props.data[0])).toEqual([0.25, 0.75]);
  });

  test('draw line-color on WebGPU, where the ramp shader does not run', () => {
    const [layer] = sublayers({lineMetrics: true}, {'line-opacity': 0.5});
    const extension = new LineGradientExtension();
    const composite = (type: string) =>
      ({context: {device: {type}}, props: layer.props, getSubLayerAccessor: (a: any) => a}) as any;
    const webgpu = extension.getSubLayerProps.call(composite('webgpu'), extension);
    expect(evaluate(webgpu.getColor, layer.props.data[0])).toEqual([255, 0, 255, 128]);
    expect(webgpu.updateTriggers).toHaveProperty('getColor');
    // On WebGL the ramp shader multiplies the white stroke color that GeoJsonLayer passes on.
    const webgl = extension.getSubLayerProps.call(composite('webgl'), extension);
    expect(webgl.getColor).toBeUndefined();
  });

  test('need a GeoJSON source with lineMetrics: otherwise line-color, with a warning', () => {
    const warn = vi.spyOn(log, 'warn').mockReturnValue(() => {});
    const [layer] = sublayers({}, {});
    expect(layer.props.extensions.some((e: any) => e instanceof LineGradientExtension)).toBe(false);
    expect(layer.props.getLineColor).toEqual([255, 0, 255, 255]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lineMetrics'));
  });
});
