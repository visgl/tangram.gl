// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Geographic identity retained independently of rendered geometry and cameras. */
export interface GeographicLabelAnchor {
    /** Source/style/feature/text identity; absent identities cannot deduplicate. */
    readonly identity?: string;
    /** Tile identity; multiple mesh parts of the same tile are not buffered copies. */
    readonly sourceTileIdentity: object | string;
    /** Absolute projected XY in the same units as the world width. */
    readonly anchor: readonly [number, number];
    /** Quantized physical elevation; distinct elevations remain separate labels. */
    readonly height: number;
    /** Source detail used for coordinate quantization, independent of style zoom. */
    readonly sourceZoom: number;
}

/** Explicit coordinate conventions; no renderer projection or Earth radius is assumed. */
export interface GeographicLabelIdentityOptions {
    /** Width of a complete projected world in anchor units. */
    readonly worldWidth: number;
    /** Treat horizontally wrapped copies as the same surface, as on a globe. */
    readonly wrapHorizontal: boolean;
}

/** Match buffered copies within two 4096-unit source-tile quantization steps. */
export function areGeographicLabelCopies(candidate: GeographicLabelAnchor, previous: GeographicLabelAnchor,
    options: GeographicLabelIdentityOptions): boolean {
    if (!candidate.identity || candidate.identity !== previous.identity || candidate.sourceTileIdentity === previous.sourceTileIdentity) return false;
    if (candidate.height !== previous.height) return false;
    const tolerance = 2 * options.worldWidth / (4096 * 2 ** Math.min(candidate.sourceZoom, previous.sourceZoom));
    const horizontal = candidate.anchor[0] - previous.anchor[0];
    const difference = options.wrapHorizontal ? horizontal - Math.round(horizontal / options.worldWidth) * options.worldWidth : horizontal;
    return Math.hypot(difference, candidate.anchor[1] - previous.anchor[1]) <= tolerance;
}
