// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type OBB from '../utils/obb';

/** Parallel broad/narrow-phase bounds for labels already placed in a tile or grid cell. */
export interface CollisionBounds {
    /** Axis-aligned boxes in placement order. */
    aabb: number[][];
    /** Oriented boxes corresponding to the axis-aligned boxes. */
    obb: OBB[];
}

/** Layout controls consumed by collision and repeat culling, independent of rendering styles. */
export interface CollisionLayout {
    /** Lower numeric values are considered first. */
    priority: number;
    /** Whether placed-label intersections can reject this label. */
    collide?: boolean;
    /** Minimum separation within a repeat group. */
    repeat_distance?: number;
    /** Optional repeat group identifier. */
    repeat_group?: string;
    /** Worker/main-pass distance scale, provided by layout normalization. */
    repeat_scale: number;
}

/** Minimal mutable label contract shared by worker and main-pass collision. */
export interface CollisionLabel {
    /** Collision and repeat rules. */
    layout: CollisionLayout;
    /** Position used by repeat culling. */
    position: [number, number];
    /** Single-box broad-phase extent, or null before bounds are built. */
    aabb?: number[] | null;
    /** Multi-box broad-phase extents. */
    aabbs?: number[][];
    /** Single-box narrow-phase bounds. */
    obb?: OBB | null;
    /** Multi-box narrow-phase bounds. */
    obbs?: OBB[];
    /** Placement outcome; null/undefined means not processed yet. */
    placed?: boolean | null;
    /** Grid cells containing this candidate. */
    cells?: CollisionBounds[];
    /** Whether this label crosses a tile boundary. */
    breach?: boolean;
    /** Whether main-pass repeat culling is still required. */
    may_repeat_across_tiles?: boolean;
    /** Test placed bounds while ignoring an explicitly linked label. */
    discard(bounds: CollisionBounds, exclude: CollisionLabel | null): boolean;
}

/** Placement container; callers can retain additional renderer-specific payload. */
export interface CollisionObject {
    /** Mutable candidate label. */
    label: CollisionLabel;
    /** Optional placement dependency, considered as a pair. */
    linked?: CollisionObject | null;
    /** Visibility assigned by the collision pass. */
    show?: boolean | null;
}

/** Per-tile batching and resolution state. */
export interface CollisionTileState {
    /** Accumulated placed bounds when no grid is used. */
    bboxes: CollisionBounds;
    /** Submitted objects grouped first by numeric priority, then by style. */
    objects: Record<string, Record<string, CollisionObject[]>>;
    /** Resolved visible/hidden objects grouped by style. */
    labels: Record<string, CollisionObject[]>;
    /** Styles that have not yet submitted their objects. */
    styles: Record<string, boolean>;
    /** Whether repeat culling is enabled for this tile. */
    repeat: boolean;
    /** Whether rejected objects are returned as hidden. */
    return_hidden: boolean;
    /** Completion barrier initialized by startTile before any submissions. */
    complete?: Promise<void | CollisionObject[]>;
    /** Complete normally or abort with an empty result. */
    resolve?: ((result?: CollisionObject[]) => void) | null;
    /** Rejection hook retained for compatibility with the existing state. */
    reject?: (reason?: unknown) => void;
}
