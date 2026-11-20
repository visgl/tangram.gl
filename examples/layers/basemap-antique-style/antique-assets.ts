// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {FONT_ITALIC, FONT_ROMAN, type AntiqueStyleAssets} from './antique-style';

/**
 * The style names its sprite and glyphs with this prefix. Bundlers give the asset files hashed
 * names, so `resolveAssetUrl` maps each name to the URL that the bundler gives the file.
 */
export const ASSET_PREFIX = 'antique-assets://local/';

export const ANTIQUE_STYLE_ASSETS: AntiqueStyleAssets = {
  sprite: `${ASSET_PREFIX}sprite`,
  glyphs: `${ASSET_PREFIX}glyphs/{fontstack}/{range}.pbf`
};

/** A glyph range of no glyphs, for the ranges that the example does not include. */
const EMPTY_GLYPH_RANGE = 'data:application/x-protobuf;base64,';

/** The asset files of the example, by the path after `ASSET_PREFIX`. */
export const ASSET_URLS: Record<string, string> = {
  'sprite.json': new URL('./assets/sprite.json', import.meta.url).href,
  'sprite.png': new URL('./assets/sprite.png', import.meta.url).href,
  'sprite@2x.json': new URL('./assets/sprite@2x.json', import.meta.url).href,
  'sprite@2x.png': new URL('./assets/sprite@2x.png', import.meta.url).href,
  [`glyphs/${FONT_ROMAN}/0-255.pbf`]: new URL('./assets/glyphs/roman/0-255.pbf', import.meta.url)
    .href,
  [`glyphs/${FONT_ROMAN}/256-511.pbf`]: new URL(
    './assets/glyphs/roman/256-511.pbf',
    import.meta.url
  ).href,
  [`glyphs/${FONT_ITALIC}/0-255.pbf`]: new URL('./assets/glyphs/italic/0-255.pbf', import.meta.url)
    .href,
  [`glyphs/${FONT_ITALIC}/256-511.pbf`]: new URL(
    './assets/glyphs/italic/256-511.pbf',
    import.meta.url
  ).href
};

/**
 * The URL to load for a URL of the style. Returns other URLs unchanged. A glyph range that the
 * example does not include resolves to an empty range, so its characters draw nothing, as with a
 * missing range in MapLibre GL JS.
 */
export function resolveAssetUrl(url: string): string {
  if (!url.startsWith(ASSET_PREFIX)) {
    return url;
  }
  const path = decodeURIComponent(url.slice(ASSET_PREFIX.length).split(/[?#]/)[0]);
  const resolved = ASSET_URLS[path];
  if (resolved) {
    return resolved;
  }
  if (path.startsWith('glyphs/')) {
    return EMPTY_GLYPH_RANGE;
  }
  throw new Error(`The antique style has no asset "${path}"`);
}

/** A `fetch` for `BasemapLayer`'s `loadOptions`, which loads the style's assets. */
export function createAssetFetch(onError: (message: string) => void): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ASSET_PREFIX)) {
      return fetch(input, init);
    }
    try {
      const response = await fetch(resolveAssetUrl(url), init);
      if (!response.ok) {
        onError(`${url} did not load (HTTP ${response.status})`);
      }
      return response;
    } catch (error) {
      onError(`${url} did not load: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
}
