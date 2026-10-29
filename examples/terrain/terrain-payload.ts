// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Mesh} from '@loaders.gl/schema';
import type {TerrainHeightGrid} from '@tangram.gl/tangram-renderer/map-logic';

/** Physical samples only; globe display topology is prepared independently. */
export interface TerrainGridData {
    /** Physical EPSG:3857 samples with explicit registration and validity. */
    grid: TerrainHeightGrid;
}

/** Optional topology boundary used by shared residency accounting. */
export interface TerrainPayload extends TerrainGridData {
    /** Present only for consumers that requested an adaptive geographic mesh. */
    mesh?: Mesh;
}

/** Serializable Mercator worker output, without Deck or query-surface instances. */
export interface TerrainTileData extends TerrainGridData {
    /** Adaptive mesh in geographic XY and physical-meter Z. */
    mesh: Mesh;
}

/** Alpha has no no-data meaning unless explicitly requested. */
export type TerrainNoDataPolicy = 'opaque' | 'alpha-zero';

/** Shared source-domain/transport validation, before copying bytes or allocating image resources. */
export function validateTerrainImage(bytes: ArrayBuffer, bounds: readonly [number, number, number, number], noData: TerrainNoDataPolicy): void {
    if (bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3] || bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -85.0511287798066 || bounds[3] > 85.0511287798066) throw new Error('Terrain tile requires ordered Mercator-domain geographic bounds');
    if (noData !== 'opaque' && noData !== 'alpha-zero') throw new Error('Unknown terrain no-data policy');
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('Terrain image exceeds compressed byte limit');
}

/** Validate loader and worker geometry before using its typed attributes. */
export function isTerrainMesh(value: unknown): value is Mesh {
    if (!value || typeof value !== 'object' || !('attributes' in value) || !value.attributes || typeof value.attributes !== 'object' ||
        !('POSITION' in value.attributes) || !('indices' in value) || !value.indices || typeof value.indices !== 'object' ||
        !('topology' in value) || value.topology !== 'triangle-list' || !('mode' in value) || typeof value.mode !== 'number' ||
        !('schema' in value) || !value.schema || typeof value.schema !== 'object') return false;
    const positions = value.attributes.POSITION, indices = value.indices;
    if (!positions || typeof positions !== 'object' || !('size' in positions) || positions.size !== 3 || !('value' in positions) ||
        !(positions.value instanceof Float32Array) || positions.value.length % 3 !== 0 || !('size' in indices) || indices.size !== 1 ||
        !('value' in indices) || !(indices.value instanceof Uint32Array || indices.value instanceof Uint16Array) || indices.value.length % 3 !== 0 ||
        !('fields' in value.schema) || !Array.isArray(value.schema.fields) || !('metadata' in value.schema) || !value.schema.metadata || typeof value.schema.metadata !== 'object') return false;
    const positionValues = positions.value;
    return positionValues.every(Number.isFinite) && indices.value.every(index => index < positionValues.length / 3);
}

/** Validate physical structured-cloned samples without importing image or mesh parsers. */
export function isTerrainGridData(value: unknown): value is TerrainGridData {
    if (!value || typeof value !== 'object' || !('grid' in value) || !value.grid || typeof value.grid !== 'object') return false;
    const grid = value.grid;
    if (!('valid' in grid) || !(grid.valid instanceof Uint8Array)) return false;
    const valid = grid.valid;
    return 'width' in grid && typeof grid.width === 'number' && Number.isSafeInteger(grid.width) && grid.width >= 2 && grid.width <= 1024 &&
        'height' in grid && grid.height === grid.width && (grid.width & (grid.width - 1)) === 0 &&
        'heights' in grid && grid.heights instanceof Float32Array && grid.heights.length === grid.width * grid.height && valid.length === grid.heights.length &&
        grid.heights.every((height, index) => !valid[index] || Number.isFinite(height)) &&
        'bounds' in grid && Array.isArray(grid.bounds) && grid.bounds.length === 4 && grid.bounds.every(Number.isFinite) && grid.bounds[0] < grid.bounds[2] && grid.bounds[1] < grid.bounds[3] &&
        'registration' in grid && grid.registration === 'pixel-center' && 'verticalDatum' in grid && grid.verticalDatum === 'unknown';
}

/** Mesh-bearing responses must satisfy both physical and topology contracts. */
export function isTerrainTileData(value: unknown): value is TerrainTileData {
    return isTerrainGridData(value) && 'mesh' in value && isTerrainMesh(value.mesh);
}
