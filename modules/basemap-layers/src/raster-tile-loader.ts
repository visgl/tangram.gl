// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {_getURLFromTemplate as getURLFromTemplate} from '@deck.gl/geo-layers';
import type {_TileLoadProps as TileLoadProps} from '@deck.gl/geo-layers';
import {parse} from '@loaders.gl/core';
import type {BasemapLoadOptions, BasemapSource} from './style-resolver';

/** The position of a tile in the tile pyramid. */
export type RasterTileIndex = {x: number; y: number; z: number};

/** A raster tile as the tile service returned it, before it is decoded. */
export type RasterTileResponse = {
  /** The URL the tile was requested from. */
  url: string;
  /** The id of the style source of the tile. */
  sourceId: string;
  /** The position of the tile in the tile pyramid. */
  index: RasterTileIndex;
  /** The bytes of the response body. */
  arrayBuffer: ArrayBuffer;
};

/**
 * Returns `true` for a raster tile that has no map data, such as the placeholder image that some
 * tile services return with status 200 where they have no coverage.
 */
export type RejectRasterTile = (tile: RasterTileResponse) => boolean | Promise<boolean>;

/** A decoded tile image, as deck.gl draws it. */
type TileImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas;

/** The part of an image to draw, in pixels. */
export type ImageCrop = {x: number; y: number; width: number; height: number};

/** Options of a {@link RasterTileLoader}. */
export type RasterTileLoaderOptions = {
  /** The tile URL templates of the source. */
  tiles: string[];
  /** The id of the style source. */
  sourceId: string;
  /** The lowest zoom the source has tiles at. */
  minZoom?: number;
  /** Tiles for which this returns `true` have no data. */
  rejectTile: RejectRasterTile;
  /** The `fetch` and `fetchOptions` that tiles are requested with. */
  loadOptions?: BasemapLoadOptions;
  /** Decodes the bytes of a tile. Default: the image loader that deck.gl registers. */
  decodeImage?: (arrayBuffer: ArrayBuffer) => Promise<TileImage>;
  /** Cuts a part out of a decoded tile. Default: `createImageBitmap`. */
  cropImage?: (image: TileImage, crop: ImageCrop) => Promise<TileImage>;
};

/** The most ancestor tiles kept decoded for the tiles that draw a part of them. */
const MAX_CACHED_ANCESTORS = 32;

/**
 * The part of an ancestor tile's image that covers the tile `index`, `levels` zooms below it. The
 * part is one pixel at least: a tile far below its ancestor is drawn in the color of that pixel.
 */
export function getAncestorCrop(
  index: RasterTileIndex,
  levels: number,
  width: number,
  height: number
): ImageCrop {
  const scale = 2 ** levels;
  const cropWidth = Math.max(1, Math.floor(width / scale));
  const cropHeight = Math.max(1, Math.floor(height / scale));
  return {
    x: Math.floor(((index.x % scale) * width) / scale),
    y: Math.floor(((index.y % scale) * height) / scale),
    width: cropWidth,
    height: cropHeight
  };
}

/** The ancestor of the tile `index`, `levels` zooms above it. */
export function getAncestorIndex(index: RasterTileIndex, levels: number): RasterTileIndex {
  const scale = 2 ** levels;
  return {x: Math.floor(index.x / scale), y: Math.floor(index.y / scale), z: index.z - levels};
}

/**
 * Decodes a tile as deck.gl decodes the tiles it loads: with the image loader it registers, and
 * with the `loadOptions` of the layer, so that decoder options such as
 * `imagebitmap.colorSpaceConversion` apply as they do to the tiles that deck.gl loads.
 */
function decodeTileImage(
  arrayBuffer: ArrayBuffer,
  loadOptions?: BasemapLoadOptions
): Promise<TileImage> {
  return parse(arrayBuffer, loadOptions || undefined) as Promise<TileImage>;
}

/** Cuts a part out of a tile, with the colors as stored, as deck.gl decodes its images. */
function cropTileImage(image: TileImage, crop: ImageCrop): Promise<TileImage> {
  return createImageBitmap(image, crop.x, crop.y, crop.width, crop.height, {
    premultiplyAlpha: 'none'
  });
}

