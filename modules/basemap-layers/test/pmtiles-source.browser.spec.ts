// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * A style whose sources are `pmtiles://` archives draws the same pixels as the same tiles served as
 * `{z}/{x}/{y}` URLs. The archives and their tiles are the fixtures of
 * `fixtures/pmtiles/generate.mjs`: zooms 0 and 1. The view is drawn at zoom 1.2, where the four
 * zoom 1 tiles meet, and its tiles are the zoom 1 tiles of the archive's `maxzoom`, which the
 * source takes from the archive header.
 */

import {Deck, MapView} from '@deck.gl/core';
import {webgl2Adapter} from '@luma.gl/core/webgl';
import mvtWorkerUrl from '@loaders.gl/tiles/mvt/mvt-worker.js?url';
import {afterEach, describe, expect, test} from 'vitest';
import {BasemapLayer} from '../src/index';

const SIZE = 192;
const FIXTURES = '/modules/basemap-layers/test/fixtures/pmtiles';
const HOST = 'https://tiles.test';

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;

/** Ends `holdLayerUpdates`. */
let releaseLayerUpdates: (() => void) | null = null;

/**
 * Makes the deck's layer manager skip its layer updates for `milliseconds`, while the deck still
 * draws its frames: the layers keep the state of their last update.
 */
function holdLayerUpdates(milliseconds: number): void {
  const prototype = Object.getPrototypeOf((deck as any).layerManager);
  const updateLayers = prototype.updateLayers;
  prototype.updateLayers = () => {};
  const timer = window.setTimeout(() => releaseLayerUpdates?.(), milliseconds);
  releaseLayerUpdates = () => {
    window.clearTimeout(timer);
    prototype.updateLayers = updateLayers;
    releaseLayerUpdates = null;
  };
}

afterEach(() => {
  releaseLayerUpdates?.();
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
});

async function readFixture(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(`${FIXTURES}/${path}`);
  expect(response.ok, path).toBe(true);
  return new Uint8Array(await response.arrayBuffer());
}

/** A `fetch` that counts the requests it has not answered yet. */
type TrackedFetch = {fetchTile: typeof fetch; requests: string[]; pending: () => number};

function track(fetchFn: typeof fetch): TrackedFetch {
  const requests: string[] = [];
  let pending = 0;
  const fetchTile = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(input));
    pending++;
    try {
      return await fetchFn(input, init);
    } finally {
      pending--;
    }
  }) as typeof fetch;
  return {fetchTile, requests, pending: () => pending};
}

/**
 * A tile server on `https://tiles.test` for the `fetch` of `loadOptions`: it serves the archives
 * with range requests at `/<name>.pmtiles`, and their tiles as files at
 * `/<name>/{z}/{x}/{y}.<ext>`.
 */
function createServer(): TrackedFetch {
  return track((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(`${HOST}/`)) {
      return new Response(null, {status: 404});
    }
    const path = url.slice(HOST.length + 1);
    const bytes = await readFixture(path.endsWith('.pmtiles') ? path : `tiles/${path}`);
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('Range') || '');
    if (!match) {
      const type = path.endsWith('.png') ? 'image/png' : 'application/vnd.mapbox-vector-tile';
      return new Response(bytes, {headers: {'Content-Type': type}});
    }
    const first = Number(match[1]);
    const last = Math.min(Number(match[2]), bytes.length - 1);
    return new Response(bytes.slice(first, last + 1), {status: 206});
  }) as typeof fetch);
}

type SourceKind = {
  type: 'vector' | 'raster' | 'raster-dem';
  name: string;
  extension: string;
  layer: Record<string, unknown>;
  source?: Record<string, unknown>;
};

const KINDS: SourceKind[] = [
  {
    type: 'vector',
    name: 'vector',
    extension: 'mvt',
    layer: {
      type: 'fill',
      'source-layer': 'shapes',
      paint: {'fill-color': ['match', ['get', 'z'], 0, '#cc3311', '#0066cc']}
    }
  },
  {type: 'raster', name: 'raster', extension: 'png', layer: {type: 'raster'}},
  {
    type: 'raster-dem',
    name: 'dem',
    extension: 'png',
    source: {encoding: 'terrarium'},
    layer: {type: 'hillshade', paint: {'hillshade-exaggeration': 1}}
  }
];

