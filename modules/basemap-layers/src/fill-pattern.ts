// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {log} from '@deck.gl/core';
import {getCompiledStyleProperty, type StyleFeature} from './style-expression';
import {
  type ResolvedSpriteIcon,
  type SpriteAtlas,
  type SpriteIconMappingEntry,
  getSpriteImageNames,
  resolveSpriteIcon
} from './sprite';

type StyleLayerLike = {
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

/** The features of a patterned fill whose images come from one sprite. */
export type FillPatternGroup = {
  atlas: SpriteAtlas;
  /** The atlas's index in the style's sprite list, unique per group. */
  atlasIndex: number;
  features: any[];
  /** The image name in the atlas's mapping, for every feature or per feature. */
  getFillPattern: string | ((feature: StyleFeature) => string);
  /** The image's pixel ratio, device pixels per CSS pixel, for every feature or per feature. */
  getPixelRatio: number | ((feature: StyleFeature) => number);
  /** The names of the group's images, sorted. */
  names: string[];
  /** The group's pattern atlas, made on first use and released with the group. */
  patternAtlas?: PatternAtlas;
};

const warnedMissingPatterns = new Set<string>();

function warnMissingPattern(propertyName: string, name: string): void {
  const key = `${propertyName}:${name}`;
  if (!warnedMissingPatterns.has(key)) {
    warnedMissingPatterns.add(key);
    log.warn(`[BasemapLayer] ${propertyName} "${name}" is not in the style's sprite; skipped`)();
  }
}

/** The latest groups per tile content and style layer, reused while their inputs are unchanged. */
const patternGroupCache = new WeakMap<
  any[],
  WeakMap<StyleLayerLike, {key: unknown[]; groups: FillPatternGroup[]}>
>();

/**
 * Splits a patterned fill's features by the sprite their `fill-pattern` image is in. Features
 * whose image is in no loaded sprite draw nothing, as in MapLibre GL JS. `fill-pattern` is
 * evaluated at the integer zoom, as the style spec does for cross-faded properties.
 *
 * Returns no groups while the sprites load (`null`) or when the layer has no `fill-pattern`. A
 * pattern that does not depend on feature data keeps the tile's feature array, so deck.gl does not
 * re-tessellate the features at a new zoom step; per-feature groups are cached per tile, style
 * layer, sprite list and zoom. `propertyName` is `line-pattern` for a patterned line, which is
 * grouped the same way.
 */
export function getFillPatternGroups(
  features: any[],
  styleLayer: StyleLayerLike,
  zoom: number,
  spriteAtlases: SpriteAtlas[] | null | undefined,
  propertyName: 'fill-pattern' | 'line-pattern' = 'fill-pattern'
): FillPatternGroup[] {
  const property = getCompiledStyleProperty(styleLayer, propertyName);
  if (!property || !spriteAtlases?.length) {
    return [];
  }
  const patternZoom = Math.floor(zoom);
  const imageNames = getSpriteImageNames(spriteAtlases);
  const resolve = (feature?: StyleFeature): ResolvedSpriteIcon | null => {
    const value = property.evaluate(patternZoom, feature, imageNames);
    const name = value === null || value === undefined ? '' : String(value);
    if (!name) {
      return null;
    }
    const icon = resolveSpriteIcon(spriteAtlases, name);
    if (!icon) {
      warnMissingPattern(propertyName, name);
    }
    return icon;
  };

  if (!property.isFeatureDependent) {
    const icon = resolve();
    return icon
      ? [
          {
            atlas: icon.atlas,
            atlasIndex: spriteAtlases.indexOf(icon.atlas),
            features,
            getFillPattern: icon.name,
            getPixelRatio: icon.entry.pixelRatio,
            names: [icon.name]
          }
        ]
      : [];
  }

  const key = [spriteAtlases, property.isZoomDependent ? patternZoom : null];
  let byStyleLayer = patternGroupCache.get(features);
  if (!byStyleLayer) {
    byStyleLayer = new WeakMap();
    patternGroupCache.set(features, byStyleLayer);
  }
  const cached = byStyleLayer.get(styleLayer);
  if (cached && cached.key.every((entry, index) => entry === key[index])) {
    return cached.groups;
  }

  const icons = new Map<StyleFeature, ResolvedSpriteIcon>();
  const groups = new Map<SpriteAtlas, FillPatternGroup>();
  const pixelRatios = new Map<SpriteAtlas, Set<number>>();
  for (const feature of features) {
    const icon = resolve(feature);
    if (!icon) {
      continue;
    }
    icons.set(feature, icon);
    let group = groups.get(icon.atlas);
    if (!group) {
      group = {
        atlas: icon.atlas,
        atlasIndex: spriteAtlases.indexOf(icon.atlas),
        features: [],
        getFillPattern: feature => icons.get(feature)!.name,
        getPixelRatio: feature => icons.get(feature)!.entry.pixelRatio,
        names: []
      };
      groups.set(icon.atlas, group);
      pixelRatios.set(icon.atlas, new Set());
    }
    group.features.push(feature);
    group.names.push(icon.name);
    pixelRatios.get(icon.atlas)!.add(icon.entry.pixelRatio);
  }
  const result = [...groups.values()];
  for (const group of result) {
    group.names = [...new Set(group.names)].sort();
  }
  // A constant pixel ratio, as a sprite normally has, keeps the pattern scale a constant.
  for (const group of result) {
    const ratios = pixelRatios.get(group.atlas)!;
    if (ratios.size === 1) {
      group.getPixelRatio = [...ratios][0];
    }
  }
  byStyleLayer.set(styleLayer, {key, groups: result});
  return result;
}

// luma.gl's WebGPU sampler leaves `mipmapFilter: 'none'` out, which samples the nearest mipmap
// level: the level of detail is clamped to the full-size image instead.
const PATTERN_TEXTURE_PARAMETERS = {mipmapFilter: 'none', lodMaxClamp: 0} as const;

type PatternAtlas = {
  image: SpriteAtlas['image'] | OffscreenCanvas | HTMLCanvasElement | ImageData;
  mapping: Record<string, SpriteIconMappingEntry>;
};

/**
 * Single-image pattern atlases per sprite. A sprite has a fixed set of images, so this holds at
 * most one small canvas per image a style draws as a pattern, for as long as the sprite is loaded.
 * Atlases of several images depend on a tile's features and are kept on their group instead (see
 * `getFillPatternProps`), so they are released with the tile.
 */
const patternAtlasCache = new WeakMap<SpriteAtlas, Map<string, PatternAtlas>>();

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

/**
 * An atlas of the named sprite images for a pattern, each with a 1 pixel border copied from its
 * opposite edge, as MapLibre GL JS pads its pattern atlas. A sprite packs its images edge to edge,
 * so a linear filter at an image's edge would blend in the next image and draw a seam between the
 * repeats; with the border, it blends in the image's own wrapped pixels. The atlas holds only
 * these images, so each fill uploads a small texture instead of the whole sprite. Where the
 * sprite image is a URL, or no canvas is available, it returns the sprite itself.
 */
export function getPatternAtlas(atlas: SpriteAtlas, names: string[]): PatternAtlas {
  if (names.length !== 1) {
    return createPatternAtlas(atlas, names);
  }
  let byName = patternAtlasCache.get(atlas);
  if (!byName) {
    byName = new Map();
    patternAtlasCache.set(atlas, byName);
  }
  let result = byName.get(names[0]);
  if (!result) {
    result = createPatternAtlas(atlas, names);
    byName.set(names[0], result);
  }
  return result;
}

/**
 * The largest width and height of a pattern atlas. WebGL 2 guarantees textures of 2048 pixels; in
 * practice every device that runs it supports 4096, as MapLibre GL JS also assumes for its atlases.
 */
export const MAX_PATTERN_ATLAS_SIZE = 4096;

/**
 * Places images with a 1 pixel border on each side in rows no wider than `maxSize`: shelf packing,
 * tallest images first. Returns each image's top left corner, inside its border, and the atlas
 * size, or `null` when the images do not fit in `maxSize` by `maxSize`.
 */
export function packPatternImages(
  sizes: {width: number; height: number}[],
  maxSize = MAX_PATTERN_ATLAS_SIZE
): {positions: [number, number][]; width: number; height: number} | null {
  const order = sizes.map((_, index) => index).sort((a, b) => sizes[b].height - sizes[a].height);
  const positions: [number, number][] = new Array(sizes.length);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const index of order) {
    const w = sizes[index].width + 2;
    const h = sizes[index].height + 2;
    if (x > 0 && x + w > maxSize) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    if (x + w > maxSize || y + h > maxSize) {
      return null;
    }
    positions[index] = [x + 1, y + 1];
    x += w;
    rowHeight = Math.max(rowHeight, h);
    width = Math.max(width, x);
  }
  return {positions, width, height: y + rowHeight};
}

