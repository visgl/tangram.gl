// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Source metadata subset structurally compatible with loaders.gl TileSourceMetadata. */
export interface TangramTileSourceMetadata {
    /** Decoder format, not a promise to select a different parser. */
    format?: string;
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
    const bounds = config.bounds ?? discovered.bounds;
    const metadata: TangramTileSourceMetadata = {name: source.name, attributions: source.getAttributions(),
        minZoom: source.zooms[0], maxZoom: source.max_zoom};
    const format = config.type ?? discovered.format;
    if (typeof format === 'string') metadata.format = format;
    if (config.zooms === undefined && config.max_zoom === undefined && typeof discovered.maxzoom === 'number') metadata.maxZoom = discovered.maxzoom;
    if (config.zooms === undefined && typeof discovered.minzoom === 'number') metadata.minZoom = discovered.minzoom;
    if (Array.isArray(bounds) && bounds.length === 4 && bounds.every(value => typeof value === 'number' && Number.isFinite(value))) {
        metadata.boundingBox = [[bounds[0], bounds[1]], [bounds[2], bounds[3]]];
    }
    return metadata;
}
