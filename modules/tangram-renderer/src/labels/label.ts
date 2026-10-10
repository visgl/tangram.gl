// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import type {CollisionBounds, CollisionLabel} from './collision-types';
import type {LabelLayout, LabelPointCoordinate, SerializedLabel} from './label-types';
import PointAnchor from './point_anchor';
import {boxIntersectsList} from './intersect';
import OBB from '../utils/obb';
import Geo from '../utils/geo';
// import log from '../utils/log';

export default class Label {

    static epsilon: number;
    static nextLabelId: () => number;
    static add: (label: CollisionLabel, bboxes: CollisionBounds) => void;
    static id: number;
    static id_prefix: number;
    static id_multiplier: number;
    id: number;
    type: string;
    /** Unscaled width and height in pixels. */
    size: LabelPointCoordinate;
    /** Normalized collision and positioning rules supplied by a style. */
    layout: LabelLayout;
    /** Tile-local position, installed by a concrete label after base construction. */
    position: LabelPointCoordinate | null;
    /** Rotation in radians. */
    angle: number;
    /** Current candidate anchor, possibly changed by point collision retries. */
    anchor: string | undefined;
    /** Collision outcome; null means not processed. */
    placed: boolean | null;
    /** Pixel offset before scaling into tile coordinates. */
    offset: LabelPointCoordinate;
    /** Tile units per pixel. */
    unit_scale: number;
    /** Broad-phase extent, absent until bounds are constructed. */
    aabb: number[] | null;
    /** Corresponding oriented collision box. */
    obb: OBB | null;
    /** Optional broad-phase extents for segmented geometry. */
    aabbs: number[][] | undefined;
    /** Oriented boxes corresponding to segmented extents. */
    obbs: OBB[] | undefined;
    /** Canvas text alignment derived from the anchor or explicit layout. */
    align: string;
    /** Whether geometry fitting rejected the label. */
    throw_away: boolean;
    /** Whether bounds cross a tile edge. */
    breach?: boolean;
    /** Whether a second repeat-distance pass is needed across tiles. */
    may_repeat_across_tiles?: boolean;

    /** Concrete labels supply normalized layouts; the legacy empty base default remains supported. */
    constructor (size: LabelPointCoordinate, layout: LabelLayout = {} as LabelLayout) {
        this.id = Label.nextLabelId();
        this.type = ''; // set by subclass
        this.size = size;
        this.layout = layout;
        this.position = null;
        this.angle = 0;
        this.anchor = Array.isArray(this.layout.anchor) ? this.layout.anchor[0] : this.layout.anchor; // initial anchor
        this.placed = null;
        this.offset = layout.offset;
        this.unit_scale = this.layout.units_per_pixel;
        this.aabb = null;
        this.obb = null;
        this.align = 'center';
        this.throw_away = false;    // if label does not fit (exceeds tile boundary, etc) this boolean will be true
    }

    // Minimal representation of label
    toJSON (): SerializedLabel {
        return {
            id: this.id,
            type: this.type,
            obb: this.obb!.toJSON(),
            position: this.position!,
            angle: this.angle,
            size: this.size,
            offset: this.offset,
            breach: this.breach,
            may_repeat_across_tiles: this.may_repeat_across_tiles,
            layout: textLayoutToJSON(this.layout)
        };
    }

    update () {
        this.align = this.layout.align || PointAnchor.alignForAnchor(this.anchor);
    }

