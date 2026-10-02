// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import DataSource, {NetworkTileSource} from '../src/sources/data_source';
import Scene from '../src/scene/scene';
import Renderer from '../src/scene/renderer';
import Utils from '../src/utils/utils';

afterEach(() => vi.restoreAllMocks());

test('collects all configured credits, deduplicates them and handles removed/replaced sources', async () => {
    const scene = Scene.create({});
    scene.sources = {
        roads: new DataSource({name: 'roads', attribution: ' © OpenStreetMap '}),
        labels: new DataSource({name: 'labels', attribution: '© OpenStreetMap'}),
        imagery: new DataSource({name: 'imagery', attribution: '<a href="https://provider.example">Imagery</a>'}),
        blank: new DataSource({name: 'blank', attribution: '  '}),
        invalid: new DataSource({name: 'invalid', attribution: {text: 'not a string'}})
    };
    expect(await scene.getAttributions()).toEqual(['© OpenStreetMap', '<a href="https://provider.example">Imagery</a>']);
    scene.sources = {replacement: new DataSource({name: 'replacement', attribution: '© New provider'})};
    expect(await scene.getAttributions()).toEqual(['© New provider']);
    scene.sources = {};
    expect(await scene.getAttributions()).toEqual([]);
});

test('TileJSON discovers required credits once, retaining explicit credits and the existing tile URL path', async () => {
    const attribution = '<a href="https://openfreemap.org">OpenFreeMap</a> © OpenMapTiles Data from OpenStreetMap';
    const request = vi.spyOn(Utils, 'io').mockResolvedValue({status: 200,
        body: JSON.stringify({tiles: ['./tiles/{z}/{x}/{y}.pbf'], attribution})});
    const scene = Scene.create({});
    const source = new NetworkTileSource({name: 'open', tilejson: 'https://provider.example/planet', attribution: '© Local overlay'});
    scene.sources = {open: source};
    const [first, second] = await Promise.all([scene.getAttributions(), scene.getAttributions()]);
    expect(first).toEqual(['© Local overlay', attribution]);
    expect(second).toEqual(first);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await source.resolveURL()).toBe('https://provider.example/./tiles/{z}/{x}/{y}.pbf');
    expect(request).toHaveBeenCalledTimes(1);
});

test('URL-backed sources require explicit attribution and do not fetch tile payloads for credits', async () => {
    const request = vi.spyOn(Utils, 'io');
    const scene = Scene.create({});
    scene.sources = {vector: new NetworkTileSource({name: 'vector', url: 'https://provider.example/{z}/{x}/{y}.pbf', attribution: '© Provider'})};
    expect(await scene.getAttributions()).toEqual(['© Provider']);
    expect(request).not.toHaveBeenCalled();
});

test.each([false, true])('setDataSource replaces existing provider credits and notifies subscribers (TileJSON: %s)', async useTileJSON => {
    const request = vi.spyOn(Utils, 'io')
        .mockResolvedValueOnce({status: 200, body: JSON.stringify({
            tiles: ['https://old.example/{z}/{x}/{y}.pbf'], attribution: '© Old metadata'
        })})
        .mockResolvedValueOnce({status: 200, body: JSON.stringify({
            tiles: ['https://new.example/{z}/{x}/{y}.pbf'], attribution: '© New metadata'
        })});
    const scene = Scene.create({});
    Object.assign(scene, {config: {
        sources: {basemap: {type: 'MVT', tilejson: 'https://old.example/planet', attribution: '© Old explicit'}},
        layers: {roads: {data: {source: 'basemap'}}}
    }});
    scene.createDataSources();
    const previousSource = scene.sources.basemap;
    expect(await scene.getAttributions()).toEqual(['© Old explicit', '© Old metadata']);
    const rebuild = vi.spyOn(scene, 'rebuild').mockResolvedValue(undefined);
    const updateConfig = vi.spyOn(scene, 'updateConfig');
    const subscriberCredits: Promise<string[]>[] = [];
    const update = vi.fn(() => subscriberCredits.push(scene.getAttributions()));
    scene.subscribe({update});

    await scene.setDataSource('basemap', {
        type: 'MVT', attribution: '© New explicit', tile_size: 512,
        ...(useTileJSON ? {tilejson: 'https://new.example/planet'} : {url: 'https://new.example/{z}/{x}/{y}.pbf'})
    });

    const expected = useTileJSON ? ['© New explicit', '© New metadata'] : ['© New explicit'];
    expect(scene.sources.basemap).not.toBe(previousSource);
    expect(scene.sources.basemap.tile_size).toBe(512);
    expect(scene.sources.basemap).toMatchObject({builds_geometry_tiles: true});
    expect(await scene.getAttributions()).toEqual(expected);
    expect(await Promise.all(subscriberCredits)).toEqual([expected]);
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateConfig).not.toHaveBeenCalled();
    expect(rebuild).toHaveBeenCalledExactlyOnceWith({sources: ['basemap']});
    expect(request).toHaveBeenCalledTimes(useTileJSON ? 2 : 1);
});

test.each([undefined, 12, {}, '  '])('invalid/absent TileJSON attribution %s is ignored, not interpreted as markup', async attribution => {
    vi.spyOn(Utils, 'io').mockResolvedValue({status: 200, body: JSON.stringify({tiles: ['https://provider.example/{z}/{x}/{y}.pbf'], attribution})});
    const scene = Scene.create({});
    scene.sources = {vector: new NetworkTileSource({name: 'vector', tilejson: 'https://provider.example/planet', attribution: '© Explicit'})};
    expect(await scene.getAttributions()).toEqual(['© Explicit']);
});

test('metadata failures reject rather than silently report incomplete attribution', async () => {
    vi.spyOn(Utils, 'io').mockRejectedValue(new Error('TileJSON unavailable'));
    const scene = Scene.create({});
    scene.sources = {vector: new NetworkTileSource({name: 'vector', tilejson: 'https://provider.example/planet', attribution: '© Explicit'})};
    await expect(scene.getAttributions()).rejects.toThrow('TileJSON unavailable');
});

test('the host renderer delegates credits to its scene without adding a UI dependency', async () => {
    const renderer = new Renderer({});
    vi.spyOn(renderer.scene, 'getAttributions').mockResolvedValue(['© Provider']);
    expect(await renderer.getAttributions()).toEqual(['© Provider']);
});
