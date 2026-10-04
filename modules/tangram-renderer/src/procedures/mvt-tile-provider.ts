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

/** Metadata supplied by TileJSON or an archive without depending on a renderer. */
export interface MvtProviderMetadata {
    /** Container format, distinct from the encoded tile MIME type. */
    format?: string;
    /** Encoded tile MIME type, when known. */
    tileMIMEType?: string;
    /** Provider's human-readable name. */
    name?: string;
    /** Required provider credits, never interpreted as trusted HTML. */
    attributions?: readonly string[];
    /** Lowest advertised tile level. */
    minZoom?: number;
    /** Highest advertised tile level. */
    maxZoom?: number;
    /** Geographic extent, including west greater than east at the antimeridian. */
    boundingBox?: readonly [readonly [number, number], readonly [number, number]];
}

/** Source-owned handle for archive metadata, cancellable requests and explicit teardown. */
export interface MvtTileProviderSource {
    /** Acquire encoded bytes; a canceled request must not publish a decoded tile. */
    getTile(index: MvtTileIndex, signal?: AbortSignal): Promise<ArrayBuffer | Uint8Array | null>;
    /** Resolve source capabilities and credits without fetching tile payloads. */
    getMetadata?(): Promise<MvtProviderMetadata>;
    /** Cancel pending transport work and release this source's archive/cache references. */
    dispose(): void;
}

/** Factory isolates archive ownership by Tangram source instance rather than global URL. */
export interface MvtTileProviderFactory {
    /** Create a handle for the resolved URL and optional authenticated request headers. */
    createSource(url: string, options: {headers?: Record<string, string>}): MvtTileProviderSource;
}

/** Existing stateless functions remain valid; factories add optional lifecycle capabilities. */
export type MvtTileProviderRegistration = MvtTileProvider | MvtTileProviderFactory;

const mvtTileProviders = new Map<string, MvtTileProviderRegistration>();

/** Register an MVT tile provider and return a function that removes that registration. */
export function registerMvtTileProvider(name: string, provider: MvtTileProviderRegistration): () => void {
    if (!name || !(typeof provider === 'function' || provider && typeof provider.createSource === 'function')) {
        throw new Error('MVT tile provider registration requires a name and provider function or source factory');
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
export function getMvtTileProvider(name: string): MvtTileProviderRegistration | undefined {
    return mvtTileProviders.get(name);
}