function createPatternAtlas(atlas: SpriteAtlas, names: string[]): PatternAtlas {
  const sprite: PatternAtlas = {image: atlas.image, mapping: atlas.mapping};
  const entries = names.map(name => atlas.mapping[name]);
  const packing = packPatternImages(entries);
  if (!packing) {
    // Too many images for one texture: the sprite itself, which the style's renderer loaded as
    // one texture, draws them, with seams at the image edges.
    log.warn(
      '[BasemapLayer] fill-pattern images exceed the pattern atlas size; using the sprite'
    )();
    return sprite;
  }
  const canvas =
    typeof atlas.image === 'string' ? null : createCanvas(packing.width, packing.height);
  const context = canvas?.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null
    | undefined;
  if (!canvas || !context) {
    return sprite;
  }
  const mapping: Record<string, SpriteIconMappingEntry> = {};
  names.forEach((name, index) => {
    const entry = entries[index];
    const {x, y, width: w, height: h} = entry;
    const [left, top] = packing.positions[index];
    // The image, then each border from the opposite edge, corners included: a 3x3 tiling of the
    // image clipped to its 1 pixel border.
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        const sx = dx === 0 ? x : dx < 0 ? x + w - 1 : x;
        const sy = dy === 0 ? y : dy < 0 ? y + h - 1 : y;
        const sw = dx === 0 ? w : 1;
        const sh = dy === 0 ? h : 1;
        const tx = left + (dx === 0 ? 0 : dx < 0 ? -1 : w);
        const ty = top + (dy === 0 ? 0 : dy < 0 ? -1 : h);
        context.drawImage(atlas.image as CanvasImageSource, sx, sy, sw, sh, tx, ty, sw, sh);
      }
    }
    mapping[name] = {...entry, x: left, y: top};
  });
  const image = context.getImageData(0, 0, packing.width, packing.height);
  // Each image with its border on its own, so that no image takes colors from its neighbour's.
  names.forEach((name, index) => {
    const [left, top] = packing.positions[index];
    const {width: w, height: h} = entries[index];
    bleedIntoTransparentPixels(image, [left - 1, top - 1, left + w + 1, top + h + 1]);
  });
  return {image, mapping};
}

