// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {SharedMVTLayer} from '@deck.gl-community/geo-layers';
import {Layer, type LayerProps} from '@deck.gl/core';
import {parse} from '@loaders.gl/core';

/**
 * The kind of resource a request expects, as MapLibre GL JS's `RequestParameters.type`: `'json'`
 * for a style, a TileJSON, a sprite index or GeoJSON data, `'arrayBuffer'` for a vector tile or a
 * glyph range, `'image'` for a raster or raster-dem tile or a sprite image.
 */
export type BasemapRequestType = 'string' | 'json' | 'arrayBuffer' | 'image';

/** The request a protocol handler receives, shaped as MapLibre GL JS's `RequestParameters`. */
export type BasemapRequestParameters = {
  /** The URL requested, with its scheme. */
  url: string;
  /** The kind of resource expected. */
  type: BasemapRequestType;
  /** The headers of the request's `fetchOptions`. */
  headers?: HeadersInit;
  /** The method of the request's `fetchOptions`. */
  method?: string;
  /** The body of the request's `fetchOptions`. */
  body?: BodyInit | null;
  /** The credentials mode of the request's `fetchOptions`. */
  credentials?: RequestCredentials;
  /** The cache mode of the request's `fetchOptions`. */
  cache?: RequestCache;
};

/** What a protocol handler resolves with, as MapLibre GL JS's `GetResourceResponse`. */
export type BasemapResourceResponse = {
  /**
   * The resource: an `ArrayBuffer`, a typed array or a `Blob` of its bytes (an image is its
   * encoded bytes), a string, or, for a `'json'` request, the parsed JSON value. `null` or
   * `undefined` is an empty resource, such as a tile without data.
   */
  data: unknown;
  /** Accepted for MapLibre GL JS compatibility; not used. */
  cacheControl?: string | null;
  /** Accepted for MapLibre GL JS compatibility; not used. */
  expires?: string | Date | null;
};

/**
 * Loads the resource of a URL with a registered scheme. `abortController` aborts when the request
 * is cancelled, for example when deck.gl no longer needs a tile. The same function works as a
 * MapLibre GL JS `addProtocol` handler.
 */
export type BasemapProtocolHandler = (
  requestParameters: BasemapRequestParameters,
  abortController: AbortController
) => Promise<BasemapResourceResponse>;

/** Schemes that load with `fetch` and are never given to a handler, as in MapLibre GL JS. */
const FETCH_SCHEMES = new Set(['http', 'https', 'file']);

const SCHEME = /^[a-z][a-z\d+.-]*$/i;

const protocols = new Map<string, BasemapProtocolHandler>();

/**
 * Loads every URL `<scheme>://...` that `BasemapLayer` requests with `handler`: the style, TileJSON,
 * vector, raster and raster-dem tiles, sprites, glyphs and GeoJSON data. A second registration of
 * the same scheme replaces the first. As in MapLibre GL JS, `http`, `https` and `file` URLs always
 * load with `fetch`.
 */
export function registerBasemapProtocol(scheme: string, handler: BasemapProtocolHandler): void {
  if (!SCHEME.test(scheme)) {
    throw new Error(`Invalid basemap protocol scheme "${scheme}": give the scheme without "://"`);
  }
  if (FETCH_SCHEMES.has(scheme.toLowerCase())) {
    throw new Error(`The basemap protocol scheme "${scheme}" always loads with fetch`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`The handler of basemap protocol "${scheme}" is not a function`);
  }
  protocols.set(scheme.toLowerCase(), handler);
}

/** Removes the handler of `scheme`. Its URLs then fail to load. */
export function unregisterBasemapProtocol(scheme: string): void {
  protocols.delete(scheme.toLowerCase());
}

/** The scheme of a URL `<scheme>://...` that does not load with `fetch`, or null. */
function getCustomScheme(url: string): string | null {
  const end = url.indexOf('://');
  if (end <= 0) {
    return null;
  }
  const scheme = url.slice(0, end).toLowerCase();
  return SCHEME.test(scheme) && !FETCH_SCHEMES.has(scheme) ? scheme : null;
}

/**
 * Whether `url` is `<scheme>://...` with a scheme other than `http`, `https` and `file`: a URL that
 * only a protocol handler loads.
 */
export function hasCustomScheme(url: string): boolean {
  return getCustomScheme(url) !== null;
}

/** Whether `url` has a scheme with a registered handler. Such a URL is not resolved against a base. */
export function isBasemapProtocolUrl(url: unknown): url is string {
  if (typeof url !== 'string') {
    return false;
  }
  const scheme = getCustomScheme(url);
  return scheme !== null && protocols.has(scheme);
}

function getUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function getAbortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Calls the handler of a URL's scheme. The handler's abort controller aborts with `init.signal`,
 * and the request rejects at once when it does, even if the handler ignores the abort.
 */
