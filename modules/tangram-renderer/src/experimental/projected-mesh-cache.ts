// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Immutable projection-independent preparation owned by one worker. */
export interface PreparedProjectedMesh {
    /** Packed source attributes, never transferred or written into projected output. */
    readonly vertices: Uint8Array;
    /** Source-space refined triangle topology. */
    readonly indices: Uint16Array | Uint32Array;
}

/** Content-addressed entry; exact byte comparison guards against hash collisions. */
interface PreparationEntry {
    /** Metadata and source-content lookup identity. */
    readonly key: string;
    /** Detached original source bytes for exact equality and mutation detection. */
    readonly source: Uint8Array;
    /** Detached source topology; false denotes an unindexed stream. */
    readonly elements: Uint16Array | Uint32Array | false;
    /** Immutable prepared geometry. */
    readonly result: PreparedProjectedMesh;
    /** Accounted retained typed-array bytes. */
    readonly bytes: number;
}

/** Bounded LRU of source preparation, deliberately excluding target projection and engine identity. */
export class ProjectedMeshPreparationCache {
    /** Entries ordered oldest to newest, including colliding content hashes. */
    private readonly entries: PreparationEntry[] = [];
    /** Bytes retained in original and prepared buffers. */
    private bytes = 0;
    /** Number of preparations successfully reused. */
    private hits = 0;
    /** Number of requests requiring source preparation. */
    private misses = 0;

    /** Set worker-local limits; oversized entries are prepared but never retained. */
    constructor(private readonly maxBytes = 16 * 1024 * 1024, private readonly maxEntries = 64) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
            !Number.isSafeInteger(maxEntries) || maxEntries < 0) {
            throw new RangeError('Projection preparation cache requires nonnegative integer limits');
        }
    }

    /** Reuse only byte-identical source geometry and identical refinement/layout metadata. */
    getOrCreate(metadata: string, vertices: Uint8Array, indices: Uint16Array | Uint32Array | false,
        prepare: () => PreparedProjectedMesh): PreparedProjectedMesh {
        const key = `${metadata}:${hashBytes(vertices)}:${indices === false ? 'stream' : hashBytes(asBytes(indices))}`;
        const index = this.entries.findIndex(entry => entry.key === key && equalBytes(entry.source, vertices) &&
            (entry.elements === false || indices === false ? entry.elements === indices :
                entry.elements.constructor === indices.constructor && equalBytes(asBytes(entry.elements), asBytes(indices))));
        if (index >= 0) {
            const [entry] = this.entries.splice(index, 1);
            this.entries.push(entry);
            this.hits++;
            return entry.result;
        }
        this.misses++;
        const prepared = prepare();
        const bytes = vertices.byteLength + (indices === false ? 0 : indices.byteLength) +
            prepared.vertices.byteLength + prepared.indices.byteLength;
        if (this.maxEntries > 0 && bytes <= this.maxBytes) {
            while (this.entries.length >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
                this.bytes -= this.entries.shift()!.bytes;
            }
            // Preparation can return aliases of caller input. Detach everything kept by the cache.
            const result = {vertices: prepared.vertices.slice(), indices: prepared.indices.slice()};
            this.entries.push({key, source: vertices.slice(), elements: indices === false ? false : indices.slice(), result, bytes});
            this.bytes += bytes;
            return result;
        }
        return prepared;
    }

    /** Snapshot diagnostics without exposing mutable cached records. */
    getStatistics(): {entries: number; bytes: number; hits: number; misses: number} {
        return {entries: this.entries.length, bytes: this.bytes, hits: this.hits, misses: this.misses};
    }

    /** Release worker-owned preparation at reset or teardown. */
    clear(): void {
        this.entries.length = 0;
        this.bytes = this.hits = this.misses = 0;
    }
}

/** View only the typed array's occupied bytes, including nonzero buffer offsets. */
function asBytes(values: Uint16Array | Uint32Array): Uint8Array {
    return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

/** Cheap lookup hash, never a substitute for exact source comparison. */
function hashBytes(values: Uint8Array): number {
    let hash = 2166136261;
    for (const value of values) hash = Math.imul(hash ^ value, 16777619);
    return hash >>> 0;
}

/** Compare detached content, not transferable buffer identity. */
function equalBytes(first: Uint8Array, second: Uint8Array): boolean {
    if (first.length !== second.length) return false;
    for (let index = 0; index < first.length; index++) if (first[index] !== second[index]) return false;
    return true;
}
