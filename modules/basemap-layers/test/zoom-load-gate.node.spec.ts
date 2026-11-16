// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {RequestScheduler} from '@loaders.gl/core/loader-utils';
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
  const tileset = layer.props.data;
  // A first tile selection sets the traversal context. The first zoom of a view is not a change.
  select(tileset, 2.2);
  return {basemap, fetch, tileset};
}

/** Selects the tiles of the main view at a zoom. */
function select(tileset: any, zoomLevel: number) {
  tileset.getTileIndices({
    viewState: new WebMercatorViewport({width: 64, height: 64, zoom: zoomLevel}),
    maxZoom: 14,
    minZoom: 0
  });
}

/** Records two zooms of the main view, as two tile selections in a zoom gesture do. */
function zoom(tileset: any) {
  select(tileset, 2);
  select(tileset, 2.2);
}

/** Loads a tile through the tileset, at rest, so that it draws in place of its descendants. */
async function loadAncestor(tileset: any, index: {x: number; y: number; z: number}) {
  const tile = tileset.getTile(index, true);
  await vi.waitFor(() => expect(tile.isLoaded).toBe(true));
  expect(tile.content).toBeTruthy();
  return tile;
}

/** Waits long enough for a load that is not held to start. */
function settle() {
  return new Promise(resolve => setTimeout(resolve, 20));
}

describe('BasemapLayer zoomLoadDelay', () => {
  test('a tile that a view still selects when the zoom comes to rest loads after the delay', async () => {
    const {basemap, fetch, tileset} = createBasemap(60);
    const view = Symbol('view');
    tileset.attachConsumer(view);
    await loadAncestor(tileset, {x: 0, y: 0, z: 1});
    const loads = fetch.mock.calls.length;
    zoom(tileset);
    const tile = tileset.getTile({x: 1, y: 1, z: 2}, true);
    tileset.updateConsumer(view, [tile], [tile]);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(loads);
    await vi.waitFor(() => expect(tile.isLoaded).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(loads + 1);
    basemap.finalizeState();
  });

  test('a tile that no view selects when the zoom comes to rest is cancelled, not loaded', async () => {
    const {basemap, fetch, tileset} = createBasemap(30);
    await loadAncestor(tileset, {x: 0, y: 0, z: 1});
    const loads = fetch.mock.calls.length;
    zoom(tileset);
    const tile = tileset.getTile({x: 0, y: 0, z: 2}, true);
    await vi.waitFor(() => expect(tile.isLoading).toBe(false));
    expect(tile.isLoaded).toBe(false);
    expect(tile.needsReload).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(loads);
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
    const tile = tileset.getTile({x: 0, y: 0, z: 2}, true);
    await vi.waitFor(() => expect(tile.isLoaded).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
    basemap.finalizeState();
  });

  test('an ancestor 3 tile zooms up holds a load; one 4 tile zooms up does not', async () => {
    const {basemap, fetch, tileset} = createBasemap(10_000);
    await loadAncestor(tileset, {x: 0, y: 0, z: 1});
    const loads = fetch.mock.calls.length;
    zoom(tileset);
    const far = tileset.getTile({x: 0, y: 0, z: 5}, true);
    await vi.waitFor(() => expect(far.isLoaded).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(loads + 1);

    const near = tileset.getTile({x: 7, y: 7, z: 4}, true);
    await settle();
    expect(near.isLoading).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(loads + 1);
    basemap.finalizeState();
  });

  test('held tiles do not take the request slots: a tile without a loaded ancestor starts at once', async () => {
    const {basemap, fetch, tileset} = createBasemap(10_000);
    const {maxRequests} = tileset.opts;
    expect(maxRequests).toBe(6);
    await loadAncestor(tileset, {x: 0, y: 0, z: 1});
    const loads = fetch.mock.calls.length;
    zoom(tileset);
    // Descendants of the loaded tile, held while the view zooms: as many as the request slots.
    const held = Array.from({length: maxRequests}, (_, i) =>
      tileset.getTile({x: i % 4, y: Math.floor(i / 4), z: 3}, true)
    );
    await settle();
    expect(fetch).toHaveBeenCalledTimes(loads);

    // Outside the loaded tile: nothing draws in its place, so it must not wait for a slot.
    const uncovered = tileset.getTile({x: 7, y: 7, z: 3}, true);
    await vi.waitFor(() => expect(uncovered.isLoaded).toBe(true), {timeout: 500});
    expect(fetch).toHaveBeenCalledTimes(loads + 1);
    expect(held.every(tile => tile.isLoading && !tile.isLoaded)).toBe(true);
    basemap.finalizeState();
  });

  test('a held load that a newer load replaced takes no request slot', async () => {
    const schedule = vi.spyOn(RequestScheduler.prototype, 'scheduleRequest');
    const {basemap, fetch, tileset} = createBasemap(60);
    const view = Symbol('view');
    tileset.attachConsumer(view);
    await loadAncestor(tileset, {x: 0, y: 0, z: 1});
    const scheduler = schedule.mock.contexts[0] as unknown as RequestScheduler;
    const loads = fetch.mock.calls.length;
    fetch.mockImplementation(() => new Promise(() => {}));
    zoom(tileset);
    const index = {x: 1, y: 1, z: 2};
    const tile = tileset.getTile(index, true);
    tile.abort();
    expect(tileset.getTile(index, true)).toBe(tile);
    tileset.updateConsumer(view, [tile], [tile]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(loads + 1));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(loads + 1);
    expect(scheduler.activeRequestCount).toBe(1);
    expect(tile.isLoading).toBe(true);
    schedule.mockRestore();
    basemap.finalizeState();
  });

  test('without zoomLoadDelay a tile loads at once, selected or not', async () => {
    const {basemap, fetch, tileset} = createBasemap(0);
    zoom(tileset);
    const tile = tileset.getTile({x: 0, y: 0, z: 2}, true);
    await vi.waitFor(() => expect(tile.isLoaded).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
    basemap.finalizeState();
  });
});
