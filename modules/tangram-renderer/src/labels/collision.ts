// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import Label from './label';
import RepeatGroup from './repeat_group';
import CollisionGrid from './collision_grid';
import log from '../utils/log';
import type {CollisionObject, CollisionTileState} from './collision-types';

const Collision = {

    /** Started tile batches, removed after completion or abort. */
    tiles: {} as Partial<Record<string, CollisionTileState>>,
    /** Optional spatial index; null uses each tile's placed bounds. */
    grid: null as CollisionGrid | null, // no collision grid by default

    /** Select grid-based or tile-wide collision testing. */
    initGrid (options?: {anchor: {x: number; y: number}; span: number} | null): void {
        if (options == null) {
            this.grid = null;
        }
        else {
            this.grid = new CollisionGrid(options.anchor, options.span);
        }
    },

    /** Initialize a batch before registering/submitting its contributing styles. */
    startTile (tile: string, { apply_repeat_groups = true, return_hidden = false }: {
        apply_repeat_groups?: boolean; return_hidden?: boolean
    } = {}): void {
        let state: CollisionTileState = this.tiles[tile] = {
            bboxes: {           // current set of placed bounding boxes
                aabb: [],
                obb: []
            },
            objects: {},        // objects to collide, grouped by priority, then by style
            labels: {},         // objects post-collision, grouped by style, marked as show/hide
            styles: {},         // styles contributing collision objects
            repeat: apply_repeat_groups,
            return_hidden
        };

        // Promise resolved when all registered styles have added objects
        if (state.complete == null) {
            state.complete = new Promise<void | CollisionObject[]>((resolve, reject) => {
                state.resolve = resolve;
                state.reject = reject;
            });
        }
    },

    /** Drop all collision state for a completed or abandoned tile. */
    resetTile (tile: string): void {
        delete this.tiles[tile];
    },

    /** Resolve pending consumers before removing an abandoned batch. */
    abortTile (tile: string): void {
        if (this.tiles[tile] && this.tiles[tile].resolve) {
            this.tiles[tile].resolve([]);
        }
        this.resetTile(tile);
    },

    // Add a style to the pending set, collision will block on all styles submitting to collision set
    /** Register a contributor on an already-started tile. */
    addStyle (style: string, tile: string): void {
        this.tiles[tile]!.styles[style] = true;
    },

    // Add collision objects for a style
    /** Submit one style and return the same containers, retaining their payload types. */
    collide<T extends CollisionObject> (objects: readonly T[], style: string, tile: string): Promise<T[]> {
        let state = this.tiles[tile];
        if (!state) {
            log('trace', 'Collision.collide() called with null tile', tile, this.tiles, style, objects);
            return Promise.resolve([]);
        }

        // Group by priority and style
        let tile_objects = state.objects;
        for (let i=0; i < objects.length; i++) {
            let obj = objects[i];
            let priority = obj.label.layout.priority;
            tile_objects[priority] = tile_objects[priority] || {};
            tile_objects[priority][style] = tile_objects[priority][style] || [];
            tile_objects[priority][style].push(obj);
        }

        // Remove from pending style set, if no more styles, do collision & finish tile
        delete state.styles[style];
        if (Object.keys(state.styles).length === 0) {
            this.endTile(tile);
        }

        // Wait for objects to be added from all styles
        return state.complete!.then(() => {
            state.resolve = null;
            // Each style's result contains only containers submitted by that style.
            return state.labels[style] as T[] || [];
        });
    },

    // Test labels for collisions, higher to lower priority
    // When two collide, hide the lower-priority label
    /** Resolve an already-started batch in priority/style submission order. */
    endTile (tile: string): void {
        let state = this.tiles[tile]!;
        let labels = state.labels;

        if (this.grid) {
            this.addLabelsToGrid(tile);
        }

        if (state.repeat) {
            RepeatGroup.clear(tile);
        }

        // Process labels by priority, then by style
        let priorities = Object.keys(state.objects).sort((a, b) => Number(a) - Number(b));
        for (let p=0; p < priorities.length; p++) {
            let style_objects = state.objects[priorities[p]];
            if (!style_objects) { // no labels at this priority, skip to next
                continue;
            }

            // For each style
            for (let style in style_objects) {
                let objects = style_objects[style];
                labels[style] = labels[style] || [];

                for (let i = 0; i < objects.length; i++) {
                    let object = objects[i];
                    if (this.canBePlaced(object, tile, object.linked, state)) {
                        // show object if it isn't dependent on a parent object
                        if (!object.linked) {
                            object.show = true;
                            labels[style].push(object);
                            this.place(object, tile, state);
                        }
                        // If object is dependent on a parent, only show if both can be placed
                        else if (this.canBePlaced(object.linked, tile, object, state)) {
                            object.show = true;

                            // If a label is breach, its linked label should be considered breach as well
                            // (this keeps linked labels (in)visible in tandem)
                            if (object.label.breach || object.linked.label.breach) {
                                object.label.breach = true;
                                object.linked.label.breach = true;
                            }

                            // Similarly for labels that need main thread repeat culling, keep linked labels in sync
                            if (object.label.may_repeat_across_tiles || object.linked.label.may_repeat_across_tiles) {
                                object.label.may_repeat_across_tiles = true;
                                object.linked.label.may_repeat_across_tiles = true;
                            }

                            labels[style].push(object);
                            this.place(object, tile, state);
                            this.place(object.linked, tile, state);
                        }
                        else if (state.return_hidden) {
                            object.show = false;
                            labels[style].push(object);
                        }
                    }
                    else if (state.return_hidden) {
                        object.show = false;
                        labels[style].push(object);
                    }
                }
            }
        }

        delete this.tiles[tile];
        state.resolve!();
    },

    /** Index candidates after grid initialization and before placement starts. */
    addLabelsToGrid (tile_id: string): void {
        // Process labels by priority, then by style
        const tile = this.tiles[tile_id]!;
        for (const priority in tile.objects) {
            const style_objects = tile.objects[priority];
            if (!style_objects) { // no labels at this priority, skip to next
                continue;
            }

            // For each style
            for (const style in style_objects) {
                const objects = style_objects[style];
                objects.forEach(object => this.grid!.addLabel(object.label));
            }
        }
    },

    // Run collision and repeat check to see if label can currently be placed
    /** Check a candidate, preserving previously resolved placement outcomes. */
    canBePlaced (object: CollisionObject, tile: string, exclude: CollisionObject | null = null, { repeat = true }: {repeat?: boolean} = {}): boolean | null | undefined {
        let label = object.label;
        let layout = object.label.layout;

        // Skip if already processed (e.g. by parent object)
        if (label.placed != null) {
            return label.placed;
        }

        let placeable = !layout.collide;
        if (!placeable) {
            // Test the label for intersections with other labels
            if (this.grid && label.cells) {
                // test label candidate against labels placed in each grid cell
                placeable = label.cells.reduce((keep, cell) => {
                    if (keep && label.discard(cell, exclude && exclude.label)) {
                        keep = false;
                    }
                    return keep;
                }, true);
            }
            else {
                placeable = !label.discard(this.tiles[tile]!.bboxes, exclude && exclude.label);
            }
        }

        if (placeable) {
            // repeat culling with nearby labels
            if (repeat && RepeatGroup.check(label, layout, tile)) {
                label.placed = false;
            }
            else {
                return true;
            }
        }
        else if (layout.collide) {
            // log('trace', `hide label '${label.text}' due to collision`);
            label.placed = false;
        }
        return label.placed;
    },

    // Place label
    /** Register a candidate once, after its dependency and repeat checks succeed. */
    place ({ label }: CollisionObject, tile: string, { repeat = true }: {repeat?: boolean}): void {
        // Skip if already processed (e.g. by parent object)
        if (label.placed != null) {
            return;
        }

        // Register as placed for future collision and repeat culling
        if (repeat) {
            RepeatGroup.add(label, label.layout, tile);
        }

        if (this.grid && label.cells) {
            label.cells.forEach(cell => Label.add(label, cell));
        }
        else {
            Label.add(label, this.tiles[tile]!.bboxes);
        }
    }

};

export default Collision;
