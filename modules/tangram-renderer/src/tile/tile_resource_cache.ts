// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {HostTileResourceOptions, TileResourceStatistics} from '../types';

/** The byte-accounting surface shared by planar, globe, and pending-label meshes. */
interface ResourceMesh {
    /** Vertex and index allocation size, excluding textures and driver overhead. */
    buffer_size?: number;
    /** Independently allocated projection-specific mesh. */
    globe_mesh?: ResourceMesh | null;
}

/** Minimal lifecycle state used by the resource policy; no GPU or host dependency. */
export interface ResourceTile {
    /** Source/style-normalized key. */
    key: string;
    /** Eye-union and fallback visibility. */
    visible: boolean;
    /** Worker processing is still incomplete. */
    loading: boolean;
    /** All mesh batches have arrived. */
    built: boolean;
    /** Current drawable meshes by style. */
    meshes: Record<string, ResourceMesh[]>;
    /** Label mesh batches waiting for collision layout. */
    pending_label_meshes?: Record<string, ResourceMesh[]> | null;
    /** Proxy tiles remain protected even if not explicitly visible. */
    isProxy(): boolean;
}

/** Mesh bytes currently owned by a tile, deduplicating shared mesh references. */
export function getTileMeshBytes(tile: ResourceTile): number {
    const seen = new Set<ResourceMesh>();
    let bytes = 0;
    const addMesh = (mesh: ResourceMesh): void => {
        if (seen.has(mesh)) return;
        seen.add(mesh);
        if (typeof mesh.buffer_size === 'number' && Number.isFinite(mesh.buffer_size) && mesh.buffer_size > 0) {
            bytes += mesh.buffer_size;
        }
        if (mesh.globe_mesh) addMesh(mesh.globe_mesh);
    };
    for (const collection of [tile.meshes, tile.pending_label_meshes]) {
        for (const meshes of Object.values(collection ?? {})) for (const mesh of meshes) addMesh(mesh);
    }
    return bytes;
}

/** LRU limits apply only to completed, unneeded tiles, never visible/proxy/preload work. */
export default class TileResourceCache {
    /** Last protected use or insertion, using monotonic logical ticks rather than wall time. */
    private readonly lastUsed = new Map<string, number>();
    /** Stable ordering for ties and rapid same-frame transitions. */
    private tick = 0;

    /** Mark newly retained or currently protected tiles as recently used. */
    touch(key: string): void { this.lastUsed.set(key, ++this.tick); }

    /** Remove metadata with the tile's worker and GPU resources. */
    forget(key: string): void { this.lastUsed.delete(key); }

    /** Choose oldest completed cache entries until both opt-in limits are satisfied. */
    selectEvictions(tiles: readonly ResourceTile[], options: HostTileResourceOptions | undefined,
        isPreloaded: (key: string) => boolean): string[] {
        if (options?.maxCachedTiles === undefined && options?.maxCachedMeshBytes === undefined) return [];
        const cached = tiles.filter(tile => !this.isProtected(tile, isPreloaded));
        cached.sort((first, second) => (this.lastUsed.get(first.key) ?? 0) - (this.lastUsed.get(second.key) ?? 0));
        let count = cached.length;
        let bytes = cached.reduce((total, tile) => total + getTileMeshBytes(tile), 0);
        const evictions: string[] = [];
        for (const tile of cached) {
            if (count <= (options?.maxCachedTiles ?? Infinity) && bytes <= (options?.maxCachedMeshBytes ?? Infinity)) break;
            evictions.push(tile.key);
            count--;
            bytes -= getTileMeshBytes(tile);
        }
        return evictions;
    }

    /** Detached accounting for protected residency and evictable cache separately. */
    getStatistics(tiles: readonly ResourceTile[], isPreloaded: (key: string) => boolean,
        builds: {activeBuilds: number; queuedBuilds: number}): TileResourceStatistics {
        let cachedTiles = 0, cachedMeshBytes = 0, protectedMeshBytes = 0;
        for (const tile of tiles) {
            if (this.isProtected(tile, isPreloaded)) protectedMeshBytes += getTileMeshBytes(tile);
            else { cachedTiles++; cachedMeshBytes += getTileMeshBytes(tile); }
        }
        return {...builds, residentTiles: tiles.length, cachedTiles, cachedMeshBytes,
            protectedTiles: tiles.length - cachedTiles, protectedMeshBytes};
    }

    /** Visible union, loading work, proxy ancestors and pinned coarse tiles are never cache victims. */
    isProtected(tile: ResourceTile, isPreloaded: (key: string) => boolean): boolean {
        return tile.visible || tile.loading || !tile.built || tile.isProxy() || isPreloaded(tile.key);
    }

    /** Clear residency metadata on renderer teardown. */
    clear(): void { this.lastUsed.clear(); }
}
