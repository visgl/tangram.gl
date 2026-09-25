// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Tile coordinates passed to a registered MVT tile provider. */
export type MvtTileIndex = {x: number; y: number; z: number};

/** Loads encoded vector-tile bytes for a Tangram source URL and tile index. */
export type MvtTileProvider = (
    url: string,
    tileIndex: MvtTileIndex
) => Promise<ArrayBuffer | Uint8Array | null> | ArrayBuffer | Uint8Array | null;

const mvtTileProviders = new Map<string, MvtTileProvider>();

/** Register an MVT tile provider and return a function that removes that registration. */
export function registerMvtTileProvider(name: string, provider: MvtTileProvider): () => void {
    if (!name || typeof provider !== 'function') {
        throw new Error('MVT tile provider registration requires a name and provider function');
    }
    if (mvtTileProviders.has(name)) {
        throw new Error(`MVT tile provider '${name}' is already registered`);
    }
    mvtTileProviders.set(name, provider);
    return () => {
        if (mvtTileProviders.get(name) === provider) {
            mvtTileProviders.delete(name);
        }
    };
}

/** Find a registered MVT tile provider by name. */
export function getMvtTileProvider(name: string): MvtTileProvider | undefined {
    return mvtTileProviders.get(name);
}
