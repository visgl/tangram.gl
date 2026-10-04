// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {PMTilesSourceLoader} from '@loaders.gl/pmtiles';
import type {MvtProviderMetadata, MvtTileProviderFactory, MvtTileProviderSource} from './mvt-tile-provider';

type PMTilesTileSource = ReturnType<typeof PMTilesSourceLoader.createDataSource>;

/** PMTiles transport factory; every Tangram source owns exactly one archive handle. */
export const pmtilesTileProvider: MvtTileProviderFactory = {createSource: createPMTilesSource};

/** Acquire archive metadata and raw tile bytes without a global URL cache or a decoder switch. */
export function createPMTilesSource(url: string, options: {headers?: Record<string, string>} = {}): MvtTileProviderSource {
    const lifetime = new AbortController();
    let source: PMTilesTileSource | undefined = PMTilesSourceLoader.createDataSource(url, {
        core: {fetch: async (requestUrl: string, requestOptions: RequestInit = {}) => {
            const controller = new AbortController();
            const abort = (): void => controller.abort();
            const requestSignal = requestOptions.signal;
            if (lifetime.signal.aborted || requestSignal?.aborted) controller.abort();
            lifetime.signal.addEventListener('abort', abort, {once: true});
            requestSignal?.addEventListener('abort', abort, {once: true});
            try {
                const headers = new Headers(requestOptions.headers);
                for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
                const response = await fetch(requestUrl, {...requestOptions, headers, signal: controller.signal});
                // Range transports consume the body after fetch resolves. Keep the
                // lifetime signal bound until that body finishes, not just headers.
                const bytes = await response.arrayBuffer();
                return new Response(bytes, {status: response.status, statusText: response.statusText, headers: response.headers});
            } finally {
                lifetime.signal.removeEventListener('abort', abort);
                requestSignal?.removeEventListener('abort', abort);
            }
        }}
    });
    // loaders.gl starts metadata eagerly; retain the rejection for getMetadata(),
    // but do not emit an unhandled rejection when a source is disposed before use.
    const metadata = source.metadata;
    void metadata.catch(() => {});
    let capabilities: Promise<MvtProviderMetadata> | undefined;
    return {
        async getTile(index, signal) {
            if (!source || signal?.aborted) throw createAbortError();
            const bytes = await source.getTile({...index, signal});
            if (!source || signal?.aborted) throw createAbortError();
            return bytes;
        },
        async getMetadata() {
            if (!source) throw createAbortError();
            if (!capabilities) {
                // alpha.8 drops credits in both normalized metadata surfaces.
                // Keep the raw archive JSON as well, without changing its parser.
                capabilities = Promise.all([metadata, source.pmtiles.getMetadata()]).then(([value, raw]) => {
                    const rawAttribution = raw && typeof raw === 'object' && 'attribution' in raw ? raw.attribution : undefined;
                    const nestedAttribution = value.tilejson?.htmlAttribution;
                    return {...value, attributions: [...new Set([...(value.attributions ?? []),
                        ...[nestedAttribution, rawAttribution].filter((credit): credit is string => typeof credit === 'string')])]};
                });
            }
            const value = await capabilities;
            if (!source) throw createAbortError();
            return value;
        },
        dispose() { lifetime.abort(); source = undefined; }
    };
}

/** Cancellation stays distinguishable from missing archive content. */
function createAbortError(): Error {
    const error = new Error('PMTiles source request aborted');
    error.name = 'AbortError';
    return error;
}
