// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Layer, Viewport} from '@deck.gl/core';
import {MaskExtension, type MaskExtensionProps} from '@deck.gl/extensions';
import type {ShaderModule, ShaderPlugin} from '@luma.gl/shaders';

/** How the layers of a basemap are drawn outside a deck.gl mask layer. */
export type BasemapMaskOutside = {
  /** The saturation of the colors: 0 is gray, 1 keeps the colors. */
  saturation: number;
  /** Inverts the lightness of the colors: light colors become dark. */
  inverted: boolean;
  /** A color that the colors are mixed with. The alpha is the share of this color. */
  tint: [red: number, green: number, blue: number, alpha: number];
  /** Whether the sublayer of these style layers is drawn. */
  drawLayer: (styleLayerIds: string[]) => boolean;
};

/** The props of `BasemapMaskExtension`: those of `MaskExtension`, and the style outside the mask. */
export type BasemapMaskExtensionProps = MaskExtensionProps & {
  /** Without it, the basemap is not drawn outside the mask, as with `MaskExtension`. */
  maskOutside?: BasemapMaskOutside | null;
};

type BasemapMaskUniforms = {
  fragmentToMask: Matrix3;
  outsideTint: [number, number, number, number];
  outsideSaturation: number;
  outsideInverted: boolean;
  channel: number;
  enabled: boolean;
  inverted: boolean;
  drawOutside: boolean;
};

/** A mask of deck.gl's `MaskEffect`: its channel in the mask texture, and the bounds of that texture. */
type MaskChannel = {index: number; bounds: number[]};

type Matrix3 = [number, number, number, number, number, number, number, number, number];

const UNIFORMS = /* glsl */ `\
layout(std140) uniform basemapMaskUniforms {
  mat3 fragmentToMask;
  vec4 outsideTint;
  float outsideSaturation;
  bool outsideInverted;
  highp int channel;
  bool enabled;
  bool inverted;
  bool drawOutside;
} basemapMask;
`;

const basemapMaskModule = {
  name: 'basemapMask',
  fs: UNIFORMS,
  uniformTypes: {
    fragmentToMask: 'mat3x3<f32>',
    outsideTint: 'vec4<f32>',
    outsideSaturation: 'f32',
    outsideInverted: 'i32',
    channel: 'i32',
    enabled: 'i32',
    inverted: 'i32',
    drawOutside: 'i32'
  }
} as const satisfies ShaderModule<BasemapMaskUniforms>;

/**
 * Reads the mask texture of deck.gl's `MaskExtension` at the position of each fragment on the
 * ground. `mask_texture` comes from that extension's shader module. A mask layer draws 0 into its
 * channel of the texture.
 */
const basemapMaskPlugin: ShaderPlugin = {
  name: 'basemapMask',
  module: basemapMaskModule,
  injections: [
    {
      stage: 'fragment',
      target: 'DECKGL_FILTER_COLOR',
      // After the injections of the basemap's own extensions, such as the colors of a fill pattern.
      order: 100,
      glsl: /* glsl */ `
  if (basemapMask.enabled) {
    vec3 basemapMask_position = basemapMask.fragmentToMask * vec3(gl_FragCoord.xy, 1.0);
    vec2 basemapMask_coords = basemapMask_position.xy / basemapMask_position.z;
    // The linear filter of the mask texture smooths the edge of the mask.
    float basemapMask_outside =
      all(greaterThanEqual(basemapMask_coords, vec2(0.0))) &&
      all(lessThanEqual(basemapMask_coords, vec2(1.0)))
        ? smoothstep(0.25, 0.75, texture(mask_texture, basemapMask_coords)[basemapMask.channel])
        : 1.0;
    if (basemapMask.inverted) {
      basemapMask_outside = 1.0 - basemapMask_outside;
    }
    if (basemapMask.drawOutside) {
      float basemapMask_gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      vec3 basemapMask_color = mix(vec3(basemapMask_gray), color.rgb, basemapMask.outsideSaturation);
      if (basemapMask.outsideInverted) {
        // Inverts the lightness, and keeps the hue.
        basemapMask_color += 1.0 - 2.0 * dot(basemapMask_color, vec3(0.299, 0.587, 0.114));
      }
      basemapMask_color = mix(basemapMask_color, basemapMask.outsideTint.rgb, basemapMask.outsideTint.a);
      color.rgb = mix(color.rgb, basemapMask_color, basemapMask_outside);
    } else {
      color.a *= 1.0 - basemapMask_outside;
      if (color.a <= 0.0) {
        discard;
      }
    }
  }
`
    }
  ]
};

/**
 * A `MaskExtension` for a `BasemapLayer` that draws the basemap outside the mask layer too, in
 * another style. Inside the mask, the basemap keeps its colors. Outside it, each fragment loses
 * its saturation, is inverted, takes a tint, or is discarded: see `maskOutside`.
 *
 * `MaskExtension` supplies the mask texture, and masks a label by its anchor. This extension
 * reads the texture at each fragment instead, so that a label changes at the edge of the mask as
 * fills and lines do. It takes the place on the ground of a fragment from the position of the
 * fragment on the screen: the view must fill the canvas. WebGL only.
 */
