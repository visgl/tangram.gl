// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension} from '@deck.gl/core';
import type {Accessor, AttributeManager, Layer, LayerContext, UpdateParameters} from '@deck.gl/core';
import type {Device, Texture} from '@luma.gl/core';
import {getStyleZoom} from './projected-viewport';
import {getZoomBucket, getZoomPaintZoom} from './style-accessor';
import {createShaderInjectionPlugin} from './shader-injection-plugin';

/** The most style layers whose paint one layer can take from `ZoomPaintExtension`. */
export const MAX_ZOOM_PAINT_PARTS = 64;

/** The rows of `ZoomPaintValues`. */
export const ZOOM_PAINT_WIDTH_ROW = 0;
export const ZOOM_PAINT_LINE_COLOR_ROW = 1;
export const ZOOM_PAINT_FILL_COLOR_ROW = 2;
/** The row of blend factors for composite width, line color and fill color. */
export const ZOOM_PAINT_INTERPOLATION_ROW = 3;
/** The number of rows in the paint texture. */
const ZOOM_PAINT_ROWS = 4;

/**
 * The paint of each style layer drawn by a layer, at one zoom: an RGBA texel per style layer
 * (column) and value (row), `MAX_ZOOM_PAINT_PARTS` by 4. Column `i` is the style layer that
 * `getStylePart` returns `i` for.
 *
 * - `ZOOM_PAINT_WIDTH_ROW`: in red, a factor of the layer's width attribute.
 * - `ZOOM_PAINT_LINE_COLOR_ROW`, `ZOOM_PAINT_FILL_COLOR_ROW`: a color in 0-1, which replaces the
 *   layer's color attribute unless its alpha is negative: the attribute then holds the style
 *   layer's per-feature colors.
 * - `ZOOM_PAINT_INTERPOLATION_ROW`: blend factors for width, line color and fill color in RGB.
 */
export type ZoomPaintValues = Float32Array;

/** Creates values with every width factor 1 and every color taken from the attributes. */
export function createZoomPaintValues(): ZoomPaintValues {
  const values = new Float32Array(MAX_ZOOM_PAINT_PARTS * ZOOM_PAINT_ROWS * 4);
  for (let part = 0; part < MAX_ZOOM_PAINT_PARTS; part++) {
    values[getZoomPaintOffset(ZOOM_PAINT_WIDTH_ROW, part)] = 1;
    values[getZoomPaintOffset(ZOOM_PAINT_LINE_COLOR_ROW, part) + 3] = -1;
    values[getZoomPaintOffset(ZOOM_PAINT_FILL_COLOR_ROW, part) + 3] = -1;
  }
  return values;
}

/** The index of a style layer's texel in a row of `ZoomPaintValues`. */
export function getZoomPaintOffset(row: number, part: number): number {
  return (row * MAX_ZOOM_PAINT_PARTS + part) * 4;
}

/**
 * The paint of the style layers drawn by a layer, and the texture that hands it to the shaders,
 * which `destroy` releases.
 */
export class ZoomPaint {
  private texture: Texture | null = null;
  private written: ZoomPaintValues | null = null;

  /**
   * `evaluate` returns the values at the viewport zoom and attribute bucket, the same array
   * while they are unchanged. `partCount` is the number of style layers using the texture.
   */
  constructor(
    private readonly evaluate: (zoom: number, bucket: number) => ZoomPaintValues,
    private readonly partCount: number
  ) {}

  /** The values at a zoom, using the bucket at which the layer's attributes were generated. */
  getValues(zoom: number, bucket = getZoomBucket(zoom)): ZoomPaintValues {
    return this.evaluate(zoom, bucket);
  }

