// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test} from 'vitest';
import {build} from 'esbuild';
import {resolveLabelPlacement, areGeographicLabelCopies, intersectsScreenBounds, unionScreenBounds,
    getScreenBoundsCells} from '../src/map-logic/index';
import type {ScreenLabelCandidate, ScreenBounds, GeographicLabelAnchor} from '../src/map-logic/index';

const viewports = new Map([['left', {width: 256, height: 128}], ['right', {width: 256, height: 128}]]);

/** Immutable input independent of worker labels, tiles, fonts or graphics resources. */
function candidate(id: string, boxes: [string, ScreenBounds][] = [['left', [0, 0, 20, 20]]],
    options: Omit<Partial<ScreenLabelCandidate>, 'id' | 'boxes'> = {}): ScreenLabelCandidate {
    return Object.freeze({id, ...options, boxes: new Map(boxes.map(([view, bounds]) =>
        [view, Object.freeze([bounds[0], bounds[1], bounds[2], bounds[3]] as const)]))});
}

test('screen rectangles preserve strict edge contact and union without modifying inputs', () => {
    const first = Object.freeze([0, 0, 20, 20] as const);
    expect(intersectsScreenBounds(first, [20, 0, 40, 20])).toBe(false);
    expect(intersectsScreenBounds(first, [19, 0, 40, 20])).toBe(true);
    expect(intersectsScreenBounds(first, [0, 20, 20, 40])).toBe(false);
    expect(unionScreenBounds(undefined, first)).toBe(first);
    expect(unionScreenBounds(first, [-5, -3, 30, 40])).toEqual([-5, -3, 30, 40]);
    expect(first).toEqual([0, 0, 20, 20]);
    expect([...getScreenBoundsCells([-10000, -10000, 10000, 10000], {width: 64, height: 64})]).toEqual(['0,0', '0,1', '1,0', '1,1']);
    expect([...getScreenBoundsCells([300, 0, 320, 20], {width: 256, height: 128})]).toEqual(['4,0']);
    expect([...getScreenBoundsCells([384, 0, 400, 20], {width: 256, height: 128})]).toEqual([]);
});

test('caller priority order resolves touching, overlapping, empty and non-colliding candidates', () => {
    const first = candidate('first');
    const overlap = candidate('overlap');
    const touching = candidate('touching', [['left', [20, 0, 40, 20]]]);
    const allowed = candidate('allowed', undefined, {collide: false});
    const empty = candidate('empty', []);
    const result = resolveLabelPlacement([first, overlap, touching, allowed, empty], {viewports});
    expect([...result.values()]).toEqual([true, false, true, true, false]);
    expect(resolveLabelPlacement([overlap, first], {viewports}).get(overlap)).toBe(true);
    expect(first).not.toHaveProperty('shown');
    expect(resolveLabelPlacement([first], {viewports}).get(first)).toBe(true);
    expect(resolveLabelPlacement([], {viewports}).size).toBe(0);
});

test('accepted, rejected and linked candidates retain all input bounds and map entries', () => {
    const accepted = candidate('accepted');
    const rejected = candidate('rejected');
    const parent = candidate('parent', [['left', [80, 0, 100, 20]], ['right', [80, 0, 100, 20]]]);
    const child = candidate('child', [['left', [85, 0, 105, 20]], ['right', [85, 0, 105, 20]]], {linkedId: 'parent'});
    const empty = candidate('empty', []);
    const candidates = [accepted, rejected, child, parent, empty];
    const originalMaps = candidates.map(candidate => candidate.boxes);
    const originalEntries = candidates.map(candidate => [...candidate.boxes].map(([view, bounds]) => [view, [...bounds]]));
    const originalBounds = candidates.map(candidate => [...candidate.boxes.values()]);
    const result = resolveLabelPlacement(candidates, {viewports});
    expect(candidates.map(candidate => result.get(candidate))).toEqual([true, false, true, true, false]);
    candidates.forEach((candidate, index) => {
        expect(candidate.boxes).toBe(originalMaps[index]);
        expect([...candidate.boxes]).toEqual(originalEntries[index]);
        expect(candidate).not.toHaveProperty('shown');
        [...candidate.boxes.values()].forEach((bounds, boundIndex) => {
            expect(bounds).toBe(originalBounds[index][boundIndex]);
            expect(Object.isFrozen(bounds)).toBe(true);
        });
    });
});

test('one shared mask rejects overlap in either stereo view but not unrelated views', () => {
    const first = candidate('first', [['left', [0, 0, 20, 20]], ['right', [0, 0, 20, 20]]]);
    const second = candidate('second', [['left', [80, 0, 100, 20]], ['right', [10, 0, 30, 20]]]);
    expect(resolveLabelPlacement([first, second], {viewports}).get(second)).toBe(false);
    const isolated = candidate('isolated', [['right', [0, 0, 20, 20]]]);
    expect(resolveLabelPlacement([candidate('left-only'), isolated], {viewports}).get(isolated)).toBe(true);
    expect(() => resolveLabelPlacement([candidate('missing', [['other', [0, 0, 20, 20]]])], {viewports})).toThrow('Missing label viewport');
});

