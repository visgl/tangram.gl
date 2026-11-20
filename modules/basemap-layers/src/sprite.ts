// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {log} from '@deck.gl/core';
import {getBasemapResourceFetch} from './basemap-request';
import {isBasemapProtocolUrl} from './basemap-protocol';
import {getIconQuads, isValidStretchMetadata} from './icon-text-fit';
import type {ImageTextFit} from './icon-text-fit';
import type {BasemapLoadOptions} from './style-resolver';

/** One image in a style sprite, as listed in the sprite's JSON index. */
export type SpriteImage = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Device pixels per CSS pixel of the image. Default 1. */
  pixelRatio?: number;
  /** `true` for signed-distance-field images, which are tinted with `icon-color`. */
  sdf?: boolean;
} & SpriteStretchMetadata;

/**
 * How `icon-text-fit` stretches an image, in image pixels, as MapLibre GL JS reads it from the
 * sprite's JSON index (see `icon-text-fit.ts`).
 */
export type SpriteStretchMetadata = {
  /** Ranges `[x1, x2]` of image columns that stretch. */
  stretchX?: [number, number][];
  /** Ranges `[y1, y2]` of image rows that stretch. */
  stretchY?: [number, number][];
  /** `[x1, y1, x2, y2]`: the part of the image that the label covers. */
  content?: [number, number, number, number];
  /** How the width may change to keep the aspect ratio of `content`. */
  textFitWidth?: ImageTextFit;
  /** How the height may change to keep the aspect ratio of `content`. */
  textFitHeight?: ImageTextFit;
};

/** A deck.gl `IconLayer` mapping entry for one sprite image. */
export type SpriteIconMappingEntry = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** `true` for SDF images: deck.gl tints masked icons with `getColor`. */
  mask: boolean;
  /** Device pixels per CSS pixel; `icon-size` scales `height / pixelRatio`. */
  pixelRatio: number;
} & SpriteStretchMetadata;

/** A loaded sprite: the atlas image and its deck.gl icon mapping. */
export type SpriteAtlas = {
  /**
   * Sprite id. `'default'` for a style whose `sprite` is a single URL; otherwise the id from the
   * style's sprite array, which prefixes its image names as `id:name`.
   */
  id: string;
  /**
   * The atlas image, decoded once and shared by every icon layer, or its URL where
   * `createImageBitmap` is unavailable (each `IconLayer` then loads the URL itself).
   */
  image: ImageBitmap | string;
  /** Icon mapping keyed by image name, without the `id:` prefix. */
  mapping: Record<string, SpriteIconMappingEntry>;
};

/** A style's `sprite` value: a URL, or the array form with one `{id, url}` per sprite. */
export type StyleSprite = string | Array<{id: string; url: string}>;

/** A sprite source after relative URLs are resolved. */
export type SpriteSource = {id: string; url: string};

/** Options for {@link loadSpriteAtlases}. */
export type SpriteLoadOptions = {
  /** Base URL that relative sprite URLs resolve against, normally the style URL. */
  baseUrl?: string;
  /** Device pixel ratio. At 2 or more, the `@2x` sprite is requested first. Default 1. */
  pixelRatio?: number;
} & Pick<NonNullable<BasemapLoadOptions>, 'fetch' | 'fetchOptions' | 'transformRequest'>;

/** Resolves a style's `sprite` value into sprite sources with absolute URLs. */
export function getSpriteSources(sprite: unknown, baseUrl?: string): SpriteSource[] {
  const resolve = (url: string) => {
    if (isBasemapProtocolUrl(url)) {
      return url;
    }
    try {
      return new URL(url, baseUrl).toString();
    } catch {
      return url;
    }
  };
  if (typeof sprite === 'string' && sprite) {
    return [{id: 'default', url: resolve(sprite)}];
  }
  if (Array.isArray(sprite)) {
    return sprite
      .filter(entry => entry && typeof entry.id === 'string' && typeof entry.url === 'string')
      .map(entry => ({id: entry.id, url: resolve(entry.url)}));
  }
  return [];
}

