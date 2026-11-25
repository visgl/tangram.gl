// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {LayerProps} from '@deck.gl/core';
import {getBasemapFetch, getBasemapLayerFetch as getProtocolLayerFetch, type BasemapRequestType} from './basemap-protocol';

/**
 * The kind of resource a request is for, with the names of MapLibre GL JS's `ResourceType`:
 * `'Style'` for the style document, `'Source'` for a TileJSON and for the `data` URL of a GeoJSON
 * source, `'Tile'` for a vector, raster or raster-dem tile, `'Glyphs'` for a glyph range,
 * `'SpriteJSON'` and `'SpriteImage'` for the sprite index and image.
 */
export type BasemapResourceType =
  | 'Unknown'
  | 'Style'
  | 'Source'
  | 'Tile'
  | 'Glyphs'
  | 'SpriteImage'
  | 'SpriteJSON'
  | 'Image';

/**
 * The request that a {@link BasemapTransformRequest} returns, as MapLibre GL JS's
 * `RequestParameters`. Each field that is set replaces the field of the same name in the request;
 * `headers` are merged into the request's headers by name.
 */
export type BasemapTransformedRequest = {
  /** The URL to request in place of the original URL. */
  url: string;
  /** Headers to add to the request, or to replace in it. */
  headers?: HeadersInit;
  /** The request method. */
  method?: string;
  /** The request body. */
  body?: BodyInit | null;
  /** The credentials mode of the request, such as `'include'` to send cookies to another origin. */
  credentials?: RequestCredentials;
  /** The cache mode of the request. */
  cache?: RequestCache;
  /** Accepted for MapLibre GL JS compatibility; not used. */
  type?: string;
  /** Accepted for MapLibre GL JS compatibility; not used. */
  collectResourceTiming?: boolean;
};

/**
 * Changes a request before it is sent, as MapLibre GL JS's `transformRequest` map option: receives
 * the absolute URL and the kind of resource, and returns the URL and request fields to use, or
 * nothing to send the request as it is.
 */
export type BasemapTransformRequest = (
  url: string,
  resourceType: BasemapResourceType
) => BasemapTransformedRequest | null | undefined | void;

/** The request fields a transformed request can set, other than its URL and headers. */
const REQUEST_FIELDS = ['method', 'body', 'credentials', 'cache'] as const;

/**
 * Applies `transformRequest` to a request: the URL to send, and `init` with the fields of the
 * transformed request. Without `transformRequest`, or when it returns nothing, the URL and `init`
 * are returned as they are. The `signal` of `init` is always kept.
 */
export function transformBasemapRequest(
  transformRequest: BasemapTransformRequest | null | undefined,
  url: string,
  resourceType: BasemapResourceType,
  init?: RequestInit
): {url: string; init: RequestInit | undefined} {
  const request = transformRequest?.(url, resourceType);
  if (!request) {
    return {url, init};
  }
  const nextInit: RequestInit = {...init};
  for (const field of REQUEST_FIELDS) {
    if (request[field] !== undefined) {
      (nextInit as Record<string, unknown>)[field] = request[field];
    }
  }
  if (request.headers !== undefined) {
    const headers = new Headers(init?.headers);
    new Headers(request.headers).forEach((value, name) => headers.set(name, value));
    nextInit.headers = headers;
  }
  return {url: typeof request.url === 'string' && request.url ? request.url : url, init: nextInit};
}

/**
 * A `fetch` for one kind of resource: it applies `transformRequest` to each request, then sends
 * it with `fetch`, or with the global `fetch` without one.
 */
export function getBasemapRequestFetch(
  resourceType: BasemapResourceType,
  {
    fetch: fetchFn,
    transformRequest
  }: {fetch?: typeof fetch; transformRequest?: BasemapTransformRequest | null} = {}
): typeof fetch {
  const send = fetchFn || ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  if (!transformRequest) {
    return send;
  }
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('pmtiles://')) {
      return send(input, init);
    }
    const request = transformBasemapRequest(transformRequest, url, resourceType, init);
    return send(request.url, request.init);
  };
}

