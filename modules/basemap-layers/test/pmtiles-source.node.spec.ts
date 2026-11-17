// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {log} from '@deck.gl/core';
import {encodePMTiles} from '@loaders.gl/tiles/pmtiles';
import {resolveBasemapStyle, type BasemapSource} from '../src/style-resolver';
import {
  MAX_OPEN_ARCHIVES,
  getTileLoadOptions,
  parsePMTilesTileUrl
} from '../src/pmtiles-source';

/** The fixtures of `fixtures/pmtiles/generate.mjs`. */
const FIXTURES = new URL('./fixtures/pmtiles/', import.meta.url);

function readFixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(path, FIXTURES)));
}

type Request = {url: string; range: string | null; headers: Headers};

/**
 * A server that answers HTTP range requests for archives, by URL. With `ranges: false` it ignores
 * the `Range` header and returns the whole archive, as a server without byte serving does.
 */
function createServer(archives: Record<string, Uint8Array>, {ranges = true} = {}) {
  const requests: Request[] = [];
  const fetch = vi.fn(async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const range = headers.get('Range');
    requests.push({url, range, headers});
    const archive = archives[url];
    if (!archive) {
      return new Response(null, {status: 404});
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || '');
    if (!ranges || !match) {
      return new Response(archive.slice());
    }
    const first = Number(match[1]);
    const last = Math.min(Number(match[2]), archive.length - 1);
    return new Response(archive.slice(first, last + 1), {
      status: 206,
      headers: {'Content-Range': `bytes ${first}-${last}/${archive.length}`}
    });
  }) as unknown as typeof globalThis.fetch;
  return {fetch, requests};
}

const ARCHIVE_URL = 'https://data.example.com/maps/vector.pmtiles';

async function resolveSource(
  source: BasemapSource,
  archives: Record<string, Uint8Array>,
  options: Record<string, unknown> = {}
) {
  const server = createServer(archives);
  const style = await resolveBasemapStyle(
    {version: 8, sources: {source}, layers: []},
    {fetch: server.fetch, ...options}
  );
  return {source: style.sources.source, ...server};
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pmtiles:// sources', () => {
  test('a vector source takes its zoom range and bounds from the archive header', async () => {
    const {source, requests} = await resolveSource(
      {type: 'vector', url: `pmtiles://${ARCHIVE_URL}`},
      {[ARCHIVE_URL]: readFixture('vector.pmtiles')}
    );
    expect(source).toEqual({
      type: 'vector',
      url: `pmtiles://${ARCHIVE_URL}`,
      tiles: [`pmtiles://${ARCHIVE_URL}/{z}/{x}/{y}`],
      minzoom: 0,
      maxzoom: 1,
      bounds: [-170, -80, 170, 80]
    });
    // The header and root directory are one range request; no TileJSON is fetched.
    expect(requests.map(({url, range}) => [url, range])).toEqual([
      [ARCHIVE_URL, 'bytes=0-16383']
    ]);
  });

  test('raster and raster-dem sources read PNG archives', async () => {
    const archives = {
      'https://data.example.com/raster.pmtiles': readFixture('raster.pmtiles'),
      'https://data.example.com/dem.pmtiles': readFixture('dem.pmtiles')
    };
    const server = createServer(archives);
    const style = await resolveBasemapStyle(
      {
        version: 8,
        sources: {
          imagery: {type: 'raster', url: 'pmtiles://https://data.example.com/raster.pmtiles'},
          terrain: {
            type: 'raster-dem',
            url: 'pmtiles://https://data.example.com/dem.pmtiles',
            encoding: 'terrarium'
          }
        },
        layers: []
      },
      {fetch: server.fetch}
    );
    expect(style.sources.imagery.tiles).toEqual([
      'pmtiles://https://data.example.com/raster.pmtiles/{z}/{x}/{y}'
    ]);
    expect(style.sources.terrain).toMatchObject({
      tiles: ['pmtiles://https://data.example.com/dem.pmtiles/{z}/{x}/{y}'],
      encoding: 'terrarium',
      minzoom: 0,
      maxzoom: 1
    });
  });

  test("the style's own source properties take precedence over the header", async () => {
    const {source} = await resolveSource(
      {type: 'vector', url: `pmtiles://${ARCHIVE_URL}`, maxzoom: 0, bounds: [0, 0, 1, 1]},
      {[ARCHIVE_URL]: readFixture('vector.pmtiles')}
    );
    expect(source).toMatchObject({minzoom: 0, maxzoom: 0, bounds: [0, 0, 1, 1]});
  });

  test('a relative archive URL resolves against the style URL', async () => {
    const {source, requests} = await resolveSource(
      {type: 'vector', url: 'pmtiles://../tiles/vector.pmtiles'},
      {'https://app.example.com/tiles/vector.pmtiles': readFixture('vector.pmtiles')},
      {baseUrl: 'https://app.example.com/styles/style.json'}
    );
    expect(source.url).toBe('pmtiles://https://app.example.com/tiles/vector.pmtiles');
    expect(source.tiles).toEqual([
      'pmtiles://https://app.example.com/tiles/vector.pmtiles/{z}/{x}/{y}'
    ]);
    expect(requests[0].url).toBe('https://app.example.com/tiles/vector.pmtiles');
  });

  test('an archive of the wrong tile type is skipped with a warning', async () => {
    const warn = vi.spyOn(log, 'warn');
    const {source} = await resolveSource(
      {type: 'vector', url: `pmtiles://${ARCHIVE_URL}`},
      {[ARCHIVE_URL]: readFixture('raster.pmtiles')}
    );
    expect(source.tiles).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('holds PNG tiles, which a vector source cannot draw')
    );
  });

  test('an archive with brotli-compressed tiles is skipped with a warning', async () => {
    const warn = vi.spyOn(log, 'warn');
    const archive = await encodePMTiles([{z: 0, x: 0, y: 0, data: new Uint8Array([1, 2, 3])}], {
      tileType: 'mvt',
      tileCompression: 'brotli',
      metadata: {vector_layers: [{id: 'shapes', fields: {}}]}
    });
    const {source} = await resolveSource(
      {type: 'vector', url: `pmtiles://${ARCHIVE_URL}`},
      {[ARCHIVE_URL]: new Uint8Array(archive)}
    );
    expect(source.tiles).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('compression Brotli is not supported')
    );
  });

  test('a server without range requests is reported', async () => {
    const warn = vi.spyOn(log, 'warn');
    const server = createServer({[ARCHIVE_URL]: readFixture('vector.pmtiles')}, {ranges: false});
    const style = {
      version: 8,
      sources: {source: {type: 'vector', url: `pmtiles://${ARCHIVE_URL}`}},
      layers: []
    };
    // The archive is shorter than the first read, so a whole-file answer passes for a range one.
    const resolved = await resolveBasemapStyle(style, {fetch: server.fetch});
    expect(resolved.sources.source.maxzoom).toBe(1);
    const longArchive = new Uint8Array(20000);
    longArchive.set(readFixture('vector.pmtiles'));
    const long = createServer({[ARCHIVE_URL]: longArchive}, {ranges: false});
    const failed = await resolveBasemapStyle(style, {fetch: long.fetch});
    expect(failed.sources.source.tiles).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be loaded'));
  });
});