/**
 * Loads the tiles of a raster source that returns an image where it has no data. A tile that
 * `rejectTile` matches is drawn from the nearest ancestor tile that has data, enlarged, as
 * MapLibre GL JS draws a tile that failed to load.
 */
export class RasterTileLoader {
  /** Decoded ancestor tiles, or `null` for those without data, most recently used last. */
  private ancestors = new Map<string, Promise<TileImage | null>>();

  constructor(readonly options: RasterTileLoaderOptions) {}

  /** The `getTileData` of the source's `TileLayer`. */
  getTileData = async (tile: TileLoadProps): Promise<TileImage | null> => {
    const index = tile.index as RasterTileIndex;
    const image = await this.loadTile(index, tile.signal);
    if (image) {
      return image;
    }
    const minZoom = this.options.minZoom ?? 0;
    for (let levels = 1; index.z - levels >= minZoom; levels++) {
      // An ancestor that fails to load has no data to draw: the next one up is tried.
      const ancestor = await this.loadAncestor(getAncestorIndex(index, levels)).catch(() => null);
      if (tile.signal?.aborted) {
        return null;
      }
      if (ancestor) {
        const crop = getAncestorCrop(index, levels, ancestor.width, ancestor.height);
        return (this.options.cropImage || cropTileImage)(ancestor, crop);
      }
    }
    return null;
  };

  /** The decoded tile, or `null` when it has no data. */
  private async loadTile(index: RasterTileIndex, signal?: AbortSignal): Promise<TileImage | null> {
    const {tiles, sourceId, rejectTile, loadOptions, decodeImage} = this.options;
    const url = getURLFromTemplate(tiles, {index, id: `${index.x}-${index.y}-${index.z}`});
    if (!url) {
      return null;
    }
    const fetchFn = loadOptions?.fetch || fetch;
    const response = await fetchFn(url, {...loadOptions?.fetchOptions, signal});
    if (!response.ok) {
      throw new Error(`Failed to load raster tile: ${url} (${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0 || (await rejectTile({url, sourceId, index, arrayBuffer}))) {
      return null;
    }
    return decodeImage ? decodeImage(arrayBuffer) : decodeTileImage(arrayBuffer, loadOptions);
  }

  /** The decoded ancestor tile, loaded once for all of the tiles that draw a part of it. */
  private loadAncestor(index: RasterTileIndex): Promise<TileImage | null> {
    const key = `${index.z}/${index.x}/${index.y}`;
    let ancestor = this.ancestors.get(key);
    this.ancestors.delete(key);
    if (!ancestor) {
      ancestor = this.loadTile(index);
      // A failed request is not kept: the next tile that needs the ancestor requests it again.
      ancestor.catch(() => {
        if (this.ancestors.get(key) === ancestor) {
          this.ancestors.delete(key);
        }
      });
    }
    this.ancestors.set(key, ancestor);
    if (this.ancestors.size > MAX_CACHED_ANCESTORS) {
      const [leastRecentlyUsed] = this.ancestors.keys();
      this.ancestors.delete(leastRecentlyUsed);
    }
    return ancestor;
  }
}

const rasterTileLoaders = new WeakMap<BasemapSource, RasterTileLoader>();

/**
 * The loader of a raster source's tiles. It is kept while `rejectTile` and `loadOptions` stay the
 * same, so that the ancestor tiles it decoded are shared by every render.
 */
export function getRasterTileLoader(
  source: BasemapSource,
  options: Omit<RasterTileLoaderOptions, 'tiles'>
): RasterTileLoader {
  let loader = rasterTileLoaders.get(source);
  if (
    !loader ||
    loader.options.rejectTile !== options.rejectTile ||
    loader.options.loadOptions !== options.loadOptions ||
    loader.options.sourceId !== options.sourceId ||
    loader.options.minZoom !== options.minZoom
  ) {
    loader = new RasterTileLoader({...options, tiles: source.tiles as string[]});
    rasterTileLoaders.set(source, loader);
  }
  return loader;
}
