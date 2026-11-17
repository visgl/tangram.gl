// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import {describe, expect, test} from 'vitest';

import {ARCHIVE_OPTIONS} from '../examples/layers/basemap-pmtiles/archives';
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
