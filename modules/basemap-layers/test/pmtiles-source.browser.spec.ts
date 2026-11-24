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
import {afterEach, describe, expect, test, vi} from 'vitest';
import {BasemapLayer} from '../src/index';

const SIZE = 192;
const FIXTURES = '/modules/basemap-layers/test/fixtures/pmtiles';
const HOST = 'https://tiles.test';

let deck: Deck<any> | null = null;
let parent: HTMLDivElement | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  deck?.finalize();
  deck = null;
  parent?.remove();
  parent = null;
});

/** The bytes of each fixture, read from the page server once (see `readFixture`). */
const fixtures = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

/** Reads of a fixture that can come back empty before the test fails. */
const FIXTURE_READS = 3;

/**
 * The bytes of a fixture. Each fixture is read from the page server once and kept, so the two
 * renders of a test read the same bytes. Every fixture has bytes, but a busy page server can send
 * an empty body: a DEM tile without bytes is a tile without data, and a render draws it as such.
 * An empty read is made again, and a fixture that stays empty fails the test.
 */
function readFixture(path: string): Promise<Uint8Array<ArrayBuffer>> {
  let bytes = fixtures.get(path);
  if (!bytes) {
    bytes = fetchFixture(path);
    fixtures.set(path, bytes);
    bytes.catch(() => fixtures.delete(path));
  }
  return bytes;
}

async function fetchFixture(path: string): Promise<Uint8Array<ArrayBuffer>> {
  for (let read = 1; ; read++) {
    const response = await fetch(`${FIXTURES}/${path}`, {cache: 'no-store'});
    if (!response.ok) {
      throw new Error(`Fixture ${path}: status ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 0) {
      return bytes;
    }
    if (read >= FIXTURE_READS) {
      throw new Error(`Fixture ${path}: empty after ${read} reads`);
    }
  }
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
 * is pending, every layer is loaded, the frame draws more than the background, and the pixels
 * have not changed for `STABLE_FRAMES` frames and `STABLE_MILLISECONDS`. A hillshade tile decodes
 * after its request has been answered, so a frame can show the background alone for a while.
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
        const all = (deck as any)?.layerManager?.getLayers() || [];
        const loaded =
          ++frames >= 20 &&
          server.requests.length > 0 &&
          server.pending() === 0 &&
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
          return;
        }
        requestAnimationFrame(() => deck?.redraw('waiting'));
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
    'a fixture that the test server reads once with an empty body draws as the archive',
    async () => {
      // The raster-dem test failed on CI with 4916, 13174 and 22451 different pixels: the counts
      // when the last one, two or three tiles of the {z}/{x}/{y} render have no data. A DEM tile
      // read with an empty body is such a tile, and the render takes its frame without it.
      const kind = KINDS[2];
      const emptyTile = `${FIXTURES}/tiles/dem/1/1/1.png`;
      fixtures.clear();
      const pageFetch = globalThis.fetch.bind(globalThis);
      let emptyReads = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
        if (String(input) === emptyTile && emptyReads++ === 0) {
          return Promise.resolve(new Response(new Uint8Array(0)));
        }
        return pageFetch(input, init);
      });
      const options = {mvt: {workerUrl: mvtWorkerUrl}};
      const expected = await renderOnce(getStyle(kind, false), createServer(), options);
      const actual = await renderOnce(getStyle(kind, true), createServer(), options);
      expect(emptyReads).toBeGreaterThan(0);
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