const STRETCH_METADATA_KEYS = [
  'stretchX',
  'stretchY',
  'content',
  'textFitWidth',
  'textFitHeight'
] as const;

/**
 * Converts a sprite JSON index into a deck.gl `IconLayer` mapping. An image's stretch metadata is
 * kept for `icon-text-fit`. As in MapLibre, an image whose stretch zones or content do not lie in
 * order inside it is left out, with a warning.
 */
export function getSpriteIconMapping(
  index: Record<string, SpriteImage>
): Record<string, SpriteIconMappingEntry> {
  const mapping: Record<string, SpriteIconMappingEntry> = {};
  for (const [name, image] of Object.entries(index || {})) {
    const entry: SpriteIconMappingEntry = {
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
      mask: Boolean(image.sdf),
      pixelRatio: image.pixelRatio || 1
    };
    for (const key of STRETCH_METADATA_KEYS) {
      if (image[key] !== undefined) {
        (entry as any)[key] = image[key];
      }
    }
    if (!isValidStretchMetadata(entry)) {
      log.warn(`[BasemapLayer] Sprite image "${name}" has invalid stretch metadata; skipped`)();
      continue;
    }
    mapping[name] = entry;
  }
  return mapping;
}

/**
 * Decodes the atlas PNG once, so the per-tile icon layers share one image instead of each
 * requesting it. Without `createImageBitmap` (e.g. in Node), returns the URL. The image is decoded
 * unpremultiplied, as deck.gl decodes the images it loads itself: the icon layers blend its
 * colors with their alpha, so premultiplied colors would darken every translucent pixel twice.
 */
async function loadSpriteImage(
  url: string,
  fetchFn: typeof fetch,
  fetchOptions?: RequestInit
): Promise<ImageBitmap | string> {
  if (typeof createImageBitmap !== 'function') {
    return url;
  }
  const response = await fetchFn(url, fetchOptions);
  if (!response.ok) {
    throw new Error(`Failed to load sprite image: ${url} (${response.status})`);
  }
  return await createImageBitmap(await response.blob(), {premultiplyAlpha: 'none'});
}

