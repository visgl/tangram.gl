// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test, vi} from 'vitest';
import {log} from '@deck.gl/core';
import {TaskRunner} from '@math.gl/tasks';
import {getBasemapLayers} from '../src/index.ts';
import {getGeoJsonTileFeatures} from '../src/geojson-source';
import {GeoJsonTask} from '../src/geojson-task';
import {resolveBasemapStyle} from '../src/style-resolver';

// Web Mercator tiles end at 85.0511 degrees, and geojson-vt clamps latitudes past it onto it.
// A view that shows latitudes past it (projected, globe) must not draw them there.

afterEach(() => vi.restoreAllMocks());

const D = Math.PI / 180;

/** Web Mercator y of a latitude, 0 at the north edge of the world and 1 at the south edge. */
const mercatorY = (lat: number) =>
  0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * D) / 2)) / (2 * Math.PI);
const mercatorX = (lng: number) => (lng + 180) / 360;

/** Where the segment from `a` to `b`, straight in Web Mercator, crosses the south edge. */
function getSouthEdgeCrossing(a: number[], b: number[]): number {
  const t = (1 - mercatorY(a[1])) / (mercatorY(b[1]) - mercatorY(a[1]));
  return mercatorX(a[0] + t * (b[0] - a[0]));
}

/** One tile unit of a z0 tile, normalized: geojson-vt rounds positions to it. */
const UNIT = 1 / 8192;

const feature = (name: string, geometry: unknown) => ({type: 'Feature', properties: {name}, geometry});

const POINTS = [
  feature('inside', {type: 'Point', coordinates: [0, -83]}),
  feature('past', {type: 'Point', coordinates: [90, -89.5]})
];
const LINE = feature('line', {type: 'LineString', coordinates: [[10, -80], [20, -89]]});
const TRIANGLE = feature('triangle', {
  type: 'Polygon',
  coordinates: [[[0, -80], [20, -80], [10, -89], [0, -80]]]
});

const source = (features: unknown[]) => ({
  type: 'geojson',
  data: {type: 'FeatureCollection', features}
});

const byName = (features: any[], name: string) =>
  features.filter(item => item.properties.name === name);

test('in a Web Mercator view a point past the limit is clamped onto it, as MapLibre GL JS draws it', async () => {
  const features = await getGeoJsonTileFeatures(source(POINTS), {x: 0, y: 0, z: 0});
  const [past] = byName(features, 'past');
  expect(past.geometry.coordinates[1]).toBe(1);
});

test('where views show latitudes past the limit, a point past it is dropped and one inside it stays in place', async () => {
  const warn = vi.spyOn(log, 'warn').mockReturnValue(() => {});
  const features = await getGeoJsonTileFeatures(
    source(POINTS),
    {x: 0, y: 0, z: 0},
    {clipToMercatorRange: true}
  );
  expect(byName(features, 'past')).toEqual([]);
  const [inside] = byName(features, 'inside');
  expect(inside.geometry.coordinates[0]).toBeCloseTo(mercatorX(0), 4);
  expect(Math.abs(inside.geometry.coordinates[1] - mercatorY(-83))).toBeLessThanOrEqual(UNIT);
  expect(warn).toHaveBeenCalledOnce();
});

test('a line that crosses the limit ends where it crosses it, not on the limit below its last vertex', async () => {
  vi.spyOn(log, 'warn').mockReturnValue(() => {});
  const [clamped] = await getGeoJsonTileFeatures(source([LINE]), {x: 0, y: 0, z: 0});
  const [clipped] = await getGeoJsonTileFeatures(
    source([LINE]),
    {x: 0, y: 0, z: 0},
    {clipToMercatorRange: true}
  );
  const crossing = getSouthEdgeCrossing([10, -80], [20, -89]);
  // geojson-vt alone draws the line on to the limit at 20 degrees east, along the limit.
  const clampedEnd = (clamped as any).geometry.coordinates.at(-1);
  expect(clampedEnd[1]).toBe(1);
  expect(Math.abs(clampedEnd[0] - mercatorX(20))).toBeLessThanOrEqual(UNIT);
  const end = (clipped as any).geometry.coordinates.at(-1);
  expect(end[1]).toBe(1);
  expect(Math.abs(end[0] - crossing)).toBeLessThanOrEqual(UNIT);
  expect(Math.abs(end[0] - mercatorX(20))).toBeGreaterThan(20 * UNIT);
});

