// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ParseJsonOption} from './mvt-properties';

/** Tangram-compatible decoded MVT layers in local tile coordinates. */
export type MvtLayers = Record<string, {
    type: 'FeatureCollection';
    features: unknown[];
}>;

/** Signature required of a registered MVT decoder. */
export type MvtDecoder = (
    response: ArrayBuffer | Uint8Array,
    options: {parseJson?: ParseJsonOption}
) => MvtLayers;

const mvtDecoders = new Map<string, MvtDecoder>();

/** Register an MVT decoder and return a function that removes that registration. */
export function registerMvtDecoder(name: string, decoder: MvtDecoder): () => void {
    if (!name || typeof decoder !== 'function') {
        throw new Error('MVT decoder registration requires a name and decoder function');
    }
    if (mvtDecoders.has(name)) {
        throw new Error(`MVT decoder '${name}' is already registered`);
    }
    mvtDecoders.set(name, decoder);
    return () => {
        if (mvtDecoders.get(name) === decoder) {
            mvtDecoders.delete(name);
        }
    };
}

/** Decode one MVT payload with the selected registered decoder. */
export function parseMvt(
    name: string,
    response: ArrayBuffer | Uint8Array,
    options: {parseJson?: ParseJsonOption}
): MvtLayers {
    const decoder = mvtDecoders.get(name);
    if (!decoder) {
        throw new Error(`MVT decoder '${name}' is not registered in this worker`);
    }
    return decoder(response, options);
}
