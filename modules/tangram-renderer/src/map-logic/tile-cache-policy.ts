// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Immutable resource metadata supplied by the host, with unique keys per snapshot. */
export interface TileCacheRecord {
    /** Stable content identity, including source/style generation when necessary. */
    readonly key: string;
    /** Non-negative finite resource bytes; the host defines which resources are counted. */
    readonly bytes: number;
    /** Whether visibility, loading, proxies, pins or consumers currently prevent eviction. */
    readonly protected: boolean;
}

/** Already validated non-negative cache limits; protected records do not consume these budgets. */
export interface TileCacheOptions {
    /** Maximum evictable entries; omit for unlimited. */
    readonly maxCachedTiles?: number;
    /** Maximum evictable resource bytes; omit for unlimited. */
    readonly maxCachedBytes?: number;
}

/** Detached accounting for a host-provided resident snapshot, not a resource allocator. */
export interface TileCacheStatistics {
    /** All retained records, including protected entries. */
    residentTiles: number;
    /** Entries eligible for eviction. */
    cachedTiles: number;
    /** Bytes in evictable entries. */
    cachedBytes: number;
    /** Entries excluded from eviction. */
    protectedTiles: number;
    /** Bytes in protected entries. */
    protectedBytes: number;
}

/** Stable LRU policy owning recency metadata only; selection never disposes or removes content. */
export class TileCachePolicy {
    /** Logical access order, independent of clocks and resource ownership. */
    private readonly lastUsed = new Map<string, number>();
    /** Monotonic access sequence retained across metadata resets. */
    private tick = 0;

    /** Mark a key as recently used; callers decide when visibility counts as reuse. */
    touch(key: string): void {
        this.lastUsed.set(key, ++this.tick);
    }

    /** Release recency metadata after the host removes a record. */
    forget(key: string): void {
        this.lastUsed.delete(key);
    }

    /** Select oldest evictable keys until both budgets fit, without changing input or recency. */
    selectEvictions(records: readonly TileCacheRecord[], options?: TileCacheOptions): string[] {
        if (options?.maxCachedTiles === undefined && options?.maxCachedBytes === undefined) return [];
        const cached = records.filter(record => !record.protected);
        cached.sort((first, second) => (this.lastUsed.get(first.key) ?? 0) - (this.lastUsed.get(second.key) ?? 0));
        let count = cached.length;
        let bytes = cached.reduce((total, record) => total + record.bytes, 0);
        const evictions: string[] = [];
        for (const record of cached) {
            if (count <= (options?.maxCachedTiles ?? Infinity) && bytes <= (options?.maxCachedBytes ?? Infinity)) break;
            evictions.push(record.key);
            count--;
            bytes -= record.bytes;
        }
        return evictions;
    }

    /** Count the current snapshot without changing recency or retaining record objects. */
    getStatistics(records: readonly TileCacheRecord[]): TileCacheStatistics {
        let cachedTiles = 0, cachedBytes = 0, protectedBytes = 0;
        for (const record of records) {
            if (record.protected) protectedBytes += record.bytes;
            else {
                cachedTiles++;
                cachedBytes += record.bytes;
            }
        }
        return {residentTiles: records.length, cachedTiles, cachedBytes,
            protectedTiles: records.length - cachedTiles, protectedBytes};
    }

    /** Clear recency metadata without touching host content or resetting the logical clock. */
    clear(): void {
        this.lastUsed.clear();
    }
}
