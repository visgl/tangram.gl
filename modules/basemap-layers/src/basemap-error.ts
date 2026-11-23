// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** The resource of a style that failed to load (see {@link BasemapLoadError}). */
export type BasemapLoadErrorKind = 'style' | 'source' | 'tile' | 'sprite' | 'glyphs' | 'image';

/** What a {@link BasemapLoadError} tells about the resource that failed. */
export type BasemapLoadErrorDetails = {
  /** The style source of a `source`, `tile` or `image` failure. */
  sourceId?: string;
  /** The URL that failed, when it is known. */
  url?: string;
  /** The HTTP status of the response, when the server answered. */
  status?: number;
  /** The index of the tile, for a `tile` failure. */
  tile?: {x: number; y: number; z: number};
};

/**
 * A resource of the style that failed to load. `BasemapLayer` gives it to deck.gl's `onError`
 * layer prop, and then to the `onError` of the `Deck`. It carries the fields of MapLibre GL JS's
 * `error` event (`sourceId`, `tile`), and the error the load failed with as `cause`.
 */
export class BasemapLoadError extends Error implements BasemapLoadErrorDetails {
  /** What failed to load. */
  readonly kind: BasemapLoadErrorKind;
  readonly sourceId?: string;
  readonly url?: string;
  readonly status?: number;
  readonly tile?: {x: number; y: number; z: number};
  /** The error the load failed with. */
  declare readonly cause: Error;

  constructor(kind: BasemapLoadErrorKind, cause: Error, details: BasemapLoadErrorDetails = {}) {
    const source = details.sourceId ? ` of source "${details.sourceId}"` : '';
    const url = details.url ? ` ${details.url}` : '';
    super(`Failed to load ${kind}${source}${url}: ${cause.message}`, {cause});
    this.name = 'BasemapLoadError';
    this.kind = kind;
    Object.assign(this, details);
  }
}

/** Receives each resource of the style that fails to load. */
export type BasemapLoadErrorHandler = (error: BasemapLoadError) => void;

/** A response with an error status: keeps the URL and status for {@link BasemapLoadError}. */
export class BasemapFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'BasemapFetchError';
  }
}

/** Whether `error` is a cancelled request, which is not a load failure. */
export function isAbortError(error: unknown): boolean {
  return (error as Error | null)?.name === 'AbortError';
}

/**
 * The load error of a failure. The URL and status come from `error` when it has them, such as a
 * {@link BasemapFetchError} or a loaders.gl `FetchError`.
 */
export function getBasemapLoadError(
  kind: BasemapLoadErrorKind,
  error: unknown,
  details: BasemapLoadErrorDetails = {}
): BasemapLoadError {
  const cause = error as {url?: unknown; status?: unknown; response?: {status?: unknown}} | null;
  const url = typeof cause?.url === 'string' && cause.url ? cause.url : details.url;
  const status = cause?.status ?? cause?.response?.status;
  return new BasemapLoadError(kind, error instanceof Error ? error : new Error(String(error)), {
    ...details,
    ...(url ? {url} : {}),
    ...(typeof status === 'number' ? {status} : {})
  });
}
