// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable import/no-extraneous-dependencies */
import {readFileSync} from 'node:fs';
import {SharedTileset2D} from '@deck.gl-community/geo-layers';
import {log} from '@deck.gl/core';
import {afterEach, describe, expect, expectTypeOf, test, vi} from 'vitest';
import {
  BasemapLayer,
  getBasemapLayers,
  getGlobeBaseLayers,
  getGlobeTopLayers,
  type BasemapGlobeConfig,
  type BasemapLayerLoadOptions,
  type BasemapLayerProps,
  type BasemapStyle,
  type ResolvedBasemapStyle,
  type ResolvedBasemapStyleLayer
} from '../src/index';
import type {ResolvedBasemapStyle as MapStyleResolvedBasemapStyle} from '../src/map-style';
import {
  BASEMAP_API_REFERENCE_PAGES,
  getBasemapDocPaths,
  toPackageDoc
} from '../../../scripts/sync-basemap-docs.mjs';

const SOURCE = {type: 'vector', tiles: ['https://tiles.example.com/{z}/{x}/{y}.mvt']};
const STYLE: any = {
  version: 8,
  sources: {tiles: SOURCE},
  layers: [{id: 'water', type: 'fill', source: 'tiles', 'source-layer': 'water'}]
};

afterEach(() => vi.restoreAllMocks());

describe('root exports', () => {
  test('the prop and style types are exported from the root', () => {
    expectTypeOf<BasemapLayerProps['style']>().toEqualTypeOf<string | BasemapStyle | null | undefined>();
    expectTypeOf<BasemapLayerProps['loadOptions']>().toEqualTypeOf<
      BasemapLayerLoadOptions | null | undefined
    >();
    expectTypeOf<BasemapGlobeConfig['labels']>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ResolvedBasemapStyle>().toEqualTypeOf<MapStyleResolvedBasemapStyle>();
    expectTypeOf<ResolvedBasemapStyleLayer['id']>().toEqualTypeOf<string>();
  });

  test('style is optional, as its default is null', () => {
    expect(BasemapLayer.defaultProps.style).toBeNull();
    const props: BasemapLayerProps = {id: 'basemap'};
    expect(new BasemapLayer(props).props.style).toBeNull();
  });
});

describe('getGlobeBaseLayers (deprecated)', () => {
  test('passes every option on, as getBasemapLayers with mode globe does', () => {
    const tileset = new SharedTileset2D({getTileData: () => null} as any);
    const tilesets = new Map([[SOURCE, tileset]]);
    const fetch = vi.fn();
    const options = {styleDefinition: STYLE, zoom: 4, tilesets, fetch, projectedMaxStretch: 16};
    const [vector]: any[] = getGlobeBaseLayers(options as any).filter(
      (layer: any) => layer.id === 'globe-basemap-tiles'
    );
    const [expected]: any[] = getBasemapLayers({
      ...options,
      idPrefix: 'globe-basemap',
      mode: 'globe'
    } as any).filter((layer: any) => layer.id === 'globe-basemap-tiles');
    // The tilesets were dropped before: the layer made its own.
    expect(vector.props.data).toBe(tileset);
    expect(vector.props.data).toBe(expected.props.data);
    tileset.finalize();
  });

  test('logs a deprecation warning', () => {
    const deprecated = vi.spyOn(log, 'deprecated');
    getGlobeBaseLayers({styleDefinition: STYLE});
    expect(deprecated).toHaveBeenCalledWith('getGlobeBaseLayers', expect.stringContaining('getBasemapLayers'));
  });
});

describe('getGlobeTopLayers', () => {
  test('takes no options, as the other helpers make globe optional', () => {
    expect(getGlobeTopLayers()).toEqual([]);
    expect(getGlobeTopLayers({})).toEqual([]);
    expect(getGlobeTopLayers({globe: {}})).toEqual([]);
    expect(getGlobeTopLayers({globe: {config: {atmosphere: true}}})).toHaveLength(1);
  });
});

describe('API reference copies', () => {
  test.each(BASEMAP_API_REFERENCE_PAGES)(
    'the package copy of %s is generated from the website copy',
    page => {
      const {source, target} = getBasemapDocPaths(page);
      // After an edit of the website copy, run `node scripts/sync-basemap-docs.mjs`.
      expect(readFileSync(target, 'utf8')).toBe(toPackageDoc(readFileSync(source, 'utf8')));
    }
  );

  test('the package copy has an HTML license header and no live example', () => {
    const doc = toPackageDoc(
      "{/*\nlicense\n */}\n\nimport LayerLiveExample from '@site/x';\n\n# A\n\n<LayerLiveExample highlight=\"a\" />\n\ntext\n"
    );
    expect(doc).toBe('<!--\nlicense\n-->\n\n# A\n\ntext\n');
  });

  test('the API reference documents each prop of BasemapLayer', () => {
    const doc = readFileSync(getBasemapDocPaths('basemap-layer.md').source, 'utf8');
    for (const prop of Object.keys(BasemapLayer.defaultProps)) {
      expect(doc).toContain(`### \`${prop}\``);
    }
  });
});
