// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {createPMTilesSource} from '../modules/tangram-renderer/src/procedures/pmtiles-loader';
import {parseMvtWithLoaders} from '../modules/tangram-renderer/src/procedures/mvt-loaders';
import {parseMvtWithLegacy} from '../modules/tangram-renderer/src/procedures/mvt-legacy';

/** Valid single-point MVT, constructed inline rather than downloaded from a service. */
const tileBytes = new Uint8Array([26, 23, 10, 5, 114, 111, 97, 100, 115,
    18, 9, 8, 7, 24, 1, 34, 3, 9, 0, 0, 40, 128, 32, 120, 2]);

/** Minimal uncompressed PMTiles v3 archive with one z0 tile and authored provider credits. */
function createArchive(): Uint8Array<ArrayBuffer> {
    const metadata = new TextEncoder().encode(JSON.stringify({name: 'Fixture map', attribution: '© Fixture provider', vector_layers: []}));
    const directory = new Uint8Array([1, 0, 1, tileBytes.length, 1]);
    const metadataOffset = 127 + directory.length;
    const tileOffset = metadataOffset + metadata.length;
    const archive = new Uint8Array(16384);
    archive.set(new TextEncoder().encode('PMTiles'));
    const header = new DataView(archive.buffer);
    header.setUint8(7, 3);
    for (const [offset, value] of [[8, 127], [16, directory.length], [24, metadataOffset], [32, metadata.length],
        [40, tileOffset], [56, tileOffset], [64, tileBytes.length], [72, 1], [80, 1], [88, 1]]) {
        header.setBigUint64(offset, BigInt(value), true);
    }
    archive.set([1, 1, 1, 1, 0, 0], 96);
    for (const [offset, value] of [[102, -180], [106, -85], [110, 180], [114, 85]]) {
        header.setInt32(offset, value * 1e7, true);
    }
    archive.set(directory, 127); archive.set(metadata, metadataOffset); archive.set(tileBytes, tileOffset);
    return archive;
}

test('published PMTiles metadata, attribution and range loading feed both MVT parsers hermetically', async () => {
    const archive = createArchive();
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
        expect(url).toBe('https://fixtures.test/map.pmtiles');
        const headers = new Headers(options?.headers);
        expect(headers.get('Authorization')).toBe('fixture-token');
        const range = headers.get('Range') ?? '';
        const match = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!match) throw new Error('PMTiles must issue a byte range');
        const start = Number(match[1]), end = Number(match[2]);
        requests.push(range);
        return new Response(archive.slice(start, end + 1), {status: 206,
            headers: {'Content-Range': `bytes ${start}-${end}/${archive.length}`}});
    }));
    const source = createPMTilesSource('https://fixtures.test/map.pmtiles', {headers: {Authorization: 'fixture-token'}});
    try {
        expect(await source.getMetadata?.()).toMatchObject({format: 'pmtiles', minZoom: 0, maxZoom: 0,
            boundingBox: [[-180, -85], [180, 85]], attributions: ['© Fixture provider']});
        const bytes = await source.getTile({x: 0, y: 0, z: 0});
        expect(bytes).toEqual(tileBytes.buffer);
        if (!bytes) throw new Error('Archive fixture tile missing');
        expect(parseMvtWithLoaders(bytes)).toEqual(parseMvtWithLegacy(bytes));
        expect(parseMvtWithLoaders(bytes).roads.features[0].id).toBe(7);
        expect(requests.length).toBeGreaterThanOrEqual(2);
        source.dispose();
        await expect(source.getTile({x: 0, y: 0, z: 0})).rejects.toMatchObject({name: 'AbortError'});
    } finally { source.dispose(); vi.unstubAllGlobals(); }
});
