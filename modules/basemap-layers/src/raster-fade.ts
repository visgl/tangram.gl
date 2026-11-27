// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension} from '@deck.gl/core';
import type {Layer, LayerProps} from '@deck.gl/core';
import type {_Tile2DHeader as Tile2DHeader} from '@deck.gl/geo-layers';
import type {Texture} from '@luma.gl/core';
import {createShaderInjectionPlugin} from './shader-injection-plugin';
import {ProjectedTileLayer} from './projected-tileset';

/** Returns the current time in milliseconds. `raster-fade-duration` is measured on this clock. */
export type RasterFadeClock = () => number;

/** The default clock: `performance.now`. */
export const defaultRasterFadeClock: RasterFadeClock = () => performance.now();

/**
 * The most zoom levels above a tile that its fading ancestor can be, as in MapLibre GL JS
 * (`TileManager._maxFadingAncestorLevels`).
 */
export const MAX_FADING_ANCESTOR_LEVELS = 5;

/** How a tile is drawn at one moment of its fade. */
export type RasterFadeValues = {
  /** The factor of the tile's alpha. */
  opacity: number;
  /** The share of the ancestor's color in the tile's color, 0 to 1. */
  mix: number;
};

/** A tile that has finished its fade. */
const FADED_IN: RasterFadeValues = {opacity: 1, mix: 0};

/**
 * The fade of a tile `elapsed` milliseconds after it loaded, as MapLibre GL JS computes the fade
 * of an incoming tile in `draw_raster`. A tile with a loaded ancestor cross-fades from the
 * ancestor's image (`getCrossFadeValues`): the share of the ancestor goes from 1 to 0, and the
 * tile stays opaque. A tile without one fades in from transparent (`getSelfFadeValues`). With a
 * `duration` of 0, the tile is drawn at once.
 */
export function getRasterFadeValues(
  elapsed: number,
  duration: number,
  crossFade: boolean
): RasterFadeValues {
  if (!(duration > 0)) {
    return FADED_IN;
  }
  const progress = Math.min(1, Math.max(0, elapsed / duration));
  return crossFade ? {opacity: 1, mix: 1 - progress} : {opacity: progress, mix: 0};
}

/** The part of an ancestor tile's image that covers a tile. */
export type RasterFadeParent = {
  /** The texture coordinates of the tile's top-left corner in the ancestor's image. */
  topLeft: [number, number];
  /** The size of the tile in the ancestor's texture coordinates: `2 ** -levels`. */
  scale: number;
};

/** The fade of one tile, fixed when the tile is first drawn. */
export type RasterFade = {
  /** The time the tile was first drawn, on the layer's clock. */
  start: number;
  /** The ancestor that the tile cross-fades from, or `null` when it fades in alone. */
  parent: RasterFadeParent | null;
};

/** A tile's position in its pyramid. */
type TileIndex = {x: number; y: number; z: number};

/**
 * The part of the image of `ancestor` that covers `index`, as MapLibre GL JS's `parentTopLeft` and
 * `parentScaleBy`.
 */
export function getRasterFadeParent(index: TileIndex, ancestor: TileIndex): RasterFadeParent {
  const scale = 2 ** (ancestor.z - index.z);
  return {topLeft: [(index.x * scale) % 1, (index.y * scale) % 1], scale};
}

/**
 * The nearest ancestor of a tile that has an image to fade from, at most
 * `MAX_FADING_ANCESTOR_LEVELS` zoom levels above it.
 */
export function getFadingAncestor(tile: Tile2DHeader): Tile2DHeader | null {
  const {z} = tile.index as TileIndex;
  for (let ancestor = tile.parent; ancestor; ancestor = ancestor.parent) {
    if (z - (ancestor.index as TileIndex).z > MAX_FADING_ANCESTOR_LEVELS) {
      return null;
    }
    if (ancestor.isLoaded && ancestor.content) {
      return ancestor;
    }
  }
  return null;
}