/**
 * Gives each fully transparent pixel of the rectangle `[left, top, right, bottom)` (the whole
 * image by default) next to a visible one the alpha-weighted average color of its neighbors in
 * the rectangle, keeping it transparent. MapLibre GL JS samples its pattern atlas, which is
 * premultiplied, with a linear filter, so a pattern's edges blend toward transparent in its own
 * color. A canvas uploads unpremultiplied, with transparent pixels black: the filter would blend
 * the edges toward black, and draw light patterns with dark outlines. The image is read back from
 * the canvas so that these colors survive (a canvas keeps none for transparent pixels). It is
 * changed in place, with no copy: only transparent pixels change, and their alpha, which weighs
 * every neighbor's color, stays 0, so no pixel's new color depends on another's.
 */
export function bleedIntoTransparentPixels(
  {data, width, height}: ImageData,
  [left, top, right, bottom]: number[] = [0, 0, width, height]
): void {
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] !== 0) {
        continue;
      }
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < left || ny < top || nx >= right || ny >= bottom) {
            continue;
          }
          // Weighted by alpha, as a premultiplied filter weighs them.
          const j = (ny * width + nx) * 4;
          const alpha = data[j + 3];
          r += data[j] * alpha;
          g += data[j + 1] * alpha;
          b += data[j + 2] * alpha;
          count += alpha;
        }
      }
      if (count) {
        data[i] = r / count;
        data[i + 1] = g / count;
        data[i + 2] = b / count;
      }
    }
  }
}

/** Consecutive features, in draw order, whose images are in one group's atlas. */
export type PatternRun = {
  group: FillPatternGroup;
  features: any[];
  /** Unique among the runs of one list of groups, and the same while the groups are reused. */
  key: string;
};

/** The runs per list of groups. */
const patternRunCache = new WeakMap<FillPatternGroup[], PatternRun[]>();

/**
 * Splits groups into runs of consecutive `features` with the same atlas, so that sublayers drawn
 * run after run keep the features' draw order, such as `line-sort-key`'s, across atlases. A group
 * whose features are consecutive stays one run. The runs of a group share its pattern atlas.
 * Cached per list of groups, which `getFillPatternGroups` reuses while its inputs are unchanged.
 */