  /** Whether a fill or line in this batch can draw at the current viewport zoom. */
  isVisible(zoom: number, bucket: number | undefined, filled: boolean, stroked: boolean): boolean {
    const values = this.getValues(zoom, bucket);
    for (let part = 0; part < this.partCount; part++) {
      if (
        (filled && values[getZoomPaintOffset(ZOOM_PAINT_FILL_COLOR_ROW, part) + 3] !== 0) ||
        (stroked &&
          values[getZoomPaintOffset(ZOOM_PAINT_WIDTH_ROW, part)] > 0 &&
          values[getZoomPaintOffset(ZOOM_PAINT_LINE_COLOR_ROW, part) + 3] !== 0)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * The texture of the current values, created on first use. The viewport zoom gives the
   * layer-wide values, and the attributes' bucket gives the lower endpoint of each blend.
   */
  getTexture(device: Device, zoom: number, bucket?: number): Texture {
    if (this.texture?.device !== device) {
      this.destroy();
      this.texture = device.createTexture({
        format: 'rgba32float',
        width: MAX_ZOOM_PAINT_PARTS,
        height: ZOOM_PAINT_ROWS,
        mipLevels: 1,
        // Float textures cannot be filtered without an extension; the shader reads exact texels.
        sampler: {minFilter: 'nearest', magFilter: 'nearest'}
      });
    }
    // Layers that share the texture share the values, so it is written once per change.
    const values = this.getValues(zoom, bucket);
    if (this.written !== values) {
      this.texture.writeData(values);
      this.written = values;
    }
    return this.texture;
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.written = null;
  }
}

export type ZoomPaintExtensionProps = {
  /** The paint to apply; the layer draws its attributes as they are without it. */
  zoomPaint?: ZoomPaint | null;
  /** The zoom option used to build this sublayer, shared with its drawing layers. */
  zoomPaintGeneration?: {zoom: number} | null;
  /** The lower endpoint of the composite paint attributes. */
  zoomPaintBucket?: number;
  /** Which of `zoomPaint`'s style layers each object belongs to. */
  getStylePart?: Accessor<any, number>;
  /** Width at the upper endpoint of the composite paint interval. */
  getNextLineWidth?: Accessor<any, number>;
  /** Line color at the upper endpoint of the composite paint interval. */
  getNextLineColor?: Accessor<any, number[]>;
  /** Fill color at the upper endpoint of the composite paint interval. */
  getNextFillColor?: Accessor<any, number[]>;
  /** Style part, next width and packed RGBA for a dashed path. */
  getNextDashedPaint?: Accessor<any, number[]>;
};

/** Declares the sampler shared by the path and polygon shader variants. */
const zoomPaintModule = {
  name: 'zoomPaint',
  vs: /* glsl */ `uniform highp sampler2D zoomPaintTexture;`
} as const;

/** Reads the texels belonging to the current object's style layer. */
const DECLARATIONS = /* glsl */ `
vec4 zoomPaint_get(int row) {
  return texelFetch(zoomPaintTexture, ivec2(int(ZOOM_PAINT_PART + 0.5), row), 0);
}

vec4 zoomPaint_color(vec4 color, int row) {
  vec4 partColor = zoomPaint_get(row);
  return partColor.a < 0.0 ? color : vec4(partColor.rgb, partColor.a * layer.opacity);
}
`;

/** Reads the style part from its own vertex input. */
const STYLE_PART = /* glsl */ `
in float instanceStyleParts;
#define ZOOM_PAINT_PART instanceStyleParts
`;
/** Declares the upper endpoint attributes for a composite path. */
const PATH_NEXT = /* glsl */ `
in float instanceNextLineWidths;
in vec4 instanceNextLineColors;
#define ZOOM_PAINT_NEXT_WIDTH instanceNextLineWidths
#define ZOOM_PAINT_NEXT_COLOR instanceNextLineColors
`;
/** Unpacks the style part, width and RGBA of a dashed path from one vertex input. */
const PACKED_PATH_NEXT = /* glsl */ `
in vec4 instanceNextDashedPaint;
#define ZOOM_PAINT_PART instanceNextDashedPaint.x
#define ZOOM_PAINT_NEXT_WIDTH instanceNextDashedPaint.y
#define ZOOM_PAINT_NEXT_COLOR zoomPaint_unpackColor(instanceNextDashedPaint.zw)

vec4 zoomPaint_unpackColor(vec2 packedColor) {
  vec2 highBytes = floor(packedColor / 256.0);
  vec2 lowBytes = packedColor - highBytes * 256.0;
  return vec4(highBytes.x, lowBytes.x, highBytes.y, lowBytes.y) / 255.0;
}
`;

/**
 * A dashed path can already use all sixteen guaranteed vertex inputs. Store the two pairs of
 * color bytes as exact integers alongside the width and part in its existing paint input.
 */
const colorBytes = new Uint8ClampedArray(4);
/** Packs two unorm8 color channels into each of two floats for a dashed path. */
export function packZoomPaintColor(color: number[]): [number, number] {
  colorBytes.set(color);
  return [256 * colorBytes[0] + colorBytes[1], 256 * colorBytes[2] + colorBytes[3]];
}

/** Applies per-part widths and colors to a path or flat polygon. */
function createPaintPlugin(path: boolean, composite = false, packed = false) {
  const colorRow = path ? ZOOM_PAINT_LINE_COLOR_ROW : ZOOM_PAINT_FILL_COLOR_ROW;
  const nextColor = path ? 'ZOOM_PAINT_NEXT_COLOR' : 'nextFillColors';
  const colorFactor = path ? 'g' : 'b';
  return createShaderInjectionPlugin({
    ...zoomPaintModule,
    inject: {
      'vs:#decl':
        (packed ? PACKED_PATH_NEXT : STYLE_PART) +
        DECLARATIONS +
        (path && composite ? 'float zoomPaint_currentWidth;\n' : '') +
        (composite && !packed ? (path ? PATH_NEXT : 'in vec4 nextFillColors;') : ''),
      // The size hook is declared before the path shader's own vertex inputs.
      ...(path && composite
        ? {'vs:#main-start': 'zoomPaint_currentWidth = instanceStrokeWidths;'}
        : {}),
      ...(path
        ? {
            'vs:DECKGL_FILTER_SIZE': {
              order: -1,
              injection: (composite
                ? /* glsl */ `
  float currentWidth = zoomPaint_currentWidth;
  float widthFactor = zoomPaint_get(${ZOOM_PAINT_INTERPOLATION_ROW}).r;
  if (widthFactor > 0.0) {
    float width = mix(currentWidth, ZOOM_PAINT_NEXT_WIDTH, widthFactor);
    if (currentWidth > 0.0) {
      size *= width / currentWidth;
    } else {
      vec2 halfWidth = vec2(project_size_to_pixel(width * path.widthScale, path.widthUnits) / 2.0);
      size.xy = path.billboard ? halfWidth : project_pixel_size(halfWidth);
    }
  }
`
                : '') + /* glsl */ `
  size *= zoomPaint_get(${ZOOM_PAINT_WIDTH_ROW}).r;
`
            }
          }
        : {}),
      'vs:DECKGL_FILTER_COLOR': (composite
        ? /* glsl */ `
  vec4 nextColor = ${nextColor};
  nextColor.a *= layer.opacity;
  color = mix(color, nextColor, zoomPaint_get(${ZOOM_PAINT_INTERPOLATION_ROW}).${colorFactor});
`
        : '') + /* glsl */ `
  color = zoomPaint_color(color, ${colorRow});
`,
      // A transparent part can share a batch with visible parts. Clip it in both color and
      // picking passes, so that it writes neither depth nor a picking color.
      'vs:#main-end': /* glsl */ `
  if (zoomPaint_get(${colorRow}).a == 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }
`
    }
  });
}

/** `PathLayer`: widths and line colors. */
const PATH_PLUGIN = createPaintPlugin(true);
/** The path variant that also blends upper endpoint widths and colors. */
const COMPOSITE_PATH_PLUGIN = createPaintPlugin(true, true);
/** The composite variant that uses one vertex input for dashed path paint. */
const PACKED_PATH_PLUGIN = createPaintPlugin(true, true, true);
/** `SolidPolygonLayer`: fill colors. Not for extruded polygons, whose colors are lit. */
const POLYGON_PLUGIN = createPaintPlugin(false);
/** The polygon variant that also blends upper endpoint fill colors. */
const COMPOSITE_POLYGON_PLUGIN = createPaintPlugin(false, true);

function getLayerType(layer: Layer): 'path' | 'polygon' | null {
  const state = layer.state as Record<string, unknown> | undefined;
  if (state && 'pathTesselator' in state) {
    return 'path';
  }
  if (state && 'polygonTesselator' in state) {
    return 'polygon';
  }
  return null;
}

/** The texture last handed to each model's shaders. */
const boundTextures = new WeakMap<object, Texture>();

/**
 * Takes the zoom-dependent paint of the style layers a `PathLayer` or flat `SolidPolygonLayer`
 * draws from a texture instead of attributes: per style layer, its line width and, when they are
 * the same for all of its features, its colors. It also uses the texture's blend factors to
 * interpolate per-feature paint between attributes evaluated at the enclosing zoom steps.
 * The values are read when the layer draws, so zooming within a step changes a small texture,
 * shared by every layer with the same `zoomPaint`. The layers' props, and so their attributes,
 * stay the same. Each object's style layer is an attribute, which
 * changes only with the data.
 *
 * The width factor applies after `widthMinPixels` and `widthMaxPixels`, which must not clamp.
 * The owner of a `ZoomPaint` destroys its texture. WebGL only.
 */
export class ZoomPaintExtension extends LayerExtension<{composite: boolean; packedPath: boolean}> {
  static extensionName = 'ZoomPaintExtension';
  static defaultProps = {
    zoomPaint: {type: 'object', value: null},
    zoomPaintGeneration: {type: 'object', value: null},
    zoomPaintBucket: {type: 'number', value: null, optional: true},
    getStylePart: {type: 'accessor', value: 0},
    getNextLineWidth: {type: 'accessor', value: 1},
    getNextLineColor: {type: 'accessor', value: [0, 0, 0, 0]},
    getNextFillColor: {type: 'accessor', value: [0, 0, 0, 0]},
    getNextDashedPaint: {type: 'accessor', value: [0, 1, 0, 0]}
  };

  /** Selects the shader variant and the attributes it needs for the upper zoom endpoint. */
  constructor({composite = false, packedPath = false} = {}) {
    super({composite, packedPath});
  }

  isEnabled(layer: Layer): boolean {
    return getLayerType(layer) !== null;
  }

  getShaders(this: Layer<ZoomPaintExtensionProps>, extension: this): any {
    const type = getLayerType(this);
    if (!type) {
      return null;
    }
    const {composite, packedPath} = extension.opts;
    const pathPlugin = packedPath ? PACKED_PATH_PLUGIN : COMPOSITE_PATH_PLUGIN;
    const compositePlugin = type === 'path' ? pathPlugin : COMPOSITE_POLYGON_PLUGIN;
    const basePlugin = type === 'path' ? PATH_PLUGIN : POLYGON_PLUGIN;
    return {plugins: [composite ? compositePlugin : basePlugin]};
  }

  /** Matches the layer's paint attributes to the selected shader variant. */
  private synchronizeAttributes(layer: Layer): void {
    const type = getLayerType(layer);
    const manager = layer.getAttributeManager();
    if (!type || !manager) {
      return;
    }

    const {composite, packedPath} = this.opts;
    const packed = composite && type === 'path' && packedPath;
    const desired: Parameters<AttributeManager['add']>[0] = packed
      ? {
          instanceNextDashedPaint: {size: 4, stepMode: 'instance', accessor: 'getNextDashedPaint'}
        }
      : {
          instanceStyleParts: {size: 1, stepMode: 'dynamic', accessor: 'getStylePart', defaultValue: 0}
        };
    if (composite && !packed) {
      if (type === 'path') {
        desired.instanceNextLineWidths = {size: 1, stepMode: 'instance', accessor: 'getNextLineWidth'};
        desired.instanceNextLineColors = {size: 4, type: 'unorm8', stepMode: 'instance', accessor: 'getNextLineColor'};
      } else {
        desired.nextFillColors = {size: 4, type: 'unorm8', stepMode: 'dynamic', accessor: 'getNextFillColor'};
      }
    }
    const attributes = manager.getAttributes();
    const removed = [
      'instanceNextDashedPaint', 'instanceStyleParts', 'instanceNextLineWidths',
      'instanceNextLineColors', 'nextFillColors'
    ].filter(name => attributes[name] && !desired[name]);
    const added = Object.entries(desired).filter(([name]) => !attributes[name]);
    if (removed.length || added.length) {
      manager.remove(removed);
      manager.add(Object.fromEntries(added));
      manager.invalidateAll();
      // A style edit can switch shader variants on a layer whose model has already been created.
      for (const model of layer.getModels()) {
        model.setBufferLayout(manager.getBufferLayouts(model));
      }
    }
  }

  initializeState(this: Layer<ZoomPaintExtensionProps>, context: LayerContext, extension: this) {
    extension.synchronizeAttributes(this);
  }

  /** Updates the paint attributes when the layer switches shader variants. */
  updateState(
    this: Layer<ZoomPaintExtensionProps>,
    params: UpdateParameters<Layer<ZoomPaintExtensionProps>>,
    extension: this
  ) {
    if (params.changeFlags.extensionsChanged) {
      extension.synchronizeAttributes(this);
    }
  }

  draw(this: Layer<ZoomPaintExtensionProps>, params: any, extension: this) {
    const {zoomPaint, zoomPaintGeneration, zoomPaintBucket} = this.props;
    if (!zoomPaint || !extension.isEnabled(this)) {
      return;
    }
    const texture = zoomPaint.getTexture(
      this.context.device,
      getZoomPaintZoom(getStyleZoom(this.context.viewport), zoomPaintGeneration?.zoom),
      zoomPaintBucket ?? undefined
    );
    const models = this.getModels();
    if (models.some(model => boundTextures.get(model) !== texture)) {
      this.setShaderModuleProps({zoomPaint: {zoomPaintTexture: texture}} as any);
      for (const model of models) {
        boundTextures.set(model, texture);
      }
    }
  }
}