/** A style of one source of `kind`, given as a PMTiles archive or as `{z}/{x}/{y}` tiles. */
function getStyle(kind: SourceKind, archive: boolean) {
  const source = archive
    ? {type: kind.type, url: `pmtiles://${HOST}/${kind.name}.pmtiles`}
    : {
        type: kind.type,
        tiles: [`${HOST}/${kind.name}/{z}/{x}/{y}.${kind.extension}`],
        minzoom: 0,
        maxzoom: 1
      };
  return {
    version: 8,
    sources: {data: {...source, ...kind.source}},
    layers: [
      {id: 'background', type: 'background', paint: {'background-color': '#ffffff'}},
      {id: 'data', source: 'data', ...kind.layer}
    ]
  };
}

/** The current frame of the deck's canvas. */
function readFrame(): ImageData {
  const copy = document.createElement('canvas');
  copy.width = SIZE;
  copy.height = SIZE;
  const context = copy.getContext('2d')!;
  context.drawImage(deck!.getCanvas()!, 0, 0);
  return context.getImageData(0, 0, SIZE, SIZE);
}

/** Frames, and milliseconds, that must draw the same pixels before a frame is taken. */
const STABLE_FRAMES = 10;
const STABLE_MILLISECONDS = 1000;

/**
 * Renders a style and returns the frame drawn once every layer has loaded its tiles: no request
 * is pending, no layer update is pending, every layer is loaded, the frame draws more than the
 * background, and the pixels have not changed for `STABLE_FRAMES` frames and
 * `STABLE_MILLISECONDS`. A hillshade tile decodes after its request has been answered, so a frame
 * can show the background alone for a while.
 *
 * The deck draws every frame itself (`_animate`), after it has updated its layers. A frame drawn
 * with `deck.redraw()` does not update the layers: a tile that has loaded, but whose sublayers are
 * not rendered yet, counts as loaded (as in deck.gl's `TileLayer`), and such frames show the map
 * without it.
 */