test('repeat spacing is independent of collision and compares shared view centers with a strict threshold', () => {
    const options = {collide: false, repeatGroup: 'name', repeatDistance: 32};
    const first = candidate('first', undefined, options);
    const near = candidate('near', [['left', [30, 0, 50, 20]]], options);
    const edge = candidate('edge', [['left', [32, 0, 52, 20]]], options);
    const separateView = candidate('separate', [['right', [0, 0, 20, 20]]], options);
    const separateGroup = candidate('group', undefined, {...options, repeatGroup: 'other'});
    const noSpacing = candidate('no-spacing', undefined, {...options, repeatDistance: 0});
    expect([...resolveLabelPlacement([first, near, edge, separateView, separateGroup, noSpacing], {viewports}).values()])
        .toEqual([true, false, true, true, true, true]);
});

test('identity policy is optional and only compares candidates within a nonempty matching identity', () => {
    const first = candidate('first', undefined, {identity: 'city', collide: false});
    const second = candidate('second', undefined, {identity: 'city', collide: false});
    const other = candidate('other', undefined, {identity: 'road', collide: false});
    expect(resolveLabelPlacement([first, second], {viewports}).get(second)).toBe(true);
    const result = resolveLabelPlacement([first, second, other], {viewports, isDuplicate: () => true});
    expect([...result.values()]).toEqual([true, false, true]);
});

test('optional children resolve parents first and may overlap them, but inherit a failed dependency', () => {
    const parent = candidate('parent');
    const child = candidate('child', undefined, {linkedId: 'parent'});
    expect([...resolveLabelPlacement([child, parent], {viewports}).values()]).toEqual([true, true]);
    const blocker = candidate('blocker');
    const blocked = resolveLabelPlacement([blocker, child, parent], {viewports});
    expect(blocked.get(child)).toBe(false);
    expect(blocked.get(parent)).toBe(false);
    expect(resolveLabelPlacement([candidate('missing-parent', undefined, {linkedId: 'absent'})], {viewports}).size).toBe(1);
    // Unlinked candidates do not implicitly depend on an empty-string ID.
    const blank = candidate('', []);
    expect(resolveLabelPlacement([blank, parent], {viewports}).get(parent)).toBe(true);
});

test('reciprocal links place atomically and longer dependency cycles fail without recursion overflow', () => {
    const marker = candidate('marker', undefined, {linkedId: 'text'});
    const text = candidate('text', [['left', [30, 0, 50, 20]]], {linkedId: 'marker'});
    expect([...resolveLabelPlacement([marker, text], {viewports}).values()]).toEqual([true, true]);
    const blocker = candidate('blocker', [['left', [30, 0, 50, 20]]]);
    const blocked = resolveLabelPlacement([blocker, marker, text], {viewports});
    expect(blocked.get(marker)).toBe(false);
    expect(blocked.get(text)).toBe(false);
    const cycle = ['one', 'two', 'three'].map((id, index, names) => candidate(id, undefined, {linkedId: names[(index + 1) % names.length]}));
    expect([...resolveLabelPlacement(cycle, {viewports}).values()]).toEqual([false, false, false]);
});

test('geographic copies require identity, tile separation, source-resolution proximity and equal elevation', () => {
    const first: GeographicLabelAnchor = {identity: 'city', sourceTileIdentity: 'tile-1', sourceZoom: 0, anchor: [0, 0], height: 0};
    const other = {...first, sourceTileIdentity: 'tile-2'};
    const options = {worldWidth: 4096, wrapHorizontal: false};
    expect(areGeographicLabelCopies(first, other, options)).toBe(true);
    for (const changed of [{identity: undefined}, {identity: 'other'}, {sourceTileIdentity: first.sourceTileIdentity}, {height: 1}, {anchor: [3, 0] as const}]) {
        expect(areGeographicLabelCopies(first, {...other, ...changed}, options)).toBe(false);
    }
    expect(areGeographicLabelCopies(first, {...other, anchor: [2, 0]}, options)).toBe(true);
    expect(areGeographicLabelCopies({...first, sourceZoom: 10}, {...other, sourceZoom: 10, anchor: [0.01, 0]}, options)).toBe(false);
    expect(areGeographicLabelCopies(first, {...other, anchor: [4096, 0]}, options)).toBe(false);
    expect(areGeographicLabelCopies(first, {...other, anchor: [4096, 0]}, {...options, wrapHorizontal: true})).toBe(true);
});

test('optional map-logic entry bundles without renderer, DOM, GPU or third-party imports', async () => {
    const result = await build({entryPoints: ['modules/tangram-renderer/src/map-logic/index.ts'],
        bundle: true, format: 'esm', platform: 'neutral', write: false, metafile: true});
    expect(Object.keys(result.metafile.inputs)).toHaveLength(7);
    expect(Object.keys(result.metafile.inputs).every(path => path.includes('/src/map-logic/'))).toBe(true);
    expect(Object.values(result.metafile.outputs).flatMap(output => output.imports)).toEqual([]);
});