const rasterFadePlugin = createShaderInjectionPlugin({
  name: 'rasterFade',
  fs: /* glsl */ `\
uniform sampler2D rasterFadeParentTexture;

layout(std140) uniform rasterFadeUniforms {
  vec2 parentTopLeft;
  float parentScale;
  float parentMix;
  float opacity;
} rasterFade;
`,
  uniformTypes: {
    parentTopLeft: 'vec2<f32>',
    parentScale: 'f32',
    parentMix: 'f32',
    opacity: 'f32'
  },
  inject: {
    // Before other color filters, such as `RasterColorExtension`'s adjustments: MapLibre mixes
    // the two images, then adjusts the mixed color. `BitmapLayer` has drawn the tile's color with
    // the layer's opacity in its alpha.
    'fs:DECKGL_FILTER_COLOR': {
      order: -1,
      injection: /* glsl */ `
  if (rasterFade.parentMix > 0.0) {
    vec4 rasterFade_parent = texture(
      rasterFadeParentTexture,
      rasterFade.parentTopLeft + geometry.uv * rasterFade.parentScale
    );
    color = mix(color, vec4(rasterFade_parent.rgb, rasterFade_parent.a * layer.opacity), rasterFade.parentMix);
  }
  color.a *= rasterFade.opacity;
`
    }
  }
});

/** The props that `RasterFadeExtension` adds to a `BitmapLayer`. */
export type RasterFadeExtensionProps = {
  /** `raster-fade-duration`, in milliseconds. */
  rasterFadeDuration?: number;
  /** The clock the fade is measured on. */
  rasterFadeClock?: RasterFadeClock;
  /** The fade of the tile; `null` draws the tile faded in. */
  rasterFade?: RasterFade | null;
  /** The image of the ancestor the tile cross-fades from. */
  rasterFadeParentImage?: unknown;
};

/** Whether the extension's shader runs on a layer's device. It is written in GLSL only. */
export function isRasterFadeSupported(layer: Layer): boolean {
  return layer.context.device.type !== 'webgpu';
}

/**
 * Fades a raster tile's `BitmapLayer` in over `raster-fade-duration`, as MapLibre GL JS does:
 * from its ancestor's image (`rasterFadeParentImage`, enlarged) where one was loaded, else from
 * transparent. The fade is read from the clock at each draw, and the layer redraws until it
 * ends. WebGL only; on WebGPU tiles are drawn at once.
 */
export class RasterFadeExtension extends LayerExtension {
  static extensionName = 'RasterFadeExtension';
  static defaultProps = {
    rasterFadeDuration: 0,
    rasterFadeClock: {type: 'function', value: defaultRasterFadeClock},
    rasterFade: {type: 'object', value: null},
    // Made a texture with the layer's `textureParameters`, as `BitmapLayer.image` is.
    rasterFadeParentImage: {type: 'image', value: null, async: true}
  };

  getShaders(this: Layer<RasterFadeExtensionProps>) {
    return isRasterFadeSupported(this) ? {plugins: [rasterFadePlugin]} : {};
  }

  draw(this: Layer<RasterFadeExtensionProps & {image?: unknown}>) {
    if (!isRasterFadeSupported(this)) {
      return;
    }
    const {rasterFade, rasterFadeDuration = 0, rasterFadeParentImage, image} = this.props;
    const clock = this.props.rasterFadeClock || defaultRasterFadeClock;
    const parent = rasterFade?.parent && rasterFadeParentImage ? rasterFade.parent : null;
    const values = rasterFade
      ? getRasterFadeValues(clock() - rasterFade.start, rasterFadeDuration, Boolean(parent))
      : FADED_IN;
    this.setShaderModuleProps({
      rasterFade: {
        parentTopLeft: parent?.topLeft ?? [0, 0],
        parentScale: parent?.scale ?? 1,
        parentMix: values.mix,
        opacity: values.opacity,
        // Without an ancestor, the tile's own texture is bound, and not sampled.
        rasterFadeParentTexture: (parent ? rasterFadeParentImage : image) as Texture
      }
    } as any);
    const drawnFadedIn = values.opacity === FADED_IN.opacity && values.mix === FADED_IN.mix;
    this.state.rasterFadeDrawnFadedIn = drawnFadedIn;
    if (!drawnFadedIn) {
      this.setNeedsRedraw();
    } else if (parent && rasterFadeDuration > 0 && !this.state.rasterFadeReleaseRequested) {
      // The cross-fade has ended: the tile layer renders the tile again without the ancestor's
      // image (see `RasterFadeTileLayer.getSubLayerPropsByTile`), which releases its texture.
      // Ask once. deck.gl can draw the layer with its props from before that update, so the
      // ancestor can still be there on later draws. A request on each of those draws updates
      // the tile layer on every frame. The tile looks the same either way: the mix is 0.
      this.state.rasterFadeReleaseRequested = true;
      this.parent?.setNeedsUpdate();
    }
  }
}

