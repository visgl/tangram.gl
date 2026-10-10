// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Axis-aligned CSS-pixel bounds: minimum X/Y followed by maximum X/Y. */
export type ScreenBounds = readonly [number, number, number, number];

/** Local viewport dimensions; bounds do not include a canvas/eye origin. */
export interface LabelViewport {
    /** Local CSS-pixel width. */
    readonly width: number;
    /** Local CSS-pixel height. */
    readonly height: number;
}

/** Strict rectangle overlap; touching padded edges do not collide. */
export function intersectsScreenBounds(left: ScreenBounds, right: ScreenBounds): boolean {
    return left[0] < right[2] && left[2] > right[0] && left[1] < right[3] && left[3] > right[1];
}

/** Combine parts of one annotation without modifying either input. */
export function unionScreenBounds(left: ScreenBounds | undefined, right: ScreenBounds): ScreenBounds {
    return left ? [Math.min(left[0], right[0]), Math.min(left[1], right[1]),
        Math.max(left[2], right[2]), Math.max(left[3], right[3])] : right;
}

/** Enumerate 64-pixel spatial-index cells, clipped to the visible viewport. */
export function* getScreenBoundsCells(box: ScreenBounds, viewport: LabelViewport): Generator<string> {
    for (let horizontal = Math.floor(Math.max(0, box[0]) / 64); horizontal <= Math.floor(Math.min(viewport.width, box[2]) / 64); horizontal++) {
        for (let vertical = Math.floor(Math.max(0, box[1]) / 64); vertical <= Math.floor(Math.min(viewport.height, box[3]) / 64); vertical++) {
            yield `${horizontal},${vertical}`;
        }
    }
}