/** A deck.gl layer `fetch` prop. */
type LayerFetch = NonNullable<LayerProps['fetch']>;

/** The context deck.gl passes to a layer's `fetch` prop. */
type LayerFetchContext = Parameters<LayerFetch>[1];

const layerFetches = new WeakMap<BasemapTransformRequest, WeakMap<LayerFetch, LayerFetch>>();

/**
 * A deck.gl layer `fetch` prop for tiles that applies `transformRequest` to each tile URL, then
 * loads the tile with `nextFetch`. The fields of the transformed request are added to each
 * request that the loaders make, through the `fetch` of the loader options. Returns `nextFetch`
 * without `transformRequest`, and the same function for the same arguments, so that the props of
 * a tile layer stay equal.
 */
export function getBasemapLayerFetch(
  nextFetch: LayerFetch,
  transformRequest: BasemapTransformRequest | null | undefined
): LayerFetch {
  if (!transformRequest) {
    return nextFetch;
  }
  let byFetch = layerFetches.get(transformRequest);
  if (!byFetch) {
    byFetch = new WeakMap();
    layerFetches.set(transformRequest, byFetch);
  }
  let layerFetch = byFetch.get(nextFetch);
  if (!layerFetch) {
    layerFetch = (url, context) => {
      if (url.startsWith('pmtiles://')) {
        return nextFetch(url, context);
      }
      const request = transformBasemapRequest(transformRequest, url, 'Tile');
      if (!request.init || Object.keys(request.init).length === 0) {
        return nextFetch(request.url, context);
      }
      return nextFetch(request.url, {
        ...context,
        loadOptions: getRequestLoadOptions(context, request.init)
      });
    };
    byFetch.set(nextFetch, layerFetch);
  }
  return layerFetch;
}

/**
 * The loader options of a tile request, with a `fetch` that adds the fields of `requestInit` to
 * the request. The loader options' own `fetch` sends it, as a function, or as the request options
 * it gives as an object; the request keeps the tile's abort signal.
 */
function getRequestLoadOptions(context: LayerFetchContext, requestInit: RequestInit): any {
  const loadOptions = context.loadOptions || context.layer.getLoadOptions();
  const baseFetch = loadOptions?.fetch ?? loadOptions?.core?.fetch;
  const send: typeof fetch =
    typeof baseFetch === 'function'
      ? baseFetch
      : (input, init) =>
          globalThis.fetch(input, {...(baseFetch as RequestInit | undefined), ...init});
  const requestFetch: typeof fetch = (input, init) => {
    const signal = init?.signal ?? context.signal;
    const headers = new Headers(init?.headers);
    new Headers(requestInit.headers).forEach((value, name) => headers.set(name, value));
    return send(input, {
      ...init,
      ...requestInit,
      headers,
      ...(signal ? {signal} : {})
    });
  };
  const fetchOptions = {...loadOptions?.fetchOptions, ...requestInit};
  const headers = new Headers(loadOptions?.fetchOptions?.headers);
  new Headers(requestInit.headers).forEach((value, name) => headers.set(name, value));
  fetchOptions.headers = headers;
  return {...loadOptions, fetchOptions, fetch: requestFetch};
}

/** Applies the request transformation before protocol dispatch for a resource. */
export function getBasemapResourceFetch(
  resourceType: BasemapResourceType,
  type: BasemapRequestType,
  options: {fetch?: typeof fetch; transformRequest?: BasemapTransformRequest | null} = {}
): typeof fetch {
  return getBasemapRequestFetch(resourceType, {
    fetch: getBasemapFetch(options.fetch, type),
    transformRequest: options.transformRequest
  });
}

/** Applies the request transformation before protocol dispatch for a tile. */
export function getBasemapTileFetch(
  nextFetch: LayerFetch,
  type: BasemapRequestType,
  transformRequest: BasemapTransformRequest | null | undefined
): LayerFetch {
  return getBasemapLayerFetch(getProtocolLayerFetch(nextFetch, type), transformRequest);
}