export function getPatternRuns(features: any[], groups: FillPatternGroup[]): PatternRun[] {
  const cached = patternRunCache.get(groups);
  if (cached) {
    return cached;
  }
  const groupOf = new Map<any, FillPatternGroup>();
  for (const group of groups) {
    for (const feature of group.features) {
      groupOf.set(feature, group);
    }
  }
  const result: PatternRun[] = [];
  const runCounts = new Map<FillPatternGroup, number>();
  for (const feature of features) {
    const group = groupOf.get(feature);
    if (!group) {
      continue;
    }
    let run = result[result.length - 1];
    if (run?.group !== group) {
      const count = runCounts.get(group) ?? 0;
      runCounts.set(group, count + 1);
      const key = count ? `${group.atlasIndex}-${count}` : `${group.atlasIndex}`;
      run = {group, features: [], key};
      result.push(run);
    }
    run.features.push(feature);
  }
  // A group of one run keeps its feature array, so deck.gl does not re-tessellate its features.
  for (const run of result) {
    if (runCounts.get(run.group) === 1) {
      run.features = run.group.features;
    }
  }
  patternRunCache.set(groups, result);
  return result;
}

/** The features without an image per list of groups. */
const unpatternedCache = new WeakMap<FillPatternGroup[], any[]>();

/**
 * The features of a patterned fill that no group draws, because no loaded sprite has their image.
 * MapLibre GL JS draws no fill for them, but still draws their `fill-outline-color` outline.
 * Cached per list of groups, which `getFillPatternGroups` reuses while its inputs are unchanged.
 */
export function getFeaturesWithoutPattern(features: any[], groups: FillPatternGroup[]): any[] {
  let result = unpatternedCache.get(groups);
  if (!result) {
    const patterned = new Set(groups.flatMap(group => group.features));
    result = patterned.size === features.length ? [] : features.filter(f => !patterned.has(f));
    unpatternedCache.set(groups, result);
  }
  return result;
}

/**
 * `FillPatternExtension` props for a group: the sprite atlas and mapping, and each image repeated
 * at its CSS-pixel size at the integer zoom, as MapLibre GL JS sizes patterns. Between integer
 * zooms the pattern scales with the map, and it steps back at the next integer zoom. The image
 * supplies the colors, so the fill color is only the opacity.
 */
export function getFillPatternProps(group: FillPatternGroup, zoom: number) {
  const unitScale = 2 ** -Math.floor(zoom);
  const {getPixelRatio} = group;
  // Kept on the group: a tile's groups, and so their atlases, are released with its features.
  // A layer turns the atlas image into its own texture and keeps the image as a prop, so no live
  // layer loses its texture when an atlas is released.
  group.patternAtlas ??= getPatternAtlas(group.atlas, group.names);
  const {image, mapping} = group.patternAtlas;
  return {
    fillPatternAtlas: image,
    fillPatternMapping: mapping,
    fillPatternMask: false,
    // Sampled without mipmaps, as in MapLibre GL JS: a mipmap level would blend the atlas's
    // images, and an image's own quadrants. Patterns minify only where a sprite's pixel ratio
    // exceeds the screen's.
    textureParameters: PATTERN_TEXTURE_PARAMETERS,
    fillPatternSizeUnits: 'common' as const,
    getFillPattern: group.getFillPattern,
    getFillPatternScale:
      typeof getPixelRatio === 'function'
        ? (feature: StyleFeature) => unitScale / getPixelRatio(feature)
        : unitScale / getPixelRatio
  };
}

/**
 * `LinePatternExtension` props for a group of patterned lines: the pattern atlas, which its
 * shader reads as MapLibre GL JS's does, and pixels per common unit at the integer zoom, which
 * the pattern's repeats are measured in.
 */
export function getLinePatternProps(group: FillPatternGroup, zoom: number) {
  group.patternAtlas ??= getPatternAtlas(group.atlas, group.names);
  const {image, mapping} = group.patternAtlas;
  return {
    linePatternAtlas: image,
    linePatternMapping: mapping,
    linePatternPixelsPerUnit: 2 ** Math.floor(zoom),
    textureParameters: PATTERN_TEXTURE_PARAMETERS,
    getLinePattern: group.getFillPattern
  };
}
