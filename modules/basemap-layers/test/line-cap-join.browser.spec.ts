// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, OrthographicView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test} from 'vitest';
import {getBasemapLayers} from '../src/index';

const SIZE = 128;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;

afterEach(() => {
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
});

/** The deck.gl sublayers that one line style layer draws for one tile of features. */
function styleSublayers(styleLayer: Record<string, unknown>, features: unknown[], zoom = 15) {
  const layers = getBasemapLayers({
    idPrefix: 'test',
    mode: 'map',
    zoom,
    styleDefinition: {
      version: 8,
      sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
      layers: [{id: 'path', type: 'line', source: 'tiles', 'source-layer': 'land', ...styleLayer}]
    } as any
  });
  const vectorLayer: any = layers.find(layer => layer.id === 'test-tiles');
  // Tile sublayers receive the tile layer's base props, defaults included.
  return vectorLayer.props.renderSubLayers({
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
    id: 'test-tiles-tile',
    data: features,
    tile: {index: {x: 0, y: 0, z: zoom}}
  });
}

function feature(type: string, coordinates: unknown, properties: Record<string, unknown> = {}) {
  return {
    type: 'Feature',
    geometry: {type, coordinates},
    properties: {layerName: 'land', ...properties}
  };
}

/** Renders layers on a white canvas and returns the first frame drawn after they load. */
function render(layers: unknown[], view: unknown, viewState: Record<string, unknown>) {
  parent = document.createElement('div');
  document.body.append(parent);
  return new Promise<ImageData>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Timed out rendering')), 10_000);
    deck = new Deck({
      parent,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {adapters: [webgl2Adapter]},
      views: view as any,
      initialViewState: viewState as any,
      layers: layers as any,
      onAfterRender: () => {
        const loaded = (deck as any)?.layerManager?.getLayers() || [];
        if (!loaded.length || loaded.some((layer: any) => !layer.isLoaded)) {
          return;
        }
        // Read the frame back in the render callback, before the drawing buffer is cleared.
        const copy = document.createElement('canvas');
        copy.width = SIZE;
        copy.height = SIZE;
        const context = copy.getContext('2d')!;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, SIZE, SIZE);
        context.drawImage(deck!.getCanvas()!, 0, 0);
        window.clearTimeout(timeout);
        resolve(context.getImageData(0, 0, SIZE, SIZE));
      },
      onError: error => {
        window.clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function renderFlat(layers: unknown[]) {
  return render(layers, new OrthographicView({id: 'flat'}), {target: [0, 0, 0], zoom: 0});
}

/** Whether a pixel is drawn, i.e. darker than the white background. */
function isInked(image: ImageData, x: number, y: number): boolean {
  const i = (y * SIZE + x) * 4;
  return image.data[i] + image.data[i + 1] + image.data[i + 2] < 600;
}

function redAt(image: ImageData, x: number, y: number): number {
  return image.data[(y * SIZE + x) * 4];
}

const CENTER = SIZE / 2;

/** Renders a black line, 10 pixels wide by default, with the given layout and paint. */
function renderLine(
  coordinates: number[][],
  layout: Record<string, unknown>,
  width = 10,
  paint: Record<string, unknown> = {}
) {
  return renderFlat(
    styleSublayers({layout, paint: {'line-color': '#000000', 'line-width': width, ...paint}}, [
      feature('LineString', coordinates)
    ])
  );
}

describe('line-cap in the browser', () => {
  /** The first inked column along the middle row: where the line's start cap ends. */
  function capStart(image: ImageData): number {
    for (let x = 0; x < SIZE; x++) {
      if (isInked(image, x, CENTER)) {
        return x;
      }
    }
    return -1;
  }

  const LINE = [
    [-40, 0],
    [40, 0]
  ];

  test('butt caps end at the endpoint', async () => {
    expect(capStart(await renderLine(LINE, {'line-cap': 'butt'}))).toBe(CENTER - 40);
  });

  test.each(['round', 'square'])('%s caps reach half the line width beyond the endpoint', async cap => {
    const start = capStart(await renderLine(LINE, {'line-cap': cap}));
    expect(start).toBeGreaterThanOrEqual(CENTER - 46);
    expect(start).toBeLessThanOrEqual(CENTER - 44);
  });

  test('the default cap is butt', async () => {
    expect(capStart(await renderLine(LINE, {}))).toBe(CENTER - 40);
  });

  test('square caps on a gap extend by half the gap plus the line width', async () => {
    const image = await renderLine(LINE, {'line-cap': 'square'}, 2, {
      'line-gap-width': 10,
      'line-offset': 3,
      'line-dasharray': [50, 5]
    });
    const end = CENTER + 40;
    for (const x of [CENTER - 46, end + 5]) {
      // Offsetting by 3px puts the two strokes 3px and 9px from the original center,
      // on opposite sides. Both should have ink 6px past the endpoint.
      const inkedRows = Array.from({length: SIZE}, (_, y) => y).filter(y => isInked(image, x, y));
      expect(inkedRows).toHaveLength(4);
    }
    for (const x of [CENTER - 48, end + 7]) {
      expect(Array.from({length: SIZE}, (_, y) => y).some(y => isInked(image, x, y))).toBe(false);
    }
  });

  test('square caps do not overlap at a repeated interior vertex', async () => {
    const image = await renderLine(
      [LINE[0], [0, 0], [0, 0], LINE[1]],
      {'line-cap': 'square'},
      10,
      {'line-opacity': 0.5}
    );
    const body = redAt(image, CENTER - 10, CENTER);
    expect(body).toBeGreaterThan(60);
    expect(body).toBeLessThan(200);
    for (const x of [CENTER - 2, CENTER, CENTER + 2]) {
      expect(redAt(image, x, CENTER)).toBe(body);
    }
  });
});

describe('line-join in the browser', () => {
  // A corner of about 53 degrees at the center: a full miter reaches 2.24 half widths, or about
  // 11 pixels, above the vertex.
  const CORNER = [
    [-20, 40],
    [0, 0],
    [20, 40]
  ];

  /** How far above the vertex the joint reaches along the middle column, in pixels. */
  function jointReach(image: ImageData, x = CENTER): number {
    for (let y = 0; y < SIZE; y++) {
      if (isInked(image, x, y)) {
        return CENTER - y;
      }
    }
    return -1;
  }

  test('a miter within line-miter-limit is drawn in full', async () => {
    const reach = jointReach(
      await renderLine(CORNER, {'line-join': 'miter', 'line-miter-limit': 3})
    );
    expect(reach).toBeGreaterThanOrEqual(10);
    expect(reach).toBeLessThanOrEqual(12);
  });

  // A right angle at the center: a miter of 1.41 half widths, within the default limit of 2.
  const RIGHT_ANGLE = [
    [-40, 40],
    [0, 0],
    [40, 40]
  ];

  test('a bevel cuts along the chord between the outer corners', async () => {
    // MapLibre bevels a miter longer than 1.05 half widths. The chord is 5 * sin(45) = 3.54 px
    // above the vertex.
    const reach = jointReach(await renderLine(RIGHT_ANGLE, {'line-join': 'bevel'}));
    expect(reach).toBeGreaterThanOrEqual(3);
    expect(reach).toBeLessThanOrEqual(4);
  });

  test('a miter beyond line-miter-limit is bevelled', async () => {
    const reach = jointReach(
      await renderLine(RIGHT_ANGLE, {'line-join': 'miter', 'line-miter-limit': 1.2})
    );
    expect(reach).toBeGreaterThanOrEqual(3);
    expect(reach).toBeLessThanOrEqual(4);
  });

  test.each(['bevel', 'miter'])(
    'a %s join longer than two half widths is cut through the vertex',
    async join => {
      // The miter at CORNER is 2.24 half widths. MapLibre's "flip bevel" cuts it level with the
      // vertex, inside the chord at 2.24 px.
      const reach = jointReach(await renderLine(CORNER, {'line-join': join}));
      expect(reach).toBeGreaterThanOrEqual(-1);
      expect(reach).toBeLessThanOrEqual(1);
    }
  );

  test('a round join reaches half the line width', async () => {
    const reach = jointReach(await renderLine(CORNER, {'line-join': 'round'}));
    expect(reach).toBeGreaterThanOrEqual(4);
    expect(reach).toBeLessThanOrEqual(5);
  });

  test('a bevel is cut flat where a round join curves away', async () => {
    // A 30 pixel line: the chord is 15 * sin(45) = 10.6 px above the vertex at both columns,
    // while 8 px to the side a round join has curved down to sqrt(15^2 - 8^2) = 12.7 px.
    const image = await renderLine(RIGHT_ANGLE, {'line-join': 'bevel'}, 30);
    for (const x of [CENTER, CENTER + 8]) {
      expect(jointReach(image, x)).toBeGreaterThanOrEqual(10);
      expect(jointReach(image, x)).toBeLessThanOrEqual(11);
    }
  });
});

test('line-dasharray draws both dash lengths and both gaps in one period', async () => {
  const image = await renderLine([[-56, 0], [56, 0]], {}, 4, {'line-dasharray': [4, 1, 1, 1]});
  const row = Array.from({length: 56}, (_, x) => (isInked(image, CENTER - 56 + x, CENTER) ? '#' : '.'));
  expect(row.join('')).toBe('################....####....'.repeat(2));
});

test('a round dash shoulder intersects the stroke fade', async () => {
  const image = await renderLine(
    [[-40.5, 0.5], [40, 0.5]],
    {'line-cap': 'round'},
    8,
    {'line-dasharray': [2, 2]}
  );
  // The stroke edge crosses a pixel center on each side of the line. At 2px past the
  // first dash, the round cap's own coverage is also about half at that edge.
  const [edge] = [CENTER - 5, CENTER - 4, CENTER + 4, CENTER + 5].filter(y => {
    const red = redAt(image, CENTER - 32, y);
    return red > 110 && red < 145;
  });
  expect(edge).toBeDefined();
  const stroke = redAt(image, CENTER - 32, edge);
  expect(redAt(image, CENTER - 23, edge)).toBeLessThanOrEqual(stroke + 18);
});
