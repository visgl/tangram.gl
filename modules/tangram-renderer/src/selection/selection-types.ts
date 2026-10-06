// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TileCoordinates} from '../tile/tile_id';

/** Canvas-relative selection position or radius. */
export interface SelectionPoint {
    x: number;
    y: number;
}

/** Build-owned tile metadata returned with a selected feature. */
export interface SelectionTile {
    key: string;
    coords: TileCoordinates;
    style_z: number;
    source: string;
    generation: number;
}

/** Source feature members copied into the worker's selection map. */
export interface SelectionSourceFeature {
    id?: string | number;
    properties: Record<string, unknown>;
}

/** Source and matched scene layers attached to a selection entry. */
export interface SelectionContext {
    source: string;
    layer: string;
    layers: string[];
}

/** Public feature metadata produced by the built-in worker selection map. */
export interface SelectedFeature extends SelectionSourceFeature {
    source_name: string;
    source_layer: string;
    layers: string[];
    tile: SelectionTile;
}

/** Normalized RGBA selection color with optional feature metadata. */
export interface SelectionEntry {
    color: [number, number, number, number];
    feature?: SelectedFeature;
}

/** Per-build ownership of selection keys. */
export interface SelectionTileEntries {
    entries: number[];
    tile: SelectionTile;
}

/** Worker reply; custom registered workers can return arbitrary feature payloads. */
export interface SelectionReply {
    id: number;
    feature?: unknown;
}

/** Resolved selection state; out-of-bounds requests have no queued request record. */
export interface SelectionResult {
    feature: unknown;
    changed: boolean;
    request?: SelectionRequest;
}

/** Pending readback/lookup, retained by identity to reject stale asynchronous replies. */
export interface SelectionRequest {
    id: number;
    point: SelectionPoint;
    radius?: SelectionPoint | null;
    resolve(result: SelectionResult): void;
    reject(error: unknown): void;
    sent?: boolean;
    reading?: boolean;
}
