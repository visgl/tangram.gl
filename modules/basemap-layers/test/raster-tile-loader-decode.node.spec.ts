// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';

const {parse} = vi.hoisted(() => ({parse: vi.fn(async (_data: unknown, _options?: unknown) => ({width: 256, height: 256}))}));

vi.mock('@loaders.gl/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@loaders.gl/core')>()),
  parse
}));

const {RasterTileLoader} = await import('../src/raster-tile-loader');

describe('RasterTileLoader default decoder', () => {
  test('decodes a tile with the loadOptions of the layer', async () => {
    const loadOptions = {
      fetch: (async () => new Response(new Uint8Array([9, 9, 9]))) as typeof fetch,
      imagebitmap: {colorSpaceConversion: 'none'}
    };
    const loader = new RasterTileLoader({
      tiles: ['https://tiles.test/{z}/{x}/{y}.png'],
      sourceId: 'imagery',
      rejectTile: () => false,
      loadOptions
    });
    await loader.getTileData({index: {x: 0, y: 0, z: 0}, id: '0-0-0'} as any);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(parse.mock.calls[0][1]).toMatchObject({imagebitmap: {colorSpaceConversion: 'none'}});
  });
});
