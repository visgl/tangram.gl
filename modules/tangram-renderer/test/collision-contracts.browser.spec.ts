// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, expectTypeOf, test, vi} from 'vitest';
import Collision from '../src/labels/collision';
import CollisionGrid from '../src/labels/collision_grid';
import type {CollisionLabel, CollisionLayout, CollisionObject} from '../src/labels/collision-types';
import RepeatGroup from '../src/labels/repeat_group';
import OBB from '../src/utils/obb';

/** Small deterministic label whose geometry and metadata survive collision unchanged. */
function createObject(priority = 0, layout: Partial<CollisionLayout> = {}) {
    // Tangram's tile/grid bounds run downward along the negative Y axis.
    const bounds = new OBB(5, -5, 0, 10, -10);
    const label: CollisionLabel = {
        layout: {priority, collide: true, repeat_scale: 1, ...layout},
        position: [5, -5], aabb: bounds.getExtent(), obb: bounds,
        discard: vi.fn(() => false)
    };
    return {label, payload: `priority-${priority}`, show: null as boolean | null};
}

afterEach(() => {
    for (const tile of Object.keys(Collision.tiles)) Collision.abortTile(tile);
    Collision.initGrid(null);
    RepeatGroup.groups = {};
    vi.restoreAllMocks();
});

