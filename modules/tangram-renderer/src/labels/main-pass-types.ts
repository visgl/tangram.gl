// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {CollisionLabel, CollisionObject} from './collision-types';
import type {LabelPointCoordinate, SerializedLabel} from './label-types';
import type OBB from '../utils/obb';

/** Serialized label container attached to a worker-built mesh. */
export interface MeshLabel {
    container: {label: SerializedLabel; linked?: number | string | null};
    /** Byte offset and vertex count for each label geometry range. */
    ranges: [number, number][];
}

/** Mutable GPU-mesh surface consumed by the visibility pass. */
export interface LabelMesh {
    valid: boolean;
    labels?: Record<string, MeshLabel>;
    vertex_layout: {offset: Record<string, number>; stride: number};
    vertex_data: Uint8Array;
    upload(): void;
}

/** Current/proxy tile metadata needed for cross-tile collisions. */
export interface LabelTile {
    coords: {z: number};
    style_z: number;
    build_id: number;
    min: {x: number; y: number};
    span: {x: number};
    meshes: Record<string, LabelMesh[]>;
    pending_label_meshes: Record<string, LabelMesh[]> | null;
    isProxy(): boolean;
    /** Whether a proxy style still draws while a child finishes its label meshes. */
    shouldProxyForStyle?(style: string): boolean;
    swapPendingLabels(): void;
}

/** Main-pass reconstruction: screen-scaled boxes without alternate-anchor fitting. */
export interface MainPassLabel extends CollisionLabel {
    id: number;
    type: string;
    layout: SerializedLabel['layout'] & {repeat_scale: number};
    build_id: number;
    unit_scale: number;
    size: LabelPointCoordinate;
    offset: LabelPointCoordinate;
    angle: number;
    obb: OBB | null;
    aabb: number[] | null;
    obbs: OBB[];
    aabbs: number[][];
}

/** Resolved cross-tile candidate, including its mesh update ranges. */
export interface MainPassContainer extends CollisionObject {
    label: MainPassLabel;
    ranges: [number, number][];
    mesh: LabelMesh;
}

/** Temporary worker ID link, resolved before collision submission. */
export type UnresolvedMainPassContainer = Omit<MainPassContainer, 'linked'> & {
    linked?: number | string | CollisionObject | null;
};