describe('pmtiles:// archive reads', () => {
  const style = {
    version: 8,
    sources: {source: {type: 'vector', url: `pmtiles://${ARCHIVE_URL}`}},
    layers: []
  };

  /** A response of `chunks` chunks of 1 MiB that counts the chunks read and the cancels. */
  function createLongResponse(chunks: number, headers: Record<string, string> = {}) {
    const stats = {chunksRead: 0, cancelled: false};
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (stats.chunksRead === chunks) {
            controller.close();
            return;
          }
          stats.chunksRead++;
          controller.enqueue(new Uint8Array(1 << 20));
        },
        cancel() {
          stats.cancelled = true;
        }
      },
      {highWaterMark: 0}
    );
    return {response: new Response(body, {status: 200, headers}), stats};
  }

  test('a whole archive answering a range request is not read past the range', async () => {
    const warn = vi.spyOn(log, 'warn');
    const {response, stats} = createLongResponse(64);
    const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch;
    const resolved = await resolveBasemapStyle(style, {fetch});
    expect(resolved.sources.source.tiles).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be loaded'));
    expect(stats.chunksRead).toBeLessThanOrEqual(1);
    expect(stats.cancelled).toBe(true);
  });

  test('a whole archive of a known length is refused before its body is read', async () => {
    vi.spyOn(log, 'warn');
    const {response, stats} = createLongResponse(64, {'Content-Length': String(64 << 20)});
    const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch;
    const resolved = await resolveBasemapStyle(style, {fetch});
    expect(resolved.sources.source.tiles).toBeUndefined();
    expect(stats.chunksRead).toBe(0);
    expect(stats.cancelled).toBe(true);
  });

  test('the least recently used archive reader is released past the limit', async () => {
    const urls = Array.from(
      {length: MAX_OPEN_ARCHIVES + 1},
      (_, index) => `https://data.example.com/region-${index}.pmtiles`
    );
    const fixture = readFixture('vector.pmtiles');
    const server = createServer(Object.fromEntries(urls.map(url => [url, fixture])));
    const tileFetch = getTileLoadOptions(
      {type: 'vector', tiles: [`pmtiles://${urls[0]}/{z}/{x}/{y}`]},
      {fetch: server.fetch}
    )!.fetch!;
    const headerReads = (url: string) =>
      server.requests.filter(request => request.url === url && request.range?.startsWith('bytes=0-'))
        .length;
    const read = (url: string) => tileFetch(`pmtiles://${url}/0/0/0`);
    for (const url of urls.slice(0, MAX_OPEN_ARCHIVES)) {
      await read(url);
    }
    // Reading the first archive again makes the second the least recently used, which the last
    // archive releases when it opens.
    await read(urls[0]);
    await read(urls[MAX_OPEN_ARCHIVES]);
    await read(urls[0]);
    await read(urls[2]);
    expect(headerReads(urls[0])).toBe(1);
    expect(headerReads(urls[2])).toBe(1);
    await read(urls[1]);
    expect(headerReads(urls[1])).toBe(2);
  });
});