test('a polygon that crosses the limit is cut at it', async () => {
  vi.spyOn(log, 'warn').mockReturnValue(() => {});
  const [clipped] = await getGeoJsonTileFeatures(
    source([TRIANGLE]),
    {x: 0, y: 0, z: 0},
    {clipToMercatorRange: true}
  );
  const ring: number[][] = (clipped as any).geometry.coordinates[0];
  const onEdge = ring.filter(([, y]) => y === 1).map(([x]) => x).sort((a, b) => a - b);
  // Two corners on the limit, where the sides of the triangle cross it, and none past it.
  expect([...new Set(onEdge)]).toHaveLength(2);
  expect(Math.abs(onEdge[0] - getSouthEdgeCrossing([0, -80], [10, -89]))).toBeLessThanOrEqual(UNIT);
  expect(Math.abs(onEdge.at(-1)! - getSouthEdgeCrossing([20, -80], [10, -89]))).toBeLessThanOrEqual(UNIT);
});

test('a source with features past the limit warns once', async () => {
  const warn = vi.spyOn(log, 'warn').mockReturnValue(() => {});
  const data = source([...POINTS, LINE]);
  await getGeoJsonTileFeatures(data, {x: 0, y: 0, z: 0}, {clipToMercatorRange: true});
  await getGeoJsonTileFeatures(data, {x: 0, y: 0, z: 1}, {clipToMercatorRange: true});
  expect(warn).toHaveBeenCalledOnce();
  expect(String(warn.mock.calls[0][0])).toMatch(/85\.05.*features cut in this source: 2\)/);
  // Without features past it, or in a Web Mercator view, nothing warns.
  await getGeoJsonTileFeatures(source([POINTS[0]]), {x: 0, y: 0, z: 0}, {clipToMercatorRange: true});
  await getGeoJsonTileFeatures(source(POINTS), {x: 0, y: 0, z: 0});
  expect(warn).toHaveBeenCalledOnce();
});

test('the worker task reports how many features its index dropped or cut', async () => {
  const runner = new TaskRunner();
  const task = await runner.initializeTask(GeoJsonTask, {}, {execution: 'main-thread'});
  try {
    const data = source([...POINTS, LINE, TRIANGLE]).data;
    expect(await task.runTask({type: 'index', source: 1, data, options: {}, clipToMercatorRange: true}))
      .toEqual({tile: null, outside: 3});
    expect(await task.runTask({type: 'index', source: 2, data, options: {}})).toEqual({tile: null, outside: 0});
  } finally {
    await runner.close();
  }
});

test('projected and globe basemaps cut GeoJSON at the limit; a Web Mercator one does not', async () => {
  vi.spyOn(log, 'warn').mockReturnValue(() => {});
  const style = await resolveBasemapStyle({
    version: 8,
    sources: {shapes: source(POINTS)},
    layers: [{id: 'points', type: 'circle', source: 'shapes'}]
  } as any);
  const getNames = async (options: {mode: 'map' | 'globe'; projected?: boolean}) => {
    const layers = getBasemapLayers({idPrefix: 'test', zoom: 2, styleDefinition: style, ...options});
    const layer = (layers.flat(Infinity as 1) as any[]).find(item => item?.id === 'test-shapes');
    const features = await (layer.props as any).data.opts.getTileData({index: {x: 0, y: 0, z: 0}});
    // A point near the antimeridian has a copy in the buffer: the names, once each.
    return [...new Set(features.map((item: any) => item.properties.name))].sort();
  };
  expect(await getNames({mode: 'map'})).toEqual(['inside', 'past']);
  expect(await getNames({mode: 'map', projected: true})).toEqual(['inside']);
  expect(await getNames({mode: 'globe'})).toEqual(['inside']);
});