/** The props of a `RasterFadeTileLayer`. */
export type RasterFadeTileLayerProps = {
  /** `raster-fade-duration`, in milliseconds. 0 draws tiles at once. */
  rasterFadeDuration?: number;
  /** The clock the fade is measured on. Default: `performance.now`. */
  rasterFadeClock?: RasterFadeClock;
};

/** The sublayer props of one tile's fade. */
type TileFadeProps = {rasterFade: RasterFade; rasterFadeParentImage: unknown};

/**
 * A `ProjectedTileLayer` of raster tiles that fade in over `rasterFadeDuration` (see
 * `RasterFadeExtension`, which `renderSubLayers` adds to the tiles' layers). A tile's fade starts
 * when it is first drawn, from the nearest ancestor that was loaded then. When the fade ends, the
 * tile lets go of the ancestor's image. The layer is loaded once its selected tiles have been
 * drawn faded in, as MapLibre GL JS is idle only once its raster tiles have.
 */
export class RasterFadeTileLayer<DataT = any, ExtraPropsT extends {} = {}> extends ProjectedTileLayer<
  DataT,
  ExtraPropsT & RasterFadeTileLayerProps
> {
  static layerName = 'RasterFadeTileLayer';
  static defaultProps = {
    ...ProjectedTileLayer.defaultProps,
    rasterFadeDuration: 0,
    rasterFadeClock: {type: 'function', value: defaultRasterFadeClock}
  };

  declare state: ProjectedTileLayer<DataT, ExtraPropsT & RasterFadeTileLayerProps>['state'] & {
    tileFades?: WeakMap<Tile2DHeader, TileFadeProps>;
  };

  /** Whether tiles fade: a positive duration, on a device that runs the fade's shader. */
  private fades(): boolean {
    return this.props.rasterFadeDuration! > 0 && isRasterFadeSupported(this as unknown as Layer);
  }

  getSubLayerPropsByTile(tile: Tile2DHeader): Partial<LayerProps> | null {
    if (!tile.content || !this.fades()) {
      return null;
    }
    this.state.tileFades ||= new WeakMap();
    let fade = this.state.tileFades.get(tile);
    if (!fade) {
      const ancestor = getFadingAncestor(tile);
      fade = {
        rasterFade: {
          start: this.props.rasterFadeClock!(),
          parent: ancestor
            ? getRasterFadeParent(tile.index as TileIndex, ancestor.index as TileIndex)
            : null
        },
        rasterFadeParentImage: ancestor ? ancestor.content : null
      };
      this.state.tileFades.set(tile, fade);
    } else if (
      fade.rasterFadeParentImage &&
      this.props.rasterFadeClock!() - fade.rasterFade.start >= this.props.rasterFadeDuration!
    ) {
      // Keep the fade record so `isLoaded` still checks what the sublayers last drew.
      fade = {rasterFade: {start: fade.rasterFade.start, parent: null}, rasterFadeParentImage: null};
      this.state.tileFades.set(tile, fade);
    }
    return fade as Partial<LayerProps>;
  }

  /** Whether the selected tiles are loaded and their fades have been drawn to completion. */
  get isLoaded(): boolean {
    if (!super.isLoaded) {
      return false;
    }
    if (!this.fades()) {
      return true;
    }
    return (this.state.tileset?.selectedTiles || []).every(tile => {
      const layers = tile.layers;
      return (
        !this.state.tileFades?.has(tile) ||
        Boolean(layers?.length && layers.every(layer => layer.state?.rasterFadeDrawnFadedIn === true))
      );
    });
  }
}
