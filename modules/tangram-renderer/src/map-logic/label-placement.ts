// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {getScreenBoundsCells, intersectsScreenBounds} from './screen-bounds';
import type {ScreenBounds, LabelViewport} from './screen-bounds';

/** Renderer-independent candidate, already projected and ordered by the caller. */
export interface ScreenLabelCandidate {
    /** Unique ID within this invocation; also identifies linked candidates. */
    readonly id: string;
    /** Visible, padded local CSS-pixel bounds per named view. Empty means hidden. */
    readonly boxes: ReadonlyMap<string, ScreenBounds>;
    /** False skips overlap rejection but retains repeat and identity rules. */
    readonly collide?: boolean;
    /** Optional dependency; reciprocal links form an atomic pair. */
    readonly linkedId?: string;
    /** Key used to compare candidate copies via the supplied identity policy. */
    readonly identity?: string;
    /** Optional repeat group shared by labels representing the same content. */
    readonly repeatGroup?: string;
    /** Minimum CSS-pixel separation between box centers in every shared view. */
    readonly repeatDistance?: number;
}

/** Geometry and identity policy supplied by the host, not owned by this algorithm. */
export interface LabelPlacementOptions<Candidate extends ScreenLabelCandidate> {
    /** Dimensions for every view named by candidate bounds. */
    readonly viewports: ReadonlyMap<string, LabelViewport>;
    /** Optional buffered-copy policy; called only within matching identity groups. */
    readonly isDuplicate?: (candidate: Candidate, previous: Candidate) => boolean;
}

/**
 * Resolve one visibility mask across all views in caller-supplied priority order.
 * Inputs must have unique IDs and finite, ordered, already clipped/padded bounds.
 * No input mutation, global state, camera, tile, worker, DOM or GPU dependency.
 * Reciprocal links are placed atomically; optional children may overlap their parent.
 */
export function resolveLabelPlacement<Candidate extends ScreenLabelCandidate>(ordered: readonly Candidate[],
    options: LabelPlacementOptions<Candidate>): ReadonlyMap<Candidate, boolean> {
    const candidates = new Map(ordered.map(candidate => [candidate.id, candidate]));
    const shown = new Map<Candidate, boolean>();
    const identities = new Map<string, Candidate[]>();
    const repeatGroups = new Map<string, Candidate[]>();
    const grids = new Map<string, Map<string, Set<Candidate>>>();
    const placing = new Set<Candidate>();
    /** Require a matching local viewport for spatial indexing. */
    function getViewport(view: string): LabelViewport {
        const viewport = options.viewports.get(view);
        if (!viewport) throw new Error(`Missing label viewport: ${view}`);
        return viewport;
    }
    /** Resolve dependencies before committing one candidate or reciprocal pair. */
    function place(candidate: Candidate): boolean {
        const visibility = shown.get(candidate);
        if (visibility !== undefined) return visibility;
        if (placing.has(candidate)) return false;
        placing.add(candidate);
        const linked = candidate.linkedId === undefined ? undefined : candidates.get(candidate.linkedId);
        const required = linked && linked.linkedId === candidate.id;
        const group = required ? [candidate, linked] : [candidate];
        if (linked && !required && !place(linked)) {
            shown.set(candidate, false);
            placing.delete(candidate);
            return false;
        }
        const show = group.every(member => member.boxes.size > 0 &&
            !(identities.get(member.identity ?? '') ?? []).some(previous => options.isDuplicate?.(member, previous)) &&
            !(repeatGroups.get(member.repeatGroup ?? '') ?? []).some(previous => repeats(member, previous))) &&
            group.every(member => member.collide === false || [...member.boxes].every(([view, box]) => {
                const grid = grids.get(view);
                if (!grid) return true;
                const nearby = new Set<Candidate>();
                for (const cell of getScreenBoundsCells(box, getViewport(view))) for (const previous of grid.get(cell) ?? []) nearby.add(previous);
                return [...nearby].every(previous => previous === linked || !intersectsScreenBounds(box, previous.boxes.get(view)!));
            }));
        for (const member of group) {
            shown.set(member, show);
            if (!show) continue;
            if (member.identity) {
                const copies = identities.get(member.identity) ?? [];
                copies.push(member);
                identities.set(member.identity, copies);
            }
            if (member.repeatGroup && member.repeatDistance) {
                const repeated = repeatGroups.get(member.repeatGroup) ?? [];
                repeated.push(member);
                repeatGroups.set(member.repeatGroup, repeated);
            }
            for (const [view, box] of member.boxes) {
                let grid = grids.get(view);
                if (!grid) grids.set(view, grid = new Map());
                for (const cell of getScreenBoundsCells(box, getViewport(view))) {
                    let bucket = grid.get(cell);
                    if (!bucket) grid.set(cell, bucket = new Set());
                    bucket.add(member);
                }
            }
        }
        placing.delete(candidate);
        return show;
    }
    ordered.forEach(place);
    return shown;
}

/** Preserve authored spacing in any view shared by the candidate and prior label. */
function repeats(candidate: ScreenLabelCandidate, previous: ScreenLabelCandidate): boolean {
    const repeatDistance = candidate.repeatDistance;
    if (!repeatDistance || !candidate.repeatGroup || candidate.repeatGroup !== previous.repeatGroup) return false;
    return [...candidate.boxes].some(([view, box]) => {
        const other = previous.boxes.get(view);
        return other !== undefined && Math.hypot((box[0] + box[2] - other[0] - other[2]) / 2,
            (box[1] + box[3] - other[1] - other[3]) / 2) < repeatDistance;
    });
}
