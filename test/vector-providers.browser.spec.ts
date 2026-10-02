// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {createVectorSource, resolveVectorProvider, OPENFREEMAP_TILEJSON} from '../examples/classic/app/vector-providers.js';
import {updateAttribution} from '../examples/classic/app/attribution.js';
import {NetworkTileSource} from '../modules/tangram-renderer/src/sources/data_source';
import Utils from '../modules/tangram-renderer/src/utils/utils';

afterEach(() => vi.restoreAllMocks());

test.each([undefined, null, '', 'openfreemap', 'unknown'])('provider %s defaults to OpenFreeMap', provider => {
  expect(resolveVectorProvider(provider)).toBe('openfreemap');
});

test('OpenFreeMap clears inherited URL settings and keeps a stable metadata endpoint and data zoom cap', async () => {
  const source = new NetworkTileSource(Object.assign({name: 'basemap',
    url: 'https://old.example/{z}/{x}/{y}.pbf', url_params: {api_key: 'old-key'}
  }, createVectorSource()));
  const request = vi.spyOn(Utils, 'io').mockResolvedValue({status: 200, body: JSON.stringify({
    tiles: ['https://tiles.example/planet/version/{z}/{x}/{y}.pbf'], attribution: '© Metadata provider'
  })});
  expect(source.tilejson).toBe(OPENFREEMAP_TILEJSON);
  expect(source.max_zoom).toBe(14);
  expect(source.tile_size).toBe(512);
  expect(source.getAttributions()[0]).toContain('OpenMapTiles');
  expect(await source.resolveURL()).toBe('https://tiles.example/planet/version/{z}/{x}/{y}.pbf');
  await source.resolveURL();
  expect(request).toHaveBeenCalledTimes(1);
  expect(source.getAttributions()).toContain('© Metadata provider');
});

test('CARTO remains an explicit URL alternative without TileJSON or OpenFreeMap credits', async () => {
  expect(resolveVectorProvider('carto')).toBe('carto');
  const source = new NetworkTileSource({name: 'basemap', ...createVectorSource('carto')});
  const request = vi.spyOn(Utils, 'io');
  expect(await source.resolveURL()).toContain('cartocdn.com');
  expect(source.tilejson).toBe('');
  expect(request).not.toHaveBeenCalled();
  expect(source.getAttributions().join(' ')).toContain('CARTO');
  expect(source.getAttributions().join(' ')).not.toContain('OpenFreeMap');
});

test('provider switches replace every required link rather than retaining old credits', () => {
  const element = document.createElement('p');
  updateAttribution(element, [createVectorSource().attribution]);
  expect([...element.querySelectorAll('a')].map(link => link.hostname)).toEqual([
    'openfreemap.org', 'www.openmaptiles.org', 'www.openstreetmap.org'
  ]);
  updateAttribution(element, [createVectorSource('carto').attribution]);
  expect(element.textContent).toContain('CARTO');
  expect(element.textContent).not.toContain('OpenMapTiles');
});
