// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {createTileSourceMetadata} from '../src/sources/tile_source_metadata';
import {getMvtTileProvider, registerMvtTileProvider} from '../src/procedures/mvt-tile-provider';

/** Small structural source, independent of scene, network and GPU setup. */
function createSource(config: Record<string, unknown> = {}) {
    return {config: {type: 'MVT', ...config}, name: 'world', zooms: [0, 4, 8], max_zoom: 8,
        getAttributions: () => ['author', 'provider']};
}

test.each([
    {minzoom: 2, maxzoom: 14, bounds: [170, -40, -170, 60], format: 'mvt'},
    {minZoom: 2, maxZoom: 14, boundingBox: [[170, -40], [-170, 60]], format: 'pmtiles'}
])('normalizes TileJSON and archive capabilities: %j', discovered => {
    expect(createTileSourceMetadata(createSource(), discovered)).toMatchObject({format: discovered.format,
        minZoom: 2, maxZoom: 14, boundingBox: [[170, -40], [-170, 60]], attributions: ['author', 'provider']});
});

test('authored bounds and sparse levels override advertised archive capabilities', () => {
    const source = createSource({zooms: [0, 4, 8], bounds: [-10, -20, 30, 40]});
    const metadata = createTileSourceMetadata(source, {format: 'pmtiles', tileMIMEType: 'application/vnd.maplibre-tile',
        minZoom: 2, maxZoom: 14, boundingBox: [[170, -40], [-170, 60]]});
    expect(metadata).toMatchObject({format: 'pmtiles', tileMIMEType: 'application/vnd.maplibre-tile',
        minZoom: 0, maxZoom: 8, boundingBox: [[-10, -20], [30, 40]]});
    expect(source.config).toEqual({type: 'MVT', zooms: [0, 4, 8], bounds: [-10, -20, 30, 40]});
});

test('authored maximum is retained without masking the advertised minimum', () => {
    expect(createTileSourceMetadata(createSource({max_zoom: 8}), {minZoom: 2, maxZoom: 14})).toMatchObject({minZoom: 2, maxZoom: 8});
});

test.each([{minZoom: 14, maxZoom: 2}, {minZoom: 14}])('rejects inverted advertised ranges %j', discovered => {
    expect(createTileSourceMetadata(createSource({max_zoom: 8}), discovered)).toMatchObject({minZoom: 0, maxZoom: 8});
});

test.each([NaN, Infinity, -1, 1.5, 31, '14'])('rejects invalid advertised level %s', value => {
    expect(createTileSourceMetadata(createSource(), {minZoom: value, maxZoom: value})).toMatchObject({minZoom: 0, maxZoom: 8});
});

test.each([[0, 40, 10, -20], [-181, 0, 10, 20], [0, -91, 10, 20], [0, 0, 10, Infinity], [[0, 0, 1], [2, 3]], [[0], [0, 10, 20]]].map(bounds => ({bounds})))(
    'does not expose malformed bounds %j', ({bounds}) => {
        expect(createTileSourceMetadata(createSource(), {bounds})).not.toHaveProperty('boundingBox');
    }
);

test('factory registrations preserve identity guards and duplicate protection', () => {
    const factory = {createSource: () => ({getTile: async () => null, dispose() {}})};
    const unregister = registerMvtTileProvider('metadata-test', factory);
    try {
        expect(getMvtTileProvider('metadata-test')).toBe(factory);
        expect(() => registerMvtTileProvider('metadata-test', factory)).toThrow('already registered');
    } finally { unregister(); }
    const replacement = () => null;
    const unregisterReplacement = registerMvtTileProvider('metadata-test', replacement);
    unregister();
    expect(getMvtTileProvider('metadata-test')).toBe(replacement);
    unregisterReplacement();
    expect(getMvtTileProvider('metadata-test')).toBeUndefined();
});