describe('typed collision batching', () => {
    test('waits for every registered style and preserves per-style payload and identity', async () => {
        Collision.startTile('batch', {apply_repeat_groups: false});
        Collision.addStyle('roads', 'batch');
        Collision.addStyle('places', 'batch');
        const road = createObject(2);
        const place = {...createObject(1), rank: 42};
        const settled = vi.fn();
        const roads = Collision.collide([road], 'roads', 'batch');
        void roads.then(settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        const places = Collision.collide([place], 'places', 'batch');
        const [roadResults, placeResults] = await Promise.all([roads, places]);
        expectTypeOf(roadResults[0].payload).toEqualTypeOf<string>();
        expectTypeOf(placeResults[0].rank).toEqualTypeOf<number>();
        expect(roadResults).toEqual([road]);
        expect(roadResults[0]).toBe(road);
        expect(placeResults[0]).toBe(place);
        expect(Collision.tiles.batch).toBeUndefined();
    });

    test('sorts numeric keys rather than lexicographic keys, retaining ties in submission order', async () => {
        Collision.startTile('priorities', {apply_repeat_groups: false});
        Collision.addStyle('labels', 'priorities');
        const objects = [createObject(10), createObject(2), createObject(-1), createObject(2), createObject(0.5)];
        const results = await Collision.collide(objects, 'labels', 'priorities');
        expect(results).toEqual([objects[2], objects[4], objects[1], objects[3], objects[0]]);
    });

    test.each([false, true])('hidden results follow return_hidden=%s', async returnHidden => {
        Collision.startTile('hidden', {apply_repeat_groups: false, return_hidden: returnHidden});
        Collision.addStyle('labels', 'hidden');
        const object = createObject();
        vi.mocked(object.label.discard).mockReturnValue(true);
        expect(await Collision.collide([object], 'labels', 'hidden')).toEqual(returnHidden ? [object] : []);
        expect(object.label.placed).toBe(false);
        expect(object.show).toBe(returnHidden ? false : null);
    });

    test('abort releases pending contributors and later submissions resolve empty', async () => {
        Collision.startTile('abort');
        Collision.addStyle('waiting', 'abort');
        Collision.addStyle('late', 'abort');
        const pending = Collision.collide([createObject()], 'waiting', 'abort');
        Collision.abortTile('abort');
        await expect(pending).resolves.toEqual([]);
        await expect(Collision.collide([createObject()], 'late', 'abort')).resolves.toEqual([]);
        Collision.abortTile('absent');
        expect(Collision.tiles.abort).toBeUndefined();
    });

    test('empty submissions still complete an empty tile', async () => {
        Collision.startTile('empty');
        Collision.addStyle('labels', 'empty');
        await expect(Collision.collide([], 'labels', 'empty')).resolves.toEqual([]);
        expect(Collision.tiles.empty).toBeUndefined();
    });
});

describe('typed collision placement', () => {
    test('linked labels share exclusion, breach/repeat flags, and placed state', async () => {
        Collision.startTile('linked', {apply_repeat_groups: false});
        Collision.addStyle('labels', 'linked');
        const parent = createObject();
        const child: CollisionObject = {...createObject(), linked: parent};
        child.label.breach = true;
        parent.label.may_repeat_across_tiles = true;
        expect(await Collision.collide([child], 'labels', 'linked')).toEqual([child]);
        expect(parent.label.discard).toHaveBeenCalledWith(expect.anything(), child.label);
        expect(child.label.discard).toHaveBeenCalledWith(expect.anything(), parent.label);
        expect(child.label.placed).toBe(true);
        expect(parent.label.placed).toBe(true);
        expect(parent.label.breach).toBe(true);
        expect(child.label.may_repeat_across_tiles).toBe(true);
    });

    test('a rejected dependency hides its child rather than placing either label', async () => {
        Collision.startTile('dependent', {apply_repeat_groups: false, return_hidden: true});
        Collision.addStyle('labels', 'dependent');
        const parent = createObject();
        vi.mocked(parent.label.discard).mockReturnValue(true);
        const child: CollisionObject = {...createObject(), linked: parent};
        expect(await Collision.collide([child], 'labels', 'dependent')).toEqual([child]);
        expect(child.show).toBe(false);
        expect(child.label.placed).toBeUndefined();
        expect(parent.label.placed).toBe(false);
    });

    test('repeat culling stays tile-local and can be disabled independently of collision', async () => {
        for (const [tile, repeat] of [['enabled', true], ['disabled', false]] as const) {
            Collision.startTile(tile, {apply_repeat_groups: repeat, return_hidden: true});
            Collision.addStyle('labels', tile);
            const first = createObject(0, {repeat_group: 'same', repeat_distance: 20});
            const second = createObject(1, {repeat_group: 'same', repeat_distance: 20});
            await Collision.collide([first, second], 'labels', tile);
            expect(first.show).toBe(true);
            expect(second.show).toBe(!repeat);
        }
    });

    test('non-colliding labels skip discard, and processed labels are not placed twice', async () => {
        Collision.startTile('placed', {apply_repeat_groups: false});
        const object = createObject(0, {collide: false});
        vi.mocked(object.label.discard).mockReturnValue(true);
        expect(Collision.canBePlaced(object, 'placed', null, {repeat: false})).toBe(true);
        Collision.place(object, 'placed', {repeat: false});
        Collision.place(object, 'placed', {repeat: false});
        expect(object.label.discard).not.toHaveBeenCalled();
        expect(Collision.tiles.placed?.bboxes.aabb).toEqual([object.label.aabb]);
        expect(Collision.canBePlaced(object, 'placed')).toBe(true);
        object.label.placed = false;
        expect(Collision.canBePlaced(object, 'placed')).toBe(false);
    });

    test('grid cells share typed bounds and rejection in any occupied cell stops placement', async () => {
        Collision.initGrid({anchor: {x: 0, y: 0}, span: 5});
        Collision.startTile('grid', {apply_repeat_groups: false, return_hidden: true});
        Collision.addStyle('labels', 'grid');
        const object = createObject();
        vi.mocked(object.label.discard).mockReturnValueOnce(false).mockReturnValueOnce(true);
        await Collision.collide([object], 'labels', 'grid');
        expect(object.label.cells).toHaveLength(9);
        expect(object.label.discard).toHaveBeenCalledTimes(2);
        expect(object.show).toBe(false);
    });

    test('grid initialization handles null bounds, curved bounds, and negative cell coordinates', () => {
        const grid = new CollisionGrid({x: 0, y: 0}, 10);
        const object = createObject();
        object.label.aabb = null;
        object.label.aabbs = [[-5, 5, 5, -5], [20, -20, 25, -25]];
        grid.addLabel(object.label);
        expect(grid.cells[0][0]).toEqual({aabb: [], obb: []});
        expect(grid.cells[2][2]).toEqual({aabb: [], obb: []});
        expect(object.label.cells).toEqual([grid.cells[2][2]]);
    });
});