async function requestProtocolResource(
  handler: BasemapProtocolHandler,
  url: string,
  type: BasemapRequestType,
  init?: RequestInit
): Promise<unknown> {
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) {
    throw getAbortError(signal);
  }
  const abortController = new AbortController();
  const requestParameters: BasemapRequestParameters = {url, type};
  for (const key of ['headers', 'method', 'body', 'credentials', 'cache'] as const) {
    if (init?.[key] !== undefined) {
      (requestParameters as Record<string, unknown>)[key] = init[key];
    }
  }
  if (!signal) {
    return (await handler(requestParameters, abortController))?.data;
  }
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      abortController.abort(signal.reason);
      reject(getAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, {once: true});
  });
  try {
    const response = await Promise.race([handler(requestParameters, abortController), aborted]);
    return response?.data;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function isBinary(data: unknown): data is ArrayBuffer | ArrayBufferView | Blob {
  return (
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    (typeof Blob !== 'undefined' && data instanceof Blob)
  );
}

/** The data a handler resolved with, as the body of a `Response`. */
function getResponseBody(url: string, type: BasemapRequestType, data: unknown): BodyInit | null {
  if (data === null || data === undefined || typeof data === 'string' || isBinary(data)) {
    return (data ?? null) as BodyInit | null;
  }
  if (type === 'json' && typeof data === 'object') {
    return JSON.stringify(data);
  }
  throw new Error(
    `The basemap protocol handler of ${url} returned ${Object.prototype.toString.call(data)}; ` +
      'return bytes, a string or, for a json request, a JSON value'
  );
}

function getUnregisteredSchemeError(scheme: string, url: string): Error {
  return new Error(
    `No basemap protocol is registered for "${scheme}://" (${url}). ` +
      `Call registerBasemapProtocol('${scheme}', handler) first.`
  );
}

/**
 * A `fetch` that loads URLs with a registered scheme with their handler, as a `Response`, and
 * every other URL with `fetchFn`, or the global `fetch` without one. Without `fetchFn`, a URL
 * with another scheme than `http`, `https` and `file` and no handler fails with an error that names
 * the scheme.
 */
export function getBasemapFetch(
  fetchFn: typeof fetch | undefined,
  type: BasemapRequestType
): typeof fetch {
  return async (input, init) => {
    const url = getUrl(input);
    const scheme = getCustomScheme(url);
    const handler = scheme ? protocols.get(scheme) : undefined;
    if (handler) {
      const data = await requestProtocolResource(handler, url, type, init);
      return new Response(getResponseBody(url, type, data), {status: 200});
    }
    if (scheme && !fetchFn) {
      throw getUnregisteredSchemeError(scheme, url);
    }
    return fetchFn ? fetchFn(input, init) : globalThis.fetch(input, init);
  };
}

/** A deck.gl layer `fetch` prop. */
export type BasemapLayerFetch = NonNullable<LayerProps['fetch']>;

/** The context deck.gl passes to a layer's `fetch` prop. */
type LayerFetchContext = Parameters<BasemapLayerFetch>[1];

const layerFetches = new Map<BasemapRequestType, WeakMap<BasemapLayerFetch, BasemapLayerFetch>>();

/**
 * A deck.gl layer `fetch` prop that loads URLs with a registered scheme with their handler, then
 * parses the bytes with the layer's loaders, and every other URL with `nextFetch`. A tile that
 * deck.gl cancels aborts the handler. The same function is returned for the same `nextFetch` and
 * `type`, so that a layer's props stay equal.
 */
export function getBasemapLayerFetch(
  nextFetch: BasemapLayerFetch,
  type: BasemapRequestType
): BasemapLayerFetch {
  let byFetch = layerFetches.get(type);
  if (!byFetch) {
    byFetch = new WeakMap();
    layerFetches.set(type, byFetch);
  }
  let layerFetchWithProtocols = byFetch.get(nextFetch);
  if (!layerFetchWithProtocols) {
    layerFetchWithProtocols = (url, context) => {
      const scheme = typeof url === 'string' ? getCustomScheme(url) : null;
      const handler = scheme ? protocols.get(scheme) : undefined;
      if (handler) {
        return loadProtocolTile(handler, url, type, context);
      }
      if (
        scheme &&
        isDefaultLayerFetch(nextFetch) &&
        typeof getLayerLoadOptions(context)?.fetch !== 'function'
      ) {
        return Promise.reject(getUnregisteredSchemeError(scheme, url));
      }
      return nextFetch(url, context);
    };
    byFetch.set(nextFetch, layerFetchWithProtocols);
  }
  return layerFetchWithProtocols;
}

/** deck.gl's default layer `fetch`, which loads with loaders.gl and the global `fetch`. */
export const DEFAULT_LAYER_FETCH = (Layer.defaultProps as {fetch: {value: BasemapLayerFetch}})
  .fetch.value;

/** `SharedMVTLayer`'s default `fetch`, which also loads without a deck.gl context. */
export const DEFAULT_MVT_FETCH = (SharedMVTLayer.defaultProps as {fetch: BasemapLayerFetch}).fetch;

/** Whether a layer `fetch` loads with the global `fetch`, which cannot load a custom scheme. */
function isDefaultLayerFetch(layerFetch: BasemapLayerFetch): boolean {
  return layerFetch === DEFAULT_LAYER_FETCH || layerFetch === DEFAULT_MVT_FETCH;
}

/** The loaders.gl options of a layer `fetch` call, as deck.gl's default `fetch` takes them. */
function getLayerLoadOptions(context: LayerFetchContext): any {
  return context.loadOptions || context.layer.getLoadOptions();
}

/** Loads a tile with a protocol handler and parses it; an empty resource is a tile without data. */
async function loadProtocolTile(
  handler: BasemapProtocolHandler,
  url: string,
  type: BasemapRequestType,
  context: LayerFetchContext
): Promise<unknown> {
  const loadOptions = getLayerLoadOptions(context);
  const data = await requestProtocolResource(handler, url, type, {
    ...loadOptions?.fetchOptions,
    signal: context.signal
  });
  const body = getResponseBody(url, type, data);
  const bytes =
    typeof Blob !== 'undefined' && body instanceof Blob
      ? await body.arrayBuffer()
      : ArrayBuffer.isView(body)
        ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
        : body;
  if (bytes === null || bytes === '' || (bytes instanceof ArrayBuffer && bytes.byteLength === 0)) {
    return null;
  }
  return parse(
    bytes as ArrayBuffer | string,
    context.loaders || context.layer.props.loaders,
    loadOptions
  );
}