    // check for overlaps with other labels in the tile
    occluded (this: {aabb: number[] | null; obb: OBB | null}, bboxes: CollisionBounds, exclude: CollisionLabel | null | 0 | '' = null): boolean {
        let intersect = false;
        let aabbs = bboxes.aabb;
        let obbs = bboxes.obb;

        // Broad phase
        if (aabbs.length > 0) {
            boxIntersectsList(this.aabb! as [number, number, number, number], aabbs as [number, number, number, number][], (j) => {
                // log('trace', 'collision: broad phase collide', this.layout.id, this, this.aabb, aabbs[j]);

                // Skip if colliding with excluded label
                if (exclude && aabbs[j] === exclude.aabb) {
                    // log('trace', 'collision: skipping due to explicit exclusion', this, exclude);
                    return;
                }

                // Skip narrow phase collision if no rotation
                if (this.obb!.angle === 0 && obbs[j].angle === 0) {
                    // log('trace', 'collision: skip narrow phase collide because neither is rotated', this.layout.id, this, this.obb, obbs[j]);
                    intersect = true;
                    return true;
                }

                // Narrow phase
                if (OBB.intersect(this.obb!, obbs[j])) {
                    // log('trace', 'collision: narrow phase collide', this.layout.id, this, this.obb, obbs[j]);
                    intersect = true;
                    return true;
                }
            });
        }
        return intersect;
    }

    // checks whether the label is within the tile boundaries
    inTileBounds (this: {aabb: number[] | null}): boolean {
        if ((this.aabb![0] >= 0 && this.aabb![1] > -Geo.tile_scale && this.aabb![0] < Geo.tile_scale && this.aabb![1] <= 0) ||
            (this.aabb![2] >= 0 && this.aabb![3] > -Geo.tile_scale && this.aabb![2] < Geo.tile_scale && this.aabb![3] <= 0)) {
            return true;
        }
        return false;
    }

    // some labels need further repeat culling checks on the main thread
    // checks whether the label is within its repeat distance of the tile boundaries
    mayRepeatAcrossTiles () {
        if (this.layout.collide) {
            return true; // additional collision pass will already apply, so skip further distance checks
        }

        const dist = this.layout.repeat_distance!;
        if (dist === 0) {
            return false;
        }

        return (Math.abs(this.position![0]) < dist ||  Math.abs(this.position![0] - Geo.tile_scale) < dist) ||
               (Math.abs(this.position![1]) < dist ||  Math.abs(-(this.position![1] - Geo.tile_scale)) < dist);
    }

    // Whether the label should be discarded
    // Depends on whether label must fit in the tile bounds, and if so, can it be moved to fit there
    discard(bboxes: CollisionBounds, exclude: CollisionLabel | null | 0 | '' = null): boolean {
        if (this.throw_away) {
            return true;
        }
        return this.occluded(bboxes, exclude);
    }
}

// Generic label placement function, adds a label's bounding boxes to the currently placed set
//  Supports single or multiple collision boxes
Label.add = function (label, bboxes) {
    label.placed = true;

    if (label.aabb) {
        bboxes.aabb.push(label.aabb);
        bboxes.obb.push(label.obb!);
    }

    if (label.aabbs) {
        for (let i = 0; i < label.aabbs.length; i++) {
            bboxes.aabb.push(label.aabbs[i]);
            bboxes.obb.push(label.obbs![i]);
        }
    }
};

Label.id = 0;
Label.id_prefix = 0; // id prefix scoped to worker thread
Label.id_multiplier = 0; // multiplier to keep label ids distinct across threads

Label.nextLabelId = function () {
    return Label.id_prefix + ((Label.id++) * Label.id_multiplier);
};

Label.epsilon = 0.9999; // tolerance around collision boxes, prevent perfectly adjacent objects from colliding

// Minimal representation of text layout, sent to main thread for label collisions
export function textLayoutToJSON (layout: LabelLayout): SerializedLabel['layout'] {
    return {
        priority: layout.priority,
        ...(layout.projected_collide === undefined ? {} : {projected_collide: layout.projected_collide}),
        ...(layout.projected_identity === undefined ? {} : {projected_identity: layout.projected_identity}),
        ...(layout.projected_height === undefined ? {} : {projected_height: layout.projected_height}),
        collide: layout.collide,
        repeat_distance: layout.projected_collide === undefined ? layout.repeat_distance :
            (layout.repeat_distance ?? 0) / layout.units_per_pixel,
        repeat_group: layout.repeat_group,
        buffer: layout.buffer,
        italic: layout.italic // affects bounding box size
    };
}
