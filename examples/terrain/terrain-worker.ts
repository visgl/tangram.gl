// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {decodeTerrainTile, type TerrainNoDataPolicy} from './decode-terrain';

/** One dedicated worker processes one job; terminating it cancels image/mesh work. */
interface TerrainDecodeRequest {
    /** Transferred private copy of cached image bytes. */
    bytes: ArrayBuffer;
    /** Canonical geographic XYZ bounds. */
    bounds: [number, number, number, number];
    /** Adaptive-topology candidate error in physical meters. */
    meshMaxError: number;
    /** Explicit validity policy. */
    noData: TerrainNoDataPolicy;
}

/** Reject malformed transport without assertions into parser types. */
function isRequest(value: unknown): value is TerrainDecodeRequest {
    return Boolean(value && typeof value === 'object' && 'bytes' in value && value.bytes instanceof ArrayBuffer &&
        'bounds' in value && Array.isArray(value.bounds) && value.bounds.length === 4 && value.bounds.every(Number.isFinite) &&
        'meshMaxError' in value && typeof value.meshMaxError === 'number' && 'noData' in value && (value.noData === 'opaque' || value.noData === 'alpha-zero'));
}

addEventListener('message', async (event: MessageEvent<unknown>) => {
    try {
        if (!isRequest(event.data)) throw new Error('Malformed terrain decode request');
        const data = await decodeTerrainTile(event.data.bytes, event.data.bounds, event.data.meshMaxError, event.data.noData);
        const buffers = new Set<ArrayBuffer>();
        for (const attribute of Object.values(data.mesh.attributes)) if (attribute.value.buffer instanceof ArrayBuffer) buffers.add(attribute.value.buffer);
        if (data.mesh.indices?.value.buffer instanceof ArrayBuffer) buffers.add(data.mesh.indices.value.buffer);
        if (data.grid.heights.buffer instanceof ArrayBuffer) buffers.add(data.grid.heights.buffer);
        if (data.grid.valid.buffer instanceof ArrayBuffer) buffers.add(data.grid.valid.buffer);
        postMessage({type: 'result', data}, {transfer: [...buffers]});
    } catch (error) {
        postMessage({type: 'error', message: error instanceof Error ? error.message : String(error)});
    }
});