describe('pmtiles:// tile requests', () => {
  async function getTileFetch(
    name: string,
    type: string,
    fetchOptions?: RequestInit,
    archive = readFixture(`${name}.pmtiles`)
  ) {
    const url = `https://data.example.com/${name}.pmtiles`;
    const server = createServer({[url]: archive});
    const loadOptions = {fetch: server.fetch, fetchOptions};
    const style = await resolveBasemapStyle(
      {version: 8, sources: {source: {type, url: `pmtiles://${url}`}}, layers: []},
      loadOptions
    );
    const source = style.sources.source;
    const tileLoadOptions = getTileLoadOptions(source, loadOptions);
    const getTileUrl = (z: number, x: number, y: number) =>
      source
        .tiles![0].replace('{z}', String(z))
        .replace('{x}', String(x))
        .replace('{y}', String(y));
    return {url, source, server, loadOptions, tileLoadOptions, getTileUrl};
  }

  test('each vector tile is read from the archive, decompressed, as the plain tile', async () => {
    const {tileLoadOptions, getTileUrl} = await getTileFetch('vector', 'vector');
    for (const [z, x, y] of [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [1, 0, 1],
      [1, 1, 1]
    ]) {
      const response = await tileLoadOptions!.fetch!(getTileUrl(z, x, y));
      expect(response.headers.get('Content-Type')).toBe('application/vnd.mapbox-vector-tile');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        readFixture(`tiles/vector/${z}/${x}/${y}.mvt`)
      );
    }
  });

  test('each raster tile is the plain tile', async () => {
    const {tileLoadOptions, getTileUrl} = await getTileFetch('raster', 'raster');
    const response = await tileLoadOptions!.fetch!(getTileUrl(1, 1, 0));
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      readFixture('tiles/raster/1/1/0.png')
    );
  });

  test('tiles load with range requests to the archive alone, with fetchOptions', async () => {
    const {url, server, tileLoadOptions, getTileUrl} = await getTileFetch('dem', 'raster-dem', {
      headers: {Authorization: 'Bearer token'}
    });
    await tileLoadOptions!.fetch!(getTileUrl(1, 0, 1));
    await tileLoadOptions!.fetch!(getTileUrl(0, 0, 0));
    expect(server.requests.length).toBeGreaterThan(1);
    for (const request of server.requests) {
      expect(request.url).toBe(url);
      expect(request.range).toMatch(/^bytes=\d+-\d+$/);
      expect(request.headers.get('Authorization')).toBe('Bearer token');
    }
  });

  test('a tile that the archive does not hold is an empty response', async () => {
    const {tileLoadOptions, getTileUrl} = await getTileFetch('raster', 'raster');
    const response = await tileLoadOptions!.fetch!(getTileUrl(2, 0, 0));
    expect(response.status).toBe(204);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test('other URLs go to the fetch of the load options', async () => {
    const {server, tileLoadOptions} = await getTileFetch('raster', 'raster');
    const response = await tileLoadOptions!.fetch!('https://other.example.com/sprite.json', {
      method: 'HEAD'
    });
    expect(response.status).toBe(404);
    expect(server.fetch).toHaveBeenLastCalledWith('https://other.example.com/sprite.json', {
      method: 'HEAD'
    });
  });

  test('a source keeps the same tile load options for the same load options', async () => {
    const {source, loadOptions, tileLoadOptions} = await getTileFetch('raster', 'raster');
    expect(getTileLoadOptions(source, loadOptions)).toBe(tileLoadOptions);
    expect(tileLoadOptions).toMatchObject({fetchOptions: loadOptions.fetchOptions});
    expect(getTileLoadOptions(source, null)).toBe(getTileLoadOptions(source, undefined));
    const plain = {type: 'raster', tiles: ['https://tiles.example.com/{z}/{x}/{y}.png']};
    expect(getTileLoadOptions(plain, loadOptions)).toBe(loadOptions);
    expect(getTileLoadOptions(plain, null)).toBe(null);
  });

  test('tile URLs are parsed back to the archive URL and tile index', () => {
    expect(parsePMTilesTileUrl('pmtiles://https://a.example.com/x.pmtiles?k=1/12/34/56')).toEqual({
      archiveUrl: 'https://a.example.com/x.pmtiles?k=1',
      z: 12,
      x: 34,
      y: 56
    });
    expect(parsePMTilesTileUrl('https://a.example.com/12/34/56')).toBeNull();
  });
});
