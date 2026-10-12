// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TerrainDecoderStatistics} from './decoder-pool';

/** Format bounded decoder ownership and retained data categories; elapsed values are not frame time or CPU-only time. */
export function formatTerrainDecoderStatus(decoding: TerrainDecoderStatistics, memory: {gridBytes: number; meshBytes: number}): string {
    return `Decoder: ${decoding.created} workers created · ${decoding.idle} warm · ${decoding.completed} jobs · ${(memory.gridBytes / 1000000).toFixed(1)} MB grids · ${(memory.meshBytes / 1000000).toFixed(1)} MB source meshes${decoding.lastRoundTripMs !== undefined ? ` · last job ${decoding.lastRoundTripMs.toFixed(0)} ms round trip / ${decoding.lastDecodeMs?.toFixed(0) ?? '—'} ms decode elapsed` : ''}`;
}
