// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {CollisionLayout} from './collision-types';
import type OBB from '../utils/obb';

/** Mutable pixel or tile-coordinate pair. */
export type LabelPointCoordinate = [number, number];

/** Normalized layout supplied by point/text styles before label construction. */
export interface LabelLayout extends CollisionLayout {
    /** Screen-space collision policy deferred until projected cameras are known. */
    projected_collide?: boolean;
    /** Source/style/feature identity for buffered copies, absent for anonymous points. */
    projected_identity?: string;
    /** Quantized physical anchor height in meters; omitted for nonprojected labels. */
    projected_height?: number;
    /** Pixel offset before geographic scaling. */
    offset: LabelPointCoordinate;
    /** Collision padding in pixels. */
    buffer: LabelPointCoordinate;
    /** Tile units per screen pixel. */
    units_per_pixel: number;
    /** Candidate point anchors, tried in order. */
    anchor?: string | string[];
    /** Canvas text alignment override. */
    align?: string;
    /** Extra collision width for non-normal fonts. */
    italic?: boolean;
    /** Point label carrying an attached text label. */
    parent?: LabelParent;
    /** Maximum line-placement subdivisions. */
    subdiv: number;
    /** Raster padding excluded from oriented offsets. */
    vertical_buffer: number;
    /** Whether contextual shaping requires straight placement. */
    no_curving?: boolean;
    /** Side of a boundary line: left (-1) or right (1). */
    orientation?: number;
    /** Point-placement strategy identifier. */
    placement?: number;
    /** Minimum segment length relative to label size. */
    placement_min_length_ratio: number;
    /** Requested spacing along a line in pixels. */
    placement_spacing?: number;
    /** Whether points may be placed outside tile bounds. */
    tile_edges?: boolean;
    /** Fixed point rotation or automatic line rotation. */
    angle?: number | 'auto';
    /** Whether this layout uses vertex placement. */
    vertex?: boolean;
    /** Optional feature identity retained for debugging. */
    id?: unknown;
}

/** Point geometry used to anchor attached text. */
export interface LabelParent {
    /** Parent's unscaled dimensions. */
    size: LabelPointCoordinate;
    /** Parent's point anchor. */
    anchor?: string;
    /** Parent's pixel offset. */
    offset: LabelPointCoordinate;
}

/** Geometry serialized across the worker/main-thread collision boundary. */
export interface SerializedLabel {
    /** Worker-scoped label identity. */
    id: number;
    /** Point, straight, or curved placement kind. */
    type: string;
    /** Original tile-local position. */
    position: LabelPointCoordinate;
    /** Minimal repeat/collision settings. */
    layout: Pick<LabelLayout, 'priority' | 'collide' | 'repeat_distance' | 'repeat_group' | 'buffer' | 'italic' | 'projected_collide' | 'projected_identity' | 'projected_height'>;
    /** Point/straight dimensions, absent for articulated text. */
    size?: LabelPointCoordinate;
    /** Rotation for point/straight placement. */
    angle?: number;
    /** Pixel offset for point/straight placement. */
    offset?: LabelPointCoordinate;
    /** Point-oriented box snapshot. */
    obb?: ReturnType<OBB['toJSON']>;
    /** Curved per-segment box snapshots. */
    obbs?: ReturnType<OBB['toJSON']>[];
    /** Whether this label crosses the tile boundary. */
    breach?: boolean;
    /** Whether repeat culling must run again on the main thread. */
    may_repeat_across_tiles?: boolean;
}
