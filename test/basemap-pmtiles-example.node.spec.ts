// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {WebMercatorViewport} from '@deck.gl/core';
import {validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import {describe, expect, test} from 'vitest';

import {ARCHIVE_OPTIONS} from '../examples/layers/basemap-pmtiles/archives';
import {fitViewState} from '../examples/layers/basemap-pmtiles/view-bounds';
import {
  createRangeReadFetch,
  formatBytes,
  getReadsText,
  parseArchiveSize,
  type ArchiveReads
} from '../examples/layers/basemap-pmtiles/range-reads';

const ARCHIVE = 'https://example.com/a.pmtiles';

function rangeInit(range = 'bytes=0-16383'): RequestInit {
  return {headers: {Range: range}};
}

describe('PMTiles example: archives', () => {
  test.each(ARCHIVE_OPTIONS.map(option => [option.id, option] as const))(
    'the %s style is valid and reads its archive through one pmtiles:// source',
    (_id, option) => {
      expect(validateStyleMin(option.style as never)).toEqual([]);
      const sources = Object.values(option.style.sources || {});
      expect(sources).toHaveLength(1);
      expect(sources[0].url).toBe(`pmtiles://${option.url}`);
      expect(sources[0].type).toBe(option.id);
    }
  );
});

/**
 * The area that the tiles of each archive cover, from the archive directories. Florence: zoom 15
 * tiles x 17405 to 17411, y 11941 to 11947, the smallest area of zoom 13 to 15. The world archive
 * repeats in longitude, so only its latitude is limited.
 */
const TILE_COVERAGE = {
  vector: {west: 11.21704, south: 43.73935, east: 11.29395, north: 43.79489},
  raster: {west: -Infinity, south: -85.05113, east: Infinity, north: 85.05113}
};

const SCREENS = [
  [1920, 1080],
  [2560, 1440]
] as const;

describe('PMTiles example: the view stays inside the archive', () => {
  const cases = ARCHIVE_OPTIONS.flatMap(option =>
    SCREENS.flatMap(([width, height]) =>
      (['initial', 'minimum'] as const).map(zoomCase => [option.id, width, height, zoomCase, option] as const)
    )
  );
  test.each(cases)('%s at %ix%i at the %s zoom', (id, width, height, zoomCase, option) => {
    const zoom = zoomCase === 'initial' ? option.view.zoom : option.view.minZoom;
    const viewState = fitViewState({...option.view, zoom}, option.bounds, width, height);
    expect(viewState.zoom).toBeGreaterThanOrEqual(option.view.minZoom);
    const [west, south, east, north] = new WebMercatorViewport({
      ...viewState,
      width,
      height
    }).getBounds();
    const coverage = TILE_COVERAGE[id];
    const epsilon = 1e-6;
    expect(west).toBeGreaterThanOrEqual(coverage.west - epsilon);
    expect(east).toBeLessThanOrEqual(coverage.east + epsilon);
    expect(south).toBeGreaterThanOrEqual(coverage.south - epsilon);
    expect(north).toBeLessThanOrEqual(coverage.north + epsilon);
  });

  test('a pan past the edge stops at the edge, and the zoom does not change', () => {
    const option = ARCHIVE_OPTIONS[0];
    const viewState = fitViewState({...option.view, longitude: 20, zoom: 16}, option.bounds, 1280, 800);
    expect(viewState.zoom).toBe(16);
    const [, , east] = new WebMercatorViewport({...viewState, width: 1280, height: 800}).getBounds();
    expect(east).toBeCloseTo(option.bounds[2], 6);
  });
});

describe('PMTiles example: range reads', () => {
  test('the archive size comes from Content-Range', () => {
    expect(parseArchiveSize('bytes 0-16383/6601156')).toBe(6601156);
    expect(parseArchiveSize('bytes */716052')).toBe(716052);
    expect(parseArchiveSize(null)).toBeNull();
    expect(parseArchiveSize('bytes 0-9/*')).toBeNull();
  });

  test('counts range requests and their bytes per archive, and passes other requests on', async () => {
    const reads = new Map<string, ArchiveReads>();
    let changes = 0;
    const seen: string[] = [];
    const fetchFn = createRangeReadFetch(
      reads,
      () => changes++,
      async input => {
        seen.push(String(input));
        return new Response('x'.repeat(10), {
          status: 206,
          headers: {'Content-Length': '10', 'Content-Range': 'bytes 0-9/500'}
        });
      }
    );
    await fetchFn(ARCHIVE, rangeInit());
    await fetchFn(new URL(ARCHIVE), rangeInit('bytes=10-19'));
    await fetchFn('https://example.com/fonts/0-255.pbf');
    expect(seen).toHaveLength(3);
    expect(reads.get(ARCHIVE)).toEqual({requests: 2, bytes: 20, archiveSize: 500, error: null});
    expect(reads.size).toBe(1);
    expect(changes).toBe(2);
  });

  test('keeps a failed request until a later one is OK', async () => {
    const reads = new Map<string, ArchiveReads>();
    let status = 503;
    const fetchFn = createRangeReadFetch(
      reads,
      () => {},
      async () => new Response(null, {status})
    );
    await fetchFn(ARCHIVE, rangeInit());
    expect(reads.get(ARCHIVE)?.error).toBe('The archive did not load: HTTP 503');
    status = 206;
    await fetchFn(ARCHIVE, rangeInit());
    expect(reads.get(ARCHIVE)?.error).toBeNull();
  });

  test('records a network error, but not a cancelled request', async () => {
    const reads = new Map<string, ArchiveReads>();
    let error: Error = new TypeError('Failed to fetch');
    const fetchFn = createRangeReadFetch(
      reads,
      () => {},
      async () => {
        throw error;
      }
    );
    await expect(fetchFn(ARCHIVE, rangeInit())).rejects.toThrow('Failed to fetch');
    expect(reads.get(ARCHIVE)?.error).toBe('The archive did not load: Failed to fetch');
    reads.get(ARCHIVE)!.error = null;
    error = new DOMException('The operation was aborted.', 'AbortError');
    await expect(fetchFn(ARCHIVE, rangeInit())).rejects.toThrow('aborted');
    expect(reads.get(ARCHIVE)).toMatchObject({requests: 2, error: null});
  });

  test('the readout shows the error, the requests and the share of the archive read', () => {
    expect(getReadsText(undefined)).toEqual(['Range requests: 0']);
    expect(
      getReadsText({requests: 13, bytes: 531_800, archiveSize: null, error: null}, 6_601_156)
    ).toEqual(['Range requests: 13', 'Bytes read: 531.8 kB of 6.60 MB (8.1 %)']);
    expect(
      getReadsText({requests: 1, bytes: 0, archiveSize: 500, error: 'HTTP *503* at a_b'}, 9)
    ).toEqual(['**HTTP \\*503\\* at a\\_b**', 'Range requests: 1', 'Bytes read: 0 B of 500 B (0.00 %)']);
    expect(getReadsText({requests: 2, bytes: 840, archiveSize: null, error: null})).toEqual([
      'Range requests: 2',
      'Bytes read: 840 B'
    ]);
    expect(formatBytes(52_400)).toBe('52.4 kB');
  });
});