export class BasemapMaskExtension extends MaskExtension {
  static extensionName = 'BasemapMaskExtension';
  // `BasemapLayer` gives its sublayers the props that an extension declares here.
  static defaultProps = {...MaskExtension.defaultProps, maskOutside: null};

  getShaders(this: Layer<MaskExtensionProps>) {
    const shaders = MaskExtension.prototype.getShaders.call(this);
    return {...shaders, plugins: [...shaders.plugins, basemapMaskPlugin]};
  }

  draw(this: Layer<Required<BasemapMaskExtensionProps>>, params: any, extension: MaskExtension) {
    MaskExtension.prototype.draw.call(this, params, extension);
    const {maskId, maskInverted, maskOutside} = this.props;
    const {mask, project} = params.shaderModuleProps;
    const channel: MaskChannel | undefined = mask?.maskChannels?.[maskId];
    if (!maskOutside || !channel) {
      this.setShaderModuleProps({basemapMask: {enabled: false}});
      return;
    }
    const basemapMask: BasemapMaskUniforms = {
      fragmentToMask: getFragmentToMaskMatrix(
        params.context.viewport,
        channel.bounds,
        project?.devicePixelRatio
      ),
      outsideTint: maskOutside.tint,
      outsideSaturation: maskOutside.saturation,
      outsideInverted: maskOutside.inverted,
      channel: channel.index,
      enabled: true,
      inverted: maskInverted,
      drawOutside: maskOutside.drawLayer(getStyleLayerIds(this))
    };
    // This extension draws the outside of the mask: `MaskExtension` must not discard it.
    this.setShaderModuleProps({mask: {enabled: false}, basemapMask});
  }
}

/**
 * The matrix from `gl_FragCoord` to the coordinates of the mask texture, in column-major order.
 * The fragment is taken to lie on the ground.
 *
 * @param bounds The bounds of the mask texture, `[west, south, east, north]`.
 */
function getFragmentToMaskMatrix(
  viewport: Viewport,
  bounds: number[],
  devicePixelRatio = 1
): Matrix3 {
  // Rows x, y and w of the matrix from common space to pixels, for a position with z = 0.
  const m = viewport.pixelProjectionMatrix;
  const groundToPixel: Matrix3 = [m[0], m[4], m[12], m[1], m[5], m[13], m[3], m[7], m[15]];
  const pixelToGround = invert(groundToPixel);
  const [left, bottom] = viewport.projectPosition([bounds[0], bounds[1], 0]);
  const [right, top] = viewport.projectPosition([bounds[2], bounds[3], 0]);
  const width = right - left;
  const height = top - bottom;
  const groundToMask: Matrix3 = [1 / width, 0, -left / width, 0, 1 / height, -bottom / height, 0, 0, 1];
  // The y axis of `gl_FragCoord` points up, and that of pixels down.
  const scale = 1 / devicePixelRatio;
  const fragmentToPixel: Matrix3 = [scale, 0, 0, 0, -scale, viewport.height, 0, 0, 1];
  const [a, b, c, d, e, f, g, h, i] = multiply(multiply(groundToMask, pixelToGround), fragmentToPixel);
  return [a, d, g, b, e, h, c, f, i];
}

/** The product of two 3x3 matrices in row-major order. */
function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  const product = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Matrix3;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      for (let index = 0; index < 3; index++) {
        product[row * 3 + column] += a[row * 3 + index] * b[index * 3 + column];
      }
    }
  }
  return product;
}

/** The inverse of a 3x3 matrix in row-major order. */
function invert([a, b, c, d, e, f, g, h, i]: Matrix3): Matrix3 {
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant
  ];
}

const STYLE_LAYER_IDS = /\["(?:[^"\\]|\\.)*"(?:,"(?:[^"\\]|\\.)*")*\]|"(?:[^"\\]|\\.)*"/g;

/** A layer and the composite layers that render it, as far as `getStyleLayerIds` reads them. */
export type LayerNode = {id: string; parent: LayerNode | null};

/**
 * The ids of the style layers that a `BasemapLayer` sublayer draws. The id of a sublayer of a
 * vector source ends with the id of its style layer as a JSON string, or the ids of several as a
 * JSON array, and a suffix. An id of a style layer earlier in it names the group of style layers
 * that draw together.
 *
 * A background, raster or hillshade style layer has no JSON id: `BasemapLayer` gives the sublayer
 * that it renders for the style layer the id `<BasemapLayer id>-<style layer id>`. The
 * `BasemapLayer` must be a top-level layer.
 */
export function getStyleLayerIds(layer: LayerNode): string[] {
  const ids = layer.id.match(STYLE_LAYER_IDS)?.pop();
  if (ids) {
    return [JSON.parse(ids) as string | string[]].flat();
  }
  let sublayer = layer;
  while (sublayer.parent?.parent) {
    sublayer = sublayer.parent;
  }
  const basemap = sublayer.parent;
  return basemap && sublayer.id.startsWith(`${basemap.id}-`)
    ? [sublayer.id.slice(basemap.id.length + 1)]
    : [];
}
