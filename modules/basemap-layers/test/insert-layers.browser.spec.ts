// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, WebMercatorViewport} from '@deck.gl/core';
import {SolidPolygonLayer} from '@deck.gl/layers';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer, type BasemapLayerProps} from '../src/basemap-layer';

// `insertLayers` draws deck.gl layers between two style layers, and picks them as top-level layers.

const SIZE = 256;

/** Generous: deck start-up and shader compiles run on software WebGL in CI. */
const TIMEOUT_MS = 50_000;

/** The center of tile 1-1-1, at the center of the view: the view draws only that tile. */
const VIEW_STATE = {
  longitude: 90,
  latitude: (360 / Math.PI) * Math.atan(Math.exp(-0.5 * Math.PI)) - 90,
  zoom: 1.2
};

const MIDDLE = SIZE / 2;
/** On the road, in the middle of the inserted square. */
const ON_ROAD = [MIDDLE, MIDDLE] as const;
/** In the inserted square, away from the road. */
const OFF_ROAD = [MIDDLE, MIDDLE + 40] as const;
/** Outside the inserted square: only the water. */
const OUTSIDE = [8, 8] as const;

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;
let polling = false;

afterEach(() => {
  polling = false;
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
});

/** Each tile is water, with a road across its middle, in tile-local coordinates. */
const fetchTile = async () => [
  {
    type: 'Feature',
    properties: {layerName: 'water'},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0]
        ]
      ]
    }
  },
  {
    type: 'Feature',
    properties: {layerName: 'road'},
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0.5],
        [1, 0.5]
      ]
    }
  }
];

const STYLE = {
  version: 8,
  sources: {tiles: {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']}},
  layers: [
    {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
    {
      id: 'water',
      type: 'fill',
      source: 'tiles',
      'source-layer': 'water',
      paint: {'fill-color': '#0000ff'}
    },
    {
      id: 'roads',
      type: 'line',
      source: 'tiles',
      'source-layer': 'road',
      paint: {'line-color': '#ff0000', 'line-width': 30}
    }
  ]
} as any;

/** A green square around the view center, 128 pixels wide. */
function square(props: Record<string, unknown> = {}) {
  const viewport = new WebMercatorViewport({...VIEW_STATE, width: SIZE, height: SIZE});
  const corners = [
    [MIDDLE - 64, MIDDLE - 64],
    [MIDDLE + 64, MIDDLE - 64],
    [MIDDLE + 64, MIDDLE + 64],
    [MIDDLE - 64, MIDDLE + 64]
  ].map(point => viewport.unproject(point));
  return new SolidPolygonLayer({
    id: 'data',
    data: [{polygon: corners}],
    getPolygon: (d: any) => d.polygon,
    getFillColor: [0, 255, 0],
    ...props
  });
}

/** A basemap whose own tile layers are pickable, as an application can make them on master. */
class PickableBasemapLayer extends BasemapLayer {
  static layerName = 'PickableBasemapLayer';
  renderLayers(): any {
    return (super.renderLayers() as any[]).flat(Infinity).filter(Boolean).map(layer =>
      layer.id.startsWith(`${this.props.id}-`) ? layer.clone({pickable: true}) : layer
    );
  }
}

function basemap(props: Partial<BasemapLayerProps> & Record<string, unknown>) {
  return new PickableBasemapLayer({
    id: 'basemap',
    mode: 'map',
    fetch: fetchTile,
    style: STYLE,
    ...props
  } as any);
}

function createDeck(layer: unknown, onError?: (error: Error) => void): void {
  parent = document.createElement('div');
  document.body.append(parent);
  deck = new Deck({
    parent,
    width: SIZE,
    height: SIZE,
    useDevicePixels: false,
    deviceProps: {adapters: [webgl2Adapter]},
    views: new MapView({id: 'map'}),
    viewState: VIEW_STATE as any,
    layers: [layer as any],
    onError:
      onError ||
      (error => {
        throw error;
      })
  });
}

/**
 * Resolves with the frame drawn once the basemap's tile layer has loaded, read back in the same
 * animation frame as the draw, and the deck that drew it, which can then pick.
 */
function drawn(): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    polling = true;
    const poll = () => {
      if (!polling) {
        return;
      }
      const layers: any[] = (deck as any)?.layerManager?.getLayers() || [];
      const tiles = layers.find(layer => layer.id === 'basemap-tiles');
      if (tiles?.isLoaded && layers.every(layer => layer.isLoaded)) {
        deck!.redraw('poll');
        const copy = document.createElement('canvas');
        copy.width = SIZE;
        copy.height = SIZE;
        const context = copy.getContext('2d')!;
        context.drawImage(deck!.getCanvas()!, 0, 0);
        const image = context.getImageData(0, 0, SIZE, SIZE);
        // The tiles draw one frame after they load.
        if (color(image, OUTSIDE) === 'blue') {
          polling = false;
          resolve(image);
          return;
        }
      }
      if (performance.now() - start > TIMEOUT_MS) {
        polling = false;
        reject(new Error('Timed out waiting for the basemap to draw'));
      } else {
        window.requestAnimationFrame(poll);
      }
    };
    window.requestAnimationFrame(poll);
  });
}

