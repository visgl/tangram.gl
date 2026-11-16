// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {BasemapLayer} from '../src/basemap-layer';
import {ZoomLoadGate} from '../src/zoom-load-gate';

describe('ZoomLoadGate', () => {
  test('the first zoom of a view is not a change, and a pan does not change the zoom', () => {
    const gate = new ZoomLoadGate();
    gate.delay = 100;
    gate.noteZoom('main', 10, 1000);
    gate.noteZoom('main', 10, 1050);
    expect(gate.getRemainingDelay(1060)).toBe(0);
  });

  test('a zoom change holds loads for the delay after the last change', () => {
    const gate = new ZoomLoadGate();
    gate.delay = 100;
    gate.noteZoom('main', 10, 1000);
    gate.noteZoom('main', 10.2, 1050);
    expect(gate.getRemainingDelay(1060)).toBe(90);
    gate.noteZoom('main', 10.4, 1120);
    expect(gate.getRemainingDelay(1160)).toBe(60);
    expect(gate.getRemainingDelay(1220)).toBe(0);
  });

  test('each view has its own zoom: two views at different zooms do not hold loads', () => {
    const gate = new ZoomLoadGate();
    gate.delay = 100;
    for (const now of [1000, 1010, 1020]) {
      gate.noteZoom('main', 10, now);
      gate.noteZoom('minimap', 4, now);
    }
    expect(gate.getRemainingDelay(1030)).toBe(0);
  });

  test('without a delay, loads are not held', () => {
    const gate = new ZoomLoadGate();
    gate.noteZoom('main', 10, 1000);
    gate.noteZoom('main', 12, 1001);
    expect(gate.getRemainingDelay(1001)).toBe(0);
  });

  test('wait resolves when the zoom has been still for the delay, or on abort', async () => {
    const gate = new ZoomLoadGate();
    gate.delay = 40;
    gate.noteZoom('main', 10);
    gate.noteZoom('main', 11);
    const start = performance.now();
    await gate.wait();
    expect(performance.now() - start).toBeGreaterThanOrEqual(35);

    gate.delay = 10_000;
    gate.noteZoom('main', 12);
    const controller = new AbortController();
    const waiting = gate.wait(controller.signal);
    controller.abort();
    expect(await waiting).toBe(true);
    expect(gate.getRemainingDelay()).toBeGreaterThan(0);
  });

  test('wait returns at once, unheld, when the caller does not hold the load', async () => {
    const gate = new ZoomLoadGate();
    gate.delay = 10_000;
    gate.noteZoom('main', 10);
    gate.noteZoom('main', 11);
    expect(await gate.wait(null, () => false)).toBe(false);
  });
});

const style: any = {
  version: 8,
  sources: {tiles: {type: 'vector', maxzoom: 14, tiles: ['https://example.com/{z}/{x}/{y}.pbf']}},
  layers: [{id: 'water', type: 'fill', source: 'tiles', 'source-layer': 'water'}]
};

function createBasemap(zoomLoadDelay: number) {
  const fetch = vi.fn(async () => []);
  const basemap = new BasemapLayer({id: 'test', style, fetch, zoomLoadDelay} as any);
  basemap.initializeState();
  basemap.state.resolvedStyle = style;
  basemap.context = {viewport: new WebMercatorViewport({width: 64, height: 64, zoom: 2})} as any;
  const [layer]: any[] = basemap.renderLayers();
  return {basemap, fetch, tileset: layer.props.data};
}

/**
 * A tileset whose `getTile` returns `header` at its index, and a loaded ancestor `zooms` tile zooms
 * up, or none with 0.
 */
function stubTiles(tileset: any, header: {index: {x: number; y: number; z: number}}, zooms: number) {
  vi.spyOn(tileset, 'getTile').mockImplementation((index: any) => {
    if (index.z === header.index.z) {
      return header;
    }
    return zooms && index.z === header.index.z - zooms ? {isLoaded: true, content: []} : undefined;
  });
}

