// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Legacy compatibility envelope; network bookkeeping is not reusable decoded content. */
export interface TileSourceData {
    /** Postprocessed source layers, shared by the existing overzoom path. */
    layers?: Record<string, unknown>;
    /** Legacy cancellation identity. */
    request_id?: string | null;
    /** Resolved provider error, retained for the legacy warn-and-continue path. */
    error?: string | null;
    /** Resolved source URL. */
    url?: string;
}

/** Worker-side structural surface; no scene, styles or GPU content. */
export interface TileDataContext {
    /** Temporary legacy data facade used by existing parsers and transforms. */
    source_data?: TileSourceData;
    /** Attached raster identities. */
    rasters?: string[];
    /** Seam padding already applied during postprocessing. */
    pad_scale?: number;
    /** Source polygon winding after postprocessing. */
    default_winding?: string | null;
}

/** Reusable decoded content, deliberately excluding URLs, errors and cancellation IDs. */
export interface DecodedTilePayload {
    /** Tangram-local layer references (4096-unit tiles, negative local Y); not geographic GeoJSON. */
    readonly layers?: Record<string, unknown>;
    /** Detached list of attached raster sources. */
    readonly rasters: readonly string[];
    /** Seam padding retained when rebinding content to a style/build tile. */
    readonly padScale?: number;
    /** Polygon winding retained when rebinding content. */
    readonly defaultWinding?: string | null;
    /** Optional decoded-content allocation estimate supplied by an owning adapter, never encoded response bytes. */
    readonly byteLength?: number;
}

/** Per-request mutable state, never shared with an overzoom payload. */
export interface TileSourceRequestState {
    /** Source-owned cancellation hook for providers that do not use legacy XHR request IDs. */
    cancel?: () => void;
    /** Legacy cancellation identity, when a provider exposes one. */
    requestId?: string | null;
    /** Resolved provider error, distinct from a thrown/rejected load. */
    error?: string | null;
    /** Resolved source URL. */
    url?: string;
}

/** Request records follow context lifetime without entering worker messages. */
const requestStates = new WeakMap<TileDataContext, TileSourceRequestState>();
/** Decoded records follow context lifetime without retaining evicted worker tiles. */
const payloads = new WeakMap<TileDataContext, DecodedTilePayload>();
/** Aborted aligned requests can cancel IDs assigned after asynchronous URL resolution. */
const cancellationListeners = new WeakMap<TileDataContext, () => void>();

/** Read request state, including writes by an unmodified custom legacy source. */
export function getTileSourceRequest(context: TileDataContext): TileSourceRequestState {
    const state = requestStates.get(context) ?? {};
    const legacy = context.source_data;
    state.requestId = legacy?.request_id;
    state.error = legacy?.error;
    state.url = legacy?.url;
    requestStates.set(context, state);
    return state;
}

/** Write separated request state and preserve the legacy parser/cancellation facade. */
export function updateTileSourceRequest(context: TileDataContext, changes: Partial<TileSourceRequestState>): void {
    const state = getTileSourceRequest(context);
    Object.assign(state, changes);
    const legacy = context.source_data ??= {};
    if ('requestId' in changes) legacy.request_id = changes.requestId;
    if ('error' in changes) legacy.error = changes.error;
    if ('url' in changes) legacy.url = changes.url;
    if (changes.requestId || changes.cancel) cancellationListeners.get(context)?.();
}

/** Keep a cancellation hook attached until the legacy load settles, including late request IDs. */
export function bindTileSourceCancellation(context: TileDataContext, cancel: () => void): () => void {
    cancellationListeners.set(context, cancel);
    return () => { if (cancellationListeners.get(context) === cancel) cancellationListeners.delete(context); };
}

/** Publish postprocessed content without cloning or freezing legacy feature objects. */
export function captureTilePayload(context: TileDataContext): DecodedTilePayload {
    const payload: DecodedTilePayload = {layers: context.source_data?.layers,
        rasters: [...(context.rasters ?? [])], padScale: context.pad_scale, defaultWinding: context.default_winding};
    getTileSourceRequest(context);
    payloads.set(context, payload);
    return payload;
}

/** Retrieve the last decoded publication, without retaining request/build state in the payload. */
export function getTilePayload(context: TileDataContext): DecodedTilePayload | undefined {
    return payloads.get(context);
}

/** Bind reusable content to a new build context with fresh request state. */
export function applyTilePayload(context: TileDataContext, payload: DecodedTilePayload): void {
    context.source_data = {layers: payload.layers};
    context.rasters = [...payload.rasters];
    context.pad_scale = payload.padScale;
    context.default_winding = payload.defaultWinding;
    requestStates.set(context, {});
    payloads.set(context, payload);
}