/** The dominant channel of a pixel. */
function color(image: ImageData, [x, y]: readonly [number, number]): string {
  const i = (y * SIZE + x) * 4;
  const [r, g, b] = [image.data[i], image.data[i + 1], image.data[i + 2]];
  if (r > 150 && g < 100 && b < 100) return 'red';
  if (g > 150 && r < 100 && b < 100) return 'green';
  if (b > 150 && r < 100 && g < 100) return 'blue';
  return `rgb(${r}, ${g}, ${b})`;
}

function colors(image: ImageData) {
  return {
    onRoad: color(image, ON_ROAD),
    offRoad: color(image, OFF_ROAD),
    outside: color(image, OUTSIDE)
  };
}

describe('insertLayers draw order', () => {
  // deck.gl's default parameters test and write depth; `depthTest: false` does neither. The roads
  // draw over the square either way.
  for (const [name, parameters] of [
    ['a depth-tested layer', undefined],
    ['a layer without depth test', {depthTest: false}],
    ['a layer that writes depth', {depthTest: true, depthWriteEnabled: true, depthCompare: 'less-equal'}]
  ] as const) {
    test(`${name} before "roads" draws over the water and under the roads`, async () => {
      createDeck(
        basemap({insertLayers: [{beforeId: 'roads', layers: [square(parameters ? {parameters} : {})]}]})
      );
      expect(colors(await drawn())).toEqual({onRoad: 'red', offRoad: 'green', outside: 'blue'});
    }, 60_000);
  }

  test('a layer without beforeId draws over the whole basemap', async () => {
    createDeck(basemap({insertLayers: [{layers: [square()]}]}));
    expect(colors(await drawn())).toEqual({onRoad: 'green', offRoad: 'green', outside: 'blue'});
  }, 60_000);

  test('a layer before "water" draws under the whole style but the background', async () => {
    createDeck(basemap({insertLayers: [{beforeId: 'water', layers: [square()]}]}));
    expect(colors(await drawn())).toEqual({onRoad: 'red', offRoad: 'blue', outside: 'blue'});
  }, 60_000);
});

describe('insertLayers picking', () => {
  test('picks the inserted layer as a top-level layer, and the basemap around it', async () => {
    const onClick = vi.fn();
    const data = square({pickable: true, onClick});
    createDeck(basemap({insertLayers: [{beforeId: 'roads', layers: [data]}]}));
    await drawn();

    const inserted = deck!.pickObject({x: OFF_ROAD[0], y: OFF_ROAD[1]})!;
    expect(inserted.layer?.id).toBe('data');
    expect(inserted.object).toBe((data.props.data as any[])[0]);
    // deck calls `onClick` of `info.layer`: the inserted layer's own handler.
    inserted.layer!.onClick(inserted, {} as any);
    expect(onClick).toHaveBeenCalledTimes(1);

    const road = deck!.pickObject({x: ON_ROAD[0], y: ON_ROAD[1]})!;
    expect(road.layer?.id).toBe('basemap');
    expect(road.object?.properties?.layerName).toBe('road');

    const water = deck!.pickObject({x: OUTSIDE[0], y: OUTSIDE[1]})!;
    expect(water.layer?.id).toBe('basemap');
    expect(water.object?.properties?.layerName).toBe('water');
  }, 60_000);
});

describe('insertLayers errors', () => {
  test('an unknown beforeId raises one error to onError, and its layers are not drawn', async () => {
    const onError = vi.fn(() => true);
    const props = (beforeId: string) => ({
      onError,
      insertLayers: [
        {beforeId, layers: [square()]},
        {beforeId: 'roads', layers: [square({id: 'kept', getFillColor: [0, 0, 0, 0]})]}
      ]
    });
    createDeck(basemap(props('nope')));
    const image = await drawn();
    expect(color(image, OFF_ROAD)).toBe('blue');
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0] as unknown[])[0]).toMatchObject({
      message: 'Cannot insert layers before non-existing style layer "nope"'
    });
    const ids = (deck as any).layerManager.getLayers().map((layer: any) => layer.id);
    expect(ids).toContain('kept');
    expect(ids).not.toContain('data');

    // A new `insertLayers` with the same unknown id does not raise the error again.
    deck!.setProps({layers: [basemap(props('nope'))]});
    await drawn();
    expect(onError).toHaveBeenCalledTimes(1);
    // Another unknown id does.
    deck!.setProps({layers: [basemap(props('other'))]});
    await drawn();
    expect(onError).toHaveBeenCalledTimes(2);
  }, 60_000);
});