/** Appends a suffix and extension to a sprite URL's path, keeping its query string and hash. */
function getSpriteFileUrl(url: string, suffix: string, extension: string): string {
  const pathEnd = url.search(/[?#]/);
  return pathEnd < 0
    ? `${url}${suffix}${extension}`
    : `${url.slice(0, pathEnd)}${suffix}${extension}${url.slice(pathEnd)}`;
}

/**
 * Loads one sprite: the `@2x` variant first at any pixel ratio above 1, as MapLibre does, falling
 * back to `@1x`.
 */
async function loadSpriteAtlas(
  source: SpriteSource,
  options: SpriteLoadOptions
): Promise<SpriteAtlas> {
  const fetchJsonFn = getBasemapResourceFetch('SpriteJSON', 'json', options);
  const suffixes = (options.pixelRatio ?? 1) > 1 ? ['@2x', ''] : [''];
  let lastError: unknown;
  for (const suffix of suffixes) {
    const jsonUrl = getSpriteFileUrl(source.url, suffix, '.json');
    try {
      const response = await fetchJsonFn(jsonUrl, options.fetchOptions);
      if (!response.ok) {
        throw new Error(`Failed to load sprite: ${jsonUrl} (${response.status})`);
      }
      const index = (await response.json()) as Record<string, SpriteImage>;
      return {
        id: source.id,
        image: await loadSpriteImage(
          getSpriteFileUrl(source.url, suffix, '.png'),
          getBasemapResourceFetch('SpriteImage', 'image', options),
          options.fetchOptions
        ),
        mapping: getSpriteIconMapping(index)
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Loads every sprite a style references. A sprite that fails to load is skipped with a warning,
 * so its icons are not drawn and the rest of the style still renders.
 */
export async function loadSpriteAtlases(
  sprite: unknown,
  options: SpriteLoadOptions = {}
): Promise<SpriteAtlas[]> {
  const sources = getSpriteSources(sprite, options.baseUrl);
  const atlases = await Promise.all(
    sources.map(source =>
      loadSpriteAtlas(source, options).catch(error => {
        log.warn(
          `[BasemapLayer] Sprite ${source.url} failed to load; its icons are skipped`,
          error
        )();
        return null;
      })
    )
  );
  return atlases.filter((atlas): atlas is SpriteAtlas => Boolean(atlas));
}

const imageNamesCache = new WeakMap<readonly SpriteAtlas[], string[]>();

/**
 * The image names `icon-image` can reference: unprefixed for the `'default'` sprite and `id:name`
 * for the others. Passed to expression evaluation so `["image", ...]` sees which images exist.
 */
export function getSpriteImageNames(atlases: readonly SpriteAtlas[] | null | undefined): string[] {
  if (!atlases) {
    return [];
  }
  let names = imageNamesCache.get(atlases);
  if (!names) {
    names = atlases.flatMap(atlas =>
      Object.keys(atlas.mapping).map(name =>
        atlas.id === 'default' ? name : `${atlas.id}:${name}`
      )
    );
    imageNamesCache.set(atlases, names);
  }
  return names;
}

/** An icon resolved against the loaded sprites. */
export type ResolvedSpriteIcon = {atlas: SpriteAtlas; name: string; entry: SpriteIconMappingEntry};

/**
 * Finds the sprite and mapping entry for an `icon-image` name. Names from the `'default'` sprite
 * are unprefixed; names from other sprites are written `id:name`, as in MapLibre.
 */
export function resolveSpriteIcon(
  atlases: readonly SpriteAtlas[] | undefined,
  iconImage: string
): ResolvedSpriteIcon | null {
  if (!atlases || !iconImage) {
    return null;
  }
  const separator = iconImage.indexOf(':');
  if (separator > 0) {
    const atlas = atlases.find(candidate => candidate.id === iconImage.slice(0, separator));
    const name = iconImage.slice(separator + 1);
    if (atlas?.mapping[name]) {
      return {atlas, name, entry: atlas.mapping[name]};
    }
  }
  const atlas = atlases.find(candidate => candidate.id === 'default');
  if (atlas?.mapping[iconImage]) {
    return {atlas, name: iconImage, entry: atlas.mapping[iconImage]};
  }
  return null;
}

/** Whether `icon-text-fit` cuts an image into parts: it has `stretchX` or `stretchY` zones. */
export function isStretchableIcon(entry: SpriteIconMappingEntry): boolean {
  return Boolean(entry.stretchX?.length || entry.stretchY?.length);
}

/** The mapping name of part `index` of a stretchable image (see `getStretchIconMapping`). */
export function getIconPartName(name: string, index: number): string {
  return `${name}\u0000${index}`;
}

const stretchIconMappings = new WeakMap<SpriteAtlas, Record<string, SpriteIconMappingEntry>>();

/**
 * A sprite's mapping with an entry for each part that `icon-text-fit` cuts a stretchable image
 * into (`getIconPartName`), besides each image's own. The parts are the same whatever the icon is
 * fitted to: only their sizes on screen change.
 */
export function getStretchIconMapping(atlas: SpriteAtlas): Record<string, SpriteIconMappingEntry> {
  let mapping = stretchIconMappings.get(atlas);
  if (!mapping) {
    mapping = {...atlas.mapping};
    for (const [name, entry] of Object.entries(atlas.mapping)) {
      if (isStretchableIcon(entry)) {
        const quads = getIconQuads(entry, {left: 0, top: 0, right: 1, bottom: 1});
        quads.forEach(({image}, index) => {
          mapping![getIconPartName(name, index)] = {
            ...entry,
            x: entry.x + image.x,
            y: entry.y + image.y,
            width: image.width,
            height: image.height
          };
        });
      }
    }
    stretchIconMappings.set(atlas, mapping);
  }
  return mapping;
}

const warnedMissingIcons = new Set<string>();

/** Warns once per icon name that a style references an image no loaded sprite contains. */
export function warnMissingIcon(iconImage: string): void {
  if (!warnedMissingIcons.has(iconImage)) {
    warnedMissingIcons.add(iconImage);
    log.warn(`[BasemapLayer] icon-image "${iconImage}" is not in the style's sprite; skipped`)();
  }
}