/** Records two zooms of the main view, as two tile selections in a zoom gesture do. */
function zoom(tileset: any) {
  for (const zoomLevel of [2, 2.2]) {
    tileset.getTileIndices({
      viewState: new WebMercatorViewport({width: 64, height: 64, zoom: zoomLevel}),
      maxZoom: 14,
      minZoom: 0
    });
  }
}

describe('BasemapLayer zoomLoadDelay', () => {
  test('a tile that a view still selects when the zoom comes to rest loads after the delay', async () => {
    const {basemap, fetch, tileset} = createBasemap(50);
    zoom(tileset);
    const header = {index: {x: 1, y: 1, z: 2}, abort: vi.fn()};
    stubTiles(tileset, header, 1);
    tileset.updateConsumer(Symbol('view'), [header], [header]);
    const loaded = tileset.opts.getTileData({index: header.index, id: '0-0-2', signal: new AbortController().signal});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    await loaded;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(header.abort).not.toHaveBeenCalled();
    basemap.finalizeState();
  });

  test('a tile that no view selects when the zoom comes to rest is cancelled, not loaded', async () => {
    const {basemap, fetch, tileset} = createBasemap(30);
    zoom(tileset);
    const controller = new AbortController();
    const header = {index: {x: 0, y: 0, z: 2}, abort: vi.fn(() => controller.abort())};
    stubTiles(tileset, header, 1);
    const content = await tileset.opts.getTileData({index: header.index, id: '0-0-2', signal: controller.signal});
    expect(content).toBeNull();
    expect(header.abort).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    basemap.finalizeState();
  });

  test('a tile cancelled at rest loads when a view selects it again', async () => {
    const {basemap, fetch, tileset} = createBasemap(100);
    zoom(tileset);
    const view = Symbol('view');
    tileset.attachConsumer(view);
    const parent = tileset.getTile({x: 0, y: 0, z: 1}, true);
    await vi.waitFor(() => expect(parent.isLoaded).toBe(true));
    expect(parent.content).toBeTruthy();
    const loads = fetch.mock.calls.length;

    zoom(tileset);
    const index = {x: 1, y: 1, z: 2};
    const tile = tileset.getTile(index, true);
    tileset.updateConsumer(view, [parent], [parent]);
    await vi.waitFor(() => expect(tile.isLoading).toBe(false));
    expect(tile.isLoaded).toBe(false);
    expect(tile.needsReload).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(loads);

    tileset.updateConsumer(view, [tile], [tile]);
    expect(tileset.getTile(index, true)).toBe(tile);
    await vi.waitFor(() => expect(tile.isLoaded).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(loads + 1);
    basemap.finalizeState();
  });

  test('a tile without a loaded ancestor, as at the edge of a zoom out, loads at once', async () => {
    const {basemap, fetch, tileset} = createBasemap(10_000);
    zoom(tileset);
    const header = {index: {x: 0, y: 0, z: 2}, abort: vi.fn()};
    stubTiles(tileset, header, 0);
    await tileset.opts.getTileData({index: header.index, id: '0-0-2', signal: new AbortController().signal});
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(header.abort).not.toHaveBeenCalled();
    basemap.finalizeState();
  });

  test('an ancestor 3 tile zooms up holds a load; one 4 tile zooms up does not', async () => {
    const {basemap, fetch, tileset} = createBasemap(10_000);
    zoom(tileset);
    const header = {index: {x: 0, y: 0, z: 6}, abort: vi.fn()};
    stubTiles(tileset, header, 4);
    await tileset.opts.getTileData({index: header.index, id: '0-0-6', signal: new AbortController().signal});
    expect(fetch).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    stubTiles(tileset, header, 3);
    const held = tileset.opts.getTileData({index: header.index, id: '0-0-6', signal: controller.signal});
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.abort();
    expect(await held).toBeNull();
    basemap.finalizeState();
  });

  test('without zoomLoadDelay a tile loads at once, selected or not', async () => {
    const {basemap, fetch, tileset} = createBasemap(0);
    zoom(tileset);
    await tileset.opts.getTileData({index: {x: 0, y: 0, z: 2}, id: '0-0-2', signal: new AbortController().signal});
    expect(fetch).toHaveBeenCalledTimes(1);
    basemap.finalizeState();
  });
});
