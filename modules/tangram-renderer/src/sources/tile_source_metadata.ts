// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Source metadata subset structurally compatible with loaders.gl TileSourceMetadata. */
export interface TangramTileSourceMetadata {
    /** Source/container format, not a promise to select a different parser. */
    format?: string;
    /** Encoded tile MIME type, separate from archive format and decoder selection. */
    tileMIMEType?: string;
    /** Human-readable source name. */
    name?: string;
    /** Provider credits; consumers must sanitize before rendering HTML. */
    attributions?: string[];
    /** Minimum advertised data level. */
    minZoom?: number;
    /** Maximum advertised data level. */
    maxZoom?: number;
    /** Geographic bounds, retaining antimeridian-crossing west/east ordering. */
    boundingBox?: [[number, number], [number, number]];
}

/** Configuration plus discovered metadata, without depending on the DataSource implementation. */
export interface SourceMetadataInput {
    /** Original scene source options. */
    config: Record<string, unknown>;
    /** Logical scene source name. */
    name: string;
    /** Effective legacy data levels. */
    zooms: readonly number[];
    /** Effective legacy data ceiling. */
    max_zoom: number;
    /** Authored and discovered provider credits. */
    getAttributions(): string[];
}

/** Normalize metadata for new consumers without changing legacy source layout or URL resolution. */
export function createTileSourceMetadata(source: SourceMetadataInput, discovered: Record<string, unknown> = {}): TangramTileSourceMetadata {
    const config = source.config;
    const bounds = config.bounds ?? discovered.bounds ?? discovered.boundingBox;
    const metadata: TangramTileSourceMetadata = {name: typeof discovered.name === 'string' ? discovered.name : source.name, attributions: source.getAttributions(),
        minZoom: source.zooms[0], maxZoom: source.max_zoom};
    const format = discovered.format ?? config.type;
    if (typeof format === 'string') metadata.format = format;
    if (typeof discovered.tileMIMEType === 'string') metadata.tileMIMEType = discovered.tileMIMEType;
    const maximum = discovered.maxzoom ?? discovered.maxZoom;
    const minimum = discovered.minzoom ?? discovered.minZoom;
    if (config.zooms === undefined && config.max_zoom === undefined && validZoom(maximum)) metadata.maxZoom = maximum;
    if (config.zooms === undefined && validZoom(minimum)) metadata.minZoom = minimum;
    if (metadata.minZoom !== undefined && metadata.maxZoom !== undefined && metadata.minZoom > metadata.maxZoom) {
        metadata.minZoom = source.zooms[0];
        metadata.maxZoom = source.max_zoom;
    }
    const flattened = Array.isArray(bounds) && bounds.length === 2 && bounds.every(value => Array.isArray(value) && value.length === 2) ? bounds.flat() : bounds;
    if (Array.isArray(flattened) && flattened.length === 4 && flattened.every(value => typeof value === 'number' && Number.isFinite(value)) &&
        Math.abs(flattened[0]) <= 180 && Math.abs(flattened[2]) <= 180 && flattened[1] >= -90 && flattened[3] <= 90 && flattened[1] <= flattened[3]) {
        metadata.boundingBox = [[flattened[0], flattened[1]], [flattened[2], flattened[3]]];
    }
    return metadata;
}

/** Reject unusable advertised levels rather than passing NaN or infinite values to traversal. */
function validZoom(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 30;
}
