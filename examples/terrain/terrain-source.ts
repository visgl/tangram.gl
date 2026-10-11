// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TerrainTileCoordinate} from './tile-selection';
import type {TerrainNoDataPolicy} from './decode-terrain';

/** Visible source credit; text is never interpreted as HTML. */
export interface TerrainSourceCredit {
    /** Human-readable organization or dataset. */
    label: string;
    /** Absolute HTTP(S) information/license URL. */
    url: string;
}

/** Example-local Terrarium source boundary, separate from scheduling and presentation. */
export interface TerrainImageSource {
    /** Immutable content identity; a mount owns one source and its isolated cache. */
    readonly id: string;
    /** Supported canonical XYZ zoom interval. */
    readonly minZoom: number;
    readonly maxZoom: number;
    /** Explicit image validity convention, forwarded to the decoder worker. */
    readonly noData: TerrainNoDataPolicy;
    /** Required credits, rendered alongside the terrain. */
    readonly credits: readonly TerrainSourceCredit[];
    /** Abortable source acquisition; returns owned bytes, not decoded or rendered data. */
    fetchTile(tile: TerrainTileCoordinate, signal: AbortSignal): Promise<ArrayBuffer>;
}

/** Validate injected source metadata before creating DOM, jobs or provider URLs. */
export function validateTerrainImageSource(source: TerrainImageSource): void {
    if (!source.id.trim() || !Number.isSafeInteger(source.minZoom) || !Number.isSafeInteger(source.maxZoom) || source.minZoom < 0 || source.maxZoom > 12 || source.minZoom > source.maxZoom ||
        !['opaque', 'alpha-zero'].includes(source.noData) || !source.credits.length) throw new Error('Invalid terrain source metadata');
    for (const credit of source.credits) {
        if (!credit.label.trim()) throw new Error('Terrain credits require readable text');
        validateUrl(credit.url);
    }
}

/** Construct a bounded HTTP Terrarium image source, without a module-global fetch or cache. */
export function createTerrainImageSource(options: {
    /** Content identity, including any archive/version distinction. */
    id: string;
    /** Absolute HTTP(S) template with exactly one {z}, {x} and {y}. */
    urlTemplate: string;
    /** Required attribution links. */
    credits: readonly TerrainSourceCredit[];
    /** Supported source interval, default z0–12. */
    minZoom?: number;
    maxZoom?: number;
    /** Explicit validity policy, default opaque. */
    noData?: TerrainNoDataPolicy;
    /** Body limit, at most the decoder's 8 MiB limit. */
    maxBytes?: number;
    /** Whole acquisition deadline, default 30 seconds. */
    timeoutMilliseconds?: number;
    /** Injectable acquisition for offline hosts and conformance tests. */
    fetch?: typeof globalThis.fetch;
}): TerrainImageSource {
    const minZoom = options.minZoom ?? 0, maxZoom = options.maxZoom ?? 12;
    const noData = options.noData ?? 'opaque', maxBytes = options.maxBytes ?? 8 * 1024 * 1024, timeoutMilliseconds = options.timeoutMilliseconds ?? 30000;
    if (!options.id.trim() || !Number.isSafeInteger(minZoom) || !Number.isSafeInteger(maxZoom) || minZoom < 0 || maxZoom > 12 || minZoom > maxZoom ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024 || !Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds <= 0 ||
        !['opaque', 'alpha-zero'].includes(noData) || !options.credits.length) throw new Error('Invalid terrain source metadata or limits');
    for (const token of ['{z}', '{x}', '{y}']) if (options.urlTemplate.split(token).length !== 2) throw new Error('Terrain URL requires one z/x/y token');
    validateUrl(options.urlTemplate.replace('{z}', '0').replace('{x}', '0').replace('{y}', '0'));
    const credits = Object.freeze(options.credits.map(credit => {
        if (!credit.label.trim()) throw new Error('Terrain credits require readable text');
        validateUrl(credit.url);
        return Object.freeze({...credit});
    }));
    const template = options.urlTemplate;
    const fetchImage = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    return Object.freeze({id: options.id, minZoom, maxZoom, noData, credits, async fetchTile(tile: TerrainTileCoordinate, signal: AbortSignal) {
        if (!Number.isSafeInteger(tile.zoom) || tile.zoom < minZoom || tile.zoom > maxZoom || !Number.isSafeInteger(tile.column) || !Number.isSafeInteger(tile.row) || tile.column < 0 || tile.row < 0 || tile.column >= 2 ** tile.zoom || tile.row >= 2 ** tile.zoom) throw new Error('Terrain tile outside source domain');
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
        const timeout = setTimeout(() => controller.abort(new Error('Terrain source timed out')), timeoutMilliseconds);
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        const cancelBody = () => {void reader?.cancel(controller.signal.reason).catch(() => {});};
        controller.signal.addEventListener('abort', cancelBody, {once: true});
        try {
            controller.signal.throwIfAborted();
            const url = template.replace('{z}', String(tile.zoom)).replace('{x}', String(tile.column)).replace('{y}', String(tile.row));
            const response = await fetchImage(url, {signal: controller.signal});
            reader = response.body?.getReader();
            controller.signal.throwIfAborted();
            if (!response.ok) throw new Error(`Terrain HTTP ${response.status}`);
            const declared = response.headers.get('content-length');
            if (declared !== null && Number(declared) > maxBytes) throw new Error('Terrain image exceeds compressed byte limit');
            if (!reader) throw new Error('Terrain response has no readable body');
            let target = new Uint8Array(Math.min(maxBytes, 65536));
            let length = 0;
            while (true) {
                const {value, done} = await reader.read();
                controller.signal.throwIfAborted();
                if (done) break;
                const nextLength = length + value.byteLength;
                if (nextLength > maxBytes) throw new Error('Terrain image exceeds compressed byte limit');
                if (nextLength > target.length) {
                    const expanded = new Uint8Array(Math.min(maxBytes, Math.max(nextLength, target.length * 2)));
                    expanded.set(target); target = expanded;
                }
                target.set(value, length); length = nextLength;
            }
            if (!length) throw new Error('Terrain image is empty');
            return target.buffer.slice(0, length);
        } finally {
            clearTimeout(timeout); signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', cancelBody);
            // Closing a stream is synchronous; its underlying cancel promise may
            // never settle. Cleanup must not keep a queue slot past the deadline.
            void reader?.cancel().catch(() => {}); reader?.releaseLock();
        }
    }});
}

/** Preserve Mapterhorn's explicit provider coverage and dataset acknowledgements. */
export function createMapterhornTerrainSource(): TerrainImageSource {
    return createTerrainImageSource({id: 'mapterhorn-terrarium', urlTemplate: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp', credits: [
        {label: 'Mapterhorn', url: 'https://mapterhorn.com/'},
        {label: 'swissALTI3D / swisstopo', url: 'https://www.swisstopo.admin.ch/en/height-model-swissalti3d'},
        {label: 'all data sources and attribution', url: 'https://mapterhorn.com/attribution/'}
    ]});
}

/** Prevent unsafe schemes or implicit embedded credentials in source/credit links. */
function validateUrl(value: string): void {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Terrain URLs must use HTTP(S) without embedded credentials');
}