function render(style: object, loadOptions: object, server: TrackedFetch): Promise<ImageData> {
  parent = document.createElement('div');
  document.body.append(parent);
  return new Promise<ImageData>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error('Timed out rendering')), 90_000);
    let frames = 0;
    let stableFrames = 0;
    let stableSince = 0;
    let previous: ImageData | null = null;
    deck = new Deck({
      parent,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      deviceProps: {adapters: [webgl2Adapter]},
      _animate: true,
      views: new MapView({id: 'map', repeat: false}),
      initialViewState: {longitude: -10, latitude: 15, zoom: 1.2},
      layers: [
        new BasemapLayer({
          id: 'basemap',
          style,
          loadOptions: {...loadOptions, fetch: server.fetchTile}
        } as any)
      ],
      onAfterRender: () => {
        const layerManager = (deck as any)?.layerManager;
        const all = layerManager?.getLayers() || [];
        const loaded =
          ++frames >= 20 &&
          server.requests.length > 0 &&
          server.pending() === 0 &&
          !layerManager?.needsUpdate() &&
          all.length > 2 &&
          all.every((layer: any) => layer.isLoaded);
        const frame = loaded ? readFrame() : null;
        const stable = frame && previous && countDifferentPixels(frame, previous) === 0;
        stableFrames = stable ? stableFrames + 1 : 0;
        stableSince = stable ? stableSince : performance.now();
        previous = frame;
        if (
          frame &&
          countColors(frame) > 1 &&
          stableFrames >= STABLE_FRAMES &&
          performance.now() - stableSince >= STABLE_MILLISECONDS
        ) {
          window.clearTimeout(timeout);
          resolve(frame);
        }
      },
      onError: error => {
        window.clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

/** Renders a style and finalizes the deck. */
async function renderOnce(
  style: object,
  server: TrackedFetch,
  loadOptions: object = {}
): Promise<ImageData> {
  const image = await render(style, loadOptions, server);
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
  return image;
}

/** The number of pixels whose colors differ. */
function countDifferentPixels(a: ImageData, b: ImageData): number {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    ) {
      count++;
    }
  }
  return count;
}

/** The number of distinct colors, to tell a drawn map from an empty one. */
function countColors(image: ImageData): number {
  const colors = new Set<number>();
  for (let i = 0; i < image.data.length; i += 4) {
    colors.add((image.data[i] << 16) | (image.data[i + 1] << 8) | image.data[i + 2]);
  }
  return colors.size;
}

/** Milliseconds a test may take: two renders, on a busy machine. */
const TEST_TIMEOUT = 200_000;

describe('pmtiles:// sources', () => {
  for (const kind of KINDS) {
    test(
      `a ${kind.type} archive draws as its {z}/{x}/{y} tiles`,
      async () => {
        const options = {mvt: {workerUrl: mvtWorkerUrl}};
        const tiles = createServer();
        const expected = await renderOnce(getStyle(kind, false), tiles, options);
        const archive = createServer();
        const actual = await renderOnce(getStyle(kind, true), archive, options);

        // The view draws parts of the four zoom 1 tiles, past the archive's maxzoom.
        expect(countColors(expected)).toBeGreaterThan(kind.type === 'raster' ? 3 : 1);
        for (const tile of ['0/0', '1/0', '0/1', '1/1']) {
          expect(tiles.requests).toContain(`${HOST}/${kind.name}/1/${tile}.${kind.extension}`);
        }
        expect(tiles.requests.some(url => url.includes(`/${kind.name}/2/`))).toBe(false);
        expect(countDifferentPixels(actual, expected)).toBe(0);
        // Every tile of the view is read from the archive, which takes no other request.
        expect(new Set(archive.requests)).toEqual(new Set([`${HOST}/${kind.name}.pmtiles`]));
      },
      TEST_TIMEOUT
    );
  }

  test(
    'a frame is taken only after the layers have been updated with the last tile',
    async () => {
      // The raster-dem test failed on CI with 4916, 13174 and 22451 different pixels: the counts
      // of a frame drawn after the last one, two or three tiles loaded, but before the hillshade
      // layer was updated with them. Here the layer updates wait 3 seconds after the last tile is
      // answered, 1.5 seconds after the other tiles, as on a busy machine, and the frame must
      // still show the tile.
      const kind = KINDS[2];
      const options = {mvt: {workerUrl: mvtWorkerUrl}};
      const expected = await renderOnce(getStyle(kind, false), createServer(), options);
      const server = createServer();
      const fetchTile = server.fetchTile;
      const lastTile = `${HOST}/${kind.name}/1/1/1.${kind.extension}`;
      let held = false;
      server.fetchTile = (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetchTile(input, init);
        if (String(input) === lastTile) {
          // The other tiles are drawn first.
          await new Promise(resolve => setTimeout(resolve, 1500));
          held = true;
          holdLayerUpdates(3000);
        }
        return response;
      }) as typeof fetch;
      const actual = await renderOnce(getStyle(kind, false), server, options);
      expect(held).toBe(true);
      expect(countDifferentPixels(actual, expected)).toBe(0);
    },
    TEST_TIMEOUT
  );

  test(
    'an archive on the page origin loads with HTTP range requests to the test server',
    async () => {
      const kind = KINDS[1];
      const expected = await renderOnce(getStyle(kind, false), createServer());
      const style = getStyle(kind, true);
      (style.sources as any).data = {type: 'raster', url: `pmtiles://${FIXTURES}/raster.pmtiles`};
      const browser = track(globalThis.fetch.bind(globalThis));
      const actual = await renderOnce(style, browser, {baseUrl: location.href});
      expect(new Set(browser.requests)).toEqual(
        new Set([`${location.origin}${FIXTURES}/raster.pmtiles`])
      );
      expect(countDifferentPixels(actual, expected)).toBe(0);
    },
    TEST_TIMEOUT
  );
});
