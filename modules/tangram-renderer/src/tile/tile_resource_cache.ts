// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {HostTileResourceOptions, TileResourceStatistics} from '../types';
import {TileCachePolicy} from '../map-logic/tile-cache-policy';

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
    /** Neutral metadata policy; renderer mesh accounting stays in this adapter. */
    private readonly policy = new TileCachePolicy();

    /** Mark newly retained or currently protected tiles as recently used. */
    touch(key: string): void { this.policy.touch(key); }

    /** Remove metadata with the tile's worker and GPU resources. */
    forget(key: string): void { this.policy.forget(key); }

    /** Choose oldest completed cache entries until both opt-in limits are satisfied. */
    selectEvictions(tiles: readonly ResourceTile[], options: HostTileResourceOptions | undefined,
        isPreloaded: (key: string) => boolean): string[] {
        if (options?.maxCachedTiles === undefined && options?.maxCachedMeshBytes === undefined) return [];
        // As before, only walk mesh allocations for evictable tiles when a budget is enabled.
        const records = tiles.filter(tile => !this.isProtected(tile, isPreloaded))
            .map(tile => ({key: tile.key, bytes: getTileMeshBytes(tile), protected: false}));
        return this.policy.selectEvictions(records, {maxCachedTiles: options?.maxCachedTiles,
            maxCachedBytes: options?.maxCachedMeshBytes});
    }

    /** Detached accounting for protected residency and evictable cache separately. */
    getStatistics(tiles: readonly ResourceTile[], isPreloaded: (key: string) => boolean,
        builds: {activeBuilds: number; queuedBuilds: number}): TileResourceStatistics {
        const statistics = this.policy.getStatistics(tiles.map(tile => ({key: tile.key,
            protected: this.isProtected(tile, isPreloaded), bytes: getTileMeshBytes(tile)})));
        return {...builds, residentTiles: statistics.residentTiles, cachedTiles: statistics.cachedTiles,
            cachedMeshBytes: statistics.cachedBytes, protectedTiles: statistics.protectedTiles,
            protectedMeshBytes: statistics.protectedBytes};
    }

    /** Visible union, loading work, proxy ancestors and pinned coarse tiles are never cache victims. */
    isProtected(tile: ResourceTile, isPreloaded: (key: string) => boolean): boolean {
        return tile.visible || tile.loading || !tile.built || tile.isProxy() || isPreloaded(tile.key);
    }

    /** Clear residency metadata on renderer teardown. */
    clear(): void { this.policy.clear(); }
}
