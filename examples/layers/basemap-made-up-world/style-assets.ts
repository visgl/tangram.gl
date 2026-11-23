// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The sprite and glyphs of the antique style, loaded through the `antique-assets://` protocol.

import type {BasemapProtocolHandler} from '@tangram.gl/basemap-layers';
import {FONT_ITALIC, FONT_ROMAN, type AntiqueStyleAssets} from './world-style';

/** The protocol scheme of the style's assets. */
export const ASSET_SCHEME = 'antique-assets';

/**
 * The style names its sprite and glyphs with this prefix. Bundlers give the asset files hashed
 * names, so the handler maps each name to the URL that the bundler gives the file.
 */
export const ASSET_PREFIX = `${ASSET_SCHEME}://local/`;

export const ANTIQUE_STYLE_ASSETS: AntiqueStyleAssets = {
  sprite: `${ASSET_PREFIX}sprite`,
  glyphs: `${ASSET_PREFIX}glyphs/{fontstack}/{range}.pbf`
};

/**
 * The asset files, by the path after `ASSET_PREFIX`. The generated names are ASCII, so only the
 * glyph range 0-255 of each font is included.
 */
export const ASSET_URLS: Record<string, string> = {
  'sprite.json': new URL('./assets/sprite.json', import.meta.url).href,
  'sprite.png': new URL('./assets/sprite.png', import.meta.url).href,
  'sprite@2x.json': new URL('./assets/sprite@2x.json', import.meta.url).href,
  'sprite@2x.png': new URL('./assets/sprite@2x.png', import.meta.url).href,
  [`glyphs/${FONT_ROMAN}/0-255.pbf`]: new URL('./assets/glyphs/roman/0-255.pbf', import.meta.url)
    .href,
  [`glyphs/${FONT_ITALIC}/0-255.pbf`]: new URL('./assets/glyphs/italic/0-255.pbf', import.meta.url)
    .href
};

/**
 * Loads the asset of an `antique-assets://local/...` URL. A glyph range that the example does not
 * include is an empty resource, so its characters draw nothing, as with a missing range in
 * MapLibre GL JS.
 */
export const antiqueAssetHandler: BasemapProtocolHandler = async (
  {url},
  abortController
) => {
  const path = decodeURIComponent(url.slice(ASSET_PREFIX.length).split(/[?#]/)[0]);
  const assetUrl = ASSET_URLS[path];
  if (!assetUrl) {
    if (path.startsWith('glyphs/')) return {data: null};
    throw new Error(`The antique style has no asset "${path}"`);
  }
  const response = await fetch(assetUrl, {signal: abortController.signal});
  if (!response.ok) throw new Error(`${url} did not load (HTTP ${response.status})`);
  return {data: await response.arrayBuffer()};
};
