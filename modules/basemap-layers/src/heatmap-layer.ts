// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  Layer,
  log,
  project32,
  type Accessor,
  type DefaultProps,
  type LayerProps,
  type UpdateParameters
} from '@deck.gl/core';
import type {Framebuffer, Texture} from '@luma.gl/core';
import {Geometry, Model} from '@luma.gl/engine';
import type {ShaderModule} from '@luma.gl/shaders';
import {lngLatToMercatorWorld, mercatorWorldToLngLat, MERCATOR_WORLD_SIZE} from './projected-viewport';
import {getStyleAccessor, type StyleAccessor} from './style-accessor';
import {
  compileStylePropertyValue,
  getCompiledStyleProperty,
  getStylePropertyDefault,
  type CompiledStyleProperty,
  type StyleFeature
} from './style-expression';
import type {ResolvedBasemapStyleLayer as BasemapStyleLayer} from './style-resolver';

const DEFAULT_RADIUS = getStylePropertyDefault('heatmap-radius') as number;
const DEFAULT_WEIGHT = getStylePropertyDefault('heatmap-weight') as number;
const DEFAULT_INTENSITY = getStylePropertyDefault('heatmap-intensity') as number;
const DEFAULT_OPACITY = getStylePropertyDefault('heatmap-opacity') as number;

/** The texels of a color ramp, as MapLibre GL JS renders `heatmap-color`. */
export const COLOR_RAMP_SIZE = 256;

/**
 * The density texture is a quarter of the drawing buffer wide and high, as MapLibre GL JS draws
 * it, and filtered linearly when it is colored.
 */
const DENSITY_TEXTURE_SCALE = 4;

/** A point of a heatmap: its longitude/latitude position and the feature it comes from. */
export type HeatmapPoint = {
  position: [number, number];
  feature: StyleFeature;
};

const kernelUniformBlock = /* glsl */ `\
layout(std140) uniform heatmapKernelUniforms {
  float intensity;
} heatmapKernel;
`;

type HeatmapKernelProps = {intensity: number};

const heatmapKernelUniforms = {
  name: 'heatmapKernel',
  vs: kernelUniformBlock,
  fs: kernelUniformBlock,
  uniformTypes: {intensity: 'f32'}
} as const satisfies ShaderModule<HeatmapKernelProps>;

/**
 * MapLibre GL JS's kernel (`heatmap.vertex.glsl`): a Gaussian of standard deviation
 * `heatmap-radius / 3` pixels on the map plane, drawn on a square that ends where the kernel
 * falls below `ZERO`. Kernels whose peak is below `ZERO` are not drawn.
 */
const kernelVs = /* glsl */ `\
#version 300 es
#define SHADER_NAME basemap-heatmap-kernel-vertex-shader

in vec3 positions;
in vec3 instancePositions;
in vec3 instancePositions64Low;
in float instanceWeights;
in float instanceRadius;

out vec2 vExtrude;
out float vWeight;

const float ZERO = 1.0 / 255.0 / 16.0;
const float GAUSS_COEF = 0.3989422804014327;

void main(void) {
  geometry.worldPosition = instancePositions;
  vWeight = instanceWeights;
  float S = sqrt(-2.0 * log(ZERO / instanceWeights / heatmapKernel.intensity / GAUSS_COEF)) / 3.0;
  if (!(S > 0.0) || !(instanceRadius > 0.0)) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }
  vExtrude = S * positions.xy;
  vec3 offset = vec3(project_pixel_size(vExtrude * instanceRadius), 0.0);
  gl_Position = project_position_to_clipspace(
    instancePositions, instancePositions64Low, offset, geometry.position
  );
}
`;

const kernelFs = /* glsl */ `\
#version 300 es
#define SHADER_NAME basemap-heatmap-kernel-fragment-shader

precision highp float;

in vec2 vExtrude;
in float vWeight;

out vec4 fragColor;

const float GAUSS_COEF = 0.3989422804014327;

void main(void) {
  float d = -0.5 * 3.0 * 3.0 * dot(vExtrude, vExtrude);
  float density = vWeight * heatmapKernel.intensity * GAUSS_COEF * exp(d);
  fragColor = vec4(density, 1.0, 1.0, 1.0);
}
`;

const compositeUniformBlock = /* glsl */ `\
layout(std140) uniform heatmapColorUniforms {
  float opacity;
} heatmapColor;
`;

type HeatmapColorProps = {opacity: number};

const heatmapColorUniforms = {
  name: 'heatmapColor',
  vs: compositeUniformBlock,
  fs: compositeUniformBlock,
  uniformTypes: {opacity: 'f32'}
} as const satisfies ShaderModule<HeatmapColorProps>;

const compositeVs = /* glsl */ `\
#version 300 es
#define SHADER_NAME basemap-heatmap-color-vertex-shader

in vec2 positions;
out vec2 vTexCoord;

void main(void) {
  vTexCoord = positions * 0.5 + 0.5;
  gl_Position = vec4(positions, 0.0, 1.0);
}
`;

/** MapLibre GL JS's `heatmap_texture.fragment.glsl`: the density, colored by the ramp. */
const compositeFs = /* glsl */ `\
#version 300 es
#define SHADER_NAME basemap-heatmap-color-fragment-shader

precision highp float;

uniform sampler2D densityTexture;
uniform sampler2D colorRamp;

in vec2 vTexCoord;
out vec4 fragColor;

void main(void) {
  float density = texture(densityTexture, vTexCoord).r;
  fragColor = texture(colorRamp, vec2(density, 0.5)) * heatmapColor.opacity;
}
`;

/** Additive blending, which sums the kernels into a density. */
const KERNEL_PARAMETERS = {
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'one',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one',
  depthWriteEnabled: false,
  depthCompare: 'always',
  cullMode: 'none'
} as const;

/** The ramp is premultiplied, so the colored density is blended as premultiplied color. */
const COMPOSITE_PARAMETERS = {
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'one',
  blendColorDstFactor: 'one-minus-src-alpha',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
  depthWriteEnabled: false,
  depthCompare: 'always',
  cullMode: 'none'
} as const;

/** Props of {@link BasemapHeatmapLayer}. */
export type BasemapHeatmapLayerProps<DataT = HeatmapPoint> = {
  data: DataT[];
  /** The longitude/latitude of a point. */
  getPosition?: Accessor<DataT, [number, number]>;
  /** `heatmap-weight`: a point's share of the density. */
  getWeight?: Accessor<DataT, number>;
  /** `heatmap-radius`, in pixels. */
  getRadius?: Accessor<DataT, number>;
  /** `heatmap-intensity`: multiplies the density of every point. */
  intensity?: number;
  /**
   * `heatmap-color`, as `COLOR_RAMP_SIZE` premultiplied RGBA texels, from density 0 to 1 (see
   * `getHeatmapColorRamp`). The layer's `opacity` is `heatmap-opacity`.
   */
  colorRamp: Uint8Array;
};

type DensityTarget = {framebuffer: Framebuffer; texture: Texture};

/**
 * Draws a `heatmap` style layer as MapLibre GL JS does: each point adds a Gaussian kernel to a
 * density texture a quarter of the drawing buffer's size, with additive blending, and the density
 * is then colored by `heatmap-color` over the whole view. Kernels are on the map plane: on a globe
 * they lie on the sphere, and in a projected view on the plane of the view's projection. WebGL
 * only; on WebGPU the layer draws nothing.
 */
export class BasemapHeatmapLayer<DataT = HeatmapPoint> extends Layer<
  Required<BasemapHeatmapLayerProps<DataT>> & LayerProps
> {
  static layerName = 'BasemapHeatmapLayer';
  static defaultProps: DefaultProps<BasemapHeatmapLayerProps<any>> = {
    getPosition: {type: 'accessor', value: (point: HeatmapPoint) => point.position},
    getWeight: {type: 'accessor', value: DEFAULT_WEIGHT},
    getRadius: {type: 'accessor', value: DEFAULT_RADIUS},
    intensity: {type: 'number', value: DEFAULT_INTENSITY},
    colorRamp: {type: 'object', value: null, compare: true}
  } as any;

  declare state: {
    model?: Model;
    compositeModel?: Model;
    colorRampTexture?: Texture;
    /** The density texture of each view, by viewport id. */
    densityTargets: Map<string, DensityTarget>;
    densityFormat: 'rgba16float' | 'rgba8unorm';
  };

  getShaders() {
    return super.getShaders({
      vs: kernelVs,
      fs: kernelFs,
      modules: [project32, heatmapKernelUniforms]
    });
  }

  initializeState(): void {
    const {device} = this.context;
    this.state = {densityTargets: new Map(), densityFormat: 'rgba16float'};
    if (device.type === 'webgpu') {
      return;
    }
    // MapLibre GL JS accumulates the density in half floats.
    if (!device.isTextureFormatRenderable('rgba16float')) {
      log.warn(
        `${this.id}: rendering to half-float textures is not supported, heatmap densities are clamped`
      )();
      this.state.densityFormat = 'rgba8unorm';
    }
    this.getAttributeManager()!.addInstanced({
      instancePositions: {
        size: 3,
        type: 'float64',
        fp64: this.use64bitPositions(),
        accessor: 'getPosition',
        ...this.usePositionTransforms()
      },
      instanceWeights: {size: 1, accessor: 'getWeight', defaultValue: DEFAULT_WEIGHT},
      instanceRadius: {size: 1, accessor: 'getRadius', defaultValue: DEFAULT_RADIUS}
    });
    this.state.model = this.getKernelModel();
    this.state.compositeModel = new Model(device, {
      id: `${this.props.id}-color`,
      vs: compositeVs,
      fs: compositeFs,
      modules: [heatmapColorUniforms],
      geometry: new Geometry({
        topology: 'triangle-strip',
        attributes: {positions: {size: 2, value: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])}}
      }),
      parameters: COMPOSITE_PARAMETERS
    });
    this.state.colorRampTexture = device.createTexture({
      format: 'rgba8unorm',
      width: COLOR_RAMP_SIZE,
      height: 1,
      mipLevels: 1,
      sampler: {
        minFilter: 'linear',
        magFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
      }
    });
  }

  private getKernelModel(): Model {
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      geometry: new Geometry({
        topology: 'triangle-strip',
        attributes: {
          positions: {size: 3, value: new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0])}
        }
      }),
      isInstanced: true
    });
  }

  updateState(params: UpdateParameters<this>): void {
    super.updateState(params);
    if (!this.state.model) {
      return;
    }
    if (params.changeFlags.extensionsChanged) {
      this.state.model.destroy();
      this.state.model = this.getKernelModel();
      this.getAttributeManager()!.invalidateAll();
    }
    const {colorRamp} = params.props;
    if (colorRamp && colorRamp !== params.oldProps.colorRamp) {
      this.state.colorRampTexture!.writeData(colorRamp);
    }
  }

  finalizeState(context: any): void {
    super.finalizeState(context);
    this.state.compositeModel?.destroy();
    this.state.colorRampTexture?.destroy();
    for (const target of this.state.densityTargets.values()) {
      target.framebuffer.destroy();
      target.texture.destroy();
    }
    this.state.densityTargets.clear();
  }

  /** The density texture of the current view, a quarter of its size in device pixels. */
  private getDensityTarget(width: number, height: number): DensityTarget {
    const {viewport, device} = this.context;
    const key = viewport.id || 'default';
    let target = this.state.densityTargets.get(key);
    if (target && (target.texture.width !== width || target.texture.height !== height)) {
      target.framebuffer.destroy();
      target.texture.destroy();
      target = undefined;
    }
    if (!target) {
      const texture = device.createTexture({
        id: `${this.props.id}-density`,
        format: this.state.densityFormat,
        width,
        height,
        mipLevels: 1,
        sampler: {
          minFilter: 'linear',
          magFilter: 'linear',
          addressModeU: 'clamp-to-edge',
          addressModeV: 'clamp-to-edge'
        }
      });
      const framebuffer = device.createFramebuffer({width, height, colorAttachments: [texture]});
      target = {framebuffer, texture};
      this.state.densityTargets.set(key, target);
    }
    return target;
  }

  draw({shaderModuleProps}: any): void {
    const {model, compositeModel, colorRampTexture} = this.state;
    const {opacity, intensity, colorRamp} = this.props;
    const instanceCount = this.getNumInstances();
    if (!model || !compositeModel || !colorRamp || !(opacity > 0) || instanceCount === 0) {
      return;
    }
    if (shaderModuleProps?.picking?.isActive) {
      return;
    }
    const {viewport, device, renderPass} = this.context;
    const pixelRatio = shaderModuleProps?.project?.devicePixelRatio ?? 1;
    const width = Math.max(1, Math.floor((viewport.width * pixelRatio) / DENSITY_TEXTURE_SCALE));
    const height = Math.max(1, Math.floor((viewport.height * pixelRatio) / DENSITY_TEXTURE_SCALE));
    const target = this.getDensityTarget(width, height);

    model.shaderInputs.setProps({heatmapKernel: {intensity}});
    model.setInstanceCount(instanceCount);
    // deck.gl gives the layer's models the layer's parameters before each draw.
    model.setParameters(KERNEL_PARAMETERS);
    // The density is drawn in a render pass of its own; on WebGL the current pass resumes after it.
    const densityPass = device.beginRenderPass({
      id: `${this.props.id}-density`,
      framebuffer: target.framebuffer,
      parameters: {viewport: [0, 0, width, height]},
      clearColor: [0, 0, 0, 0],
      clearDepth: false,
      clearStencil: false
    });
    try {
      model.draw(densityPass);
    } finally {
      densityPass.end();
    }

    compositeModel.shaderInputs.setProps({heatmapColor: {opacity}});
    compositeModel.setBindings({densityTexture: target.texture, colorRamp: colorRampTexture!});
    compositeModel.draw(renderPass);
  }
}

const colorRampCache = new WeakMap<CompiledStyleProperty, Uint8Array>();
let defaultColor: CompiledStyleProperty | null | undefined;

/**
 * `heatmap-color` as `COLOR_RAMP_SIZE` premultiplied RGBA texels, as MapLibre GL JS renders the
 * ramp (`renderColorRamp`): the color at density `i / 255`, rounded to 8 bits unpremultiplied and
 * then premultiplied, as WebGL premultiplies the ramp it uploads. The same array is returned while
 * the property is unchanged.
 */
export function getHeatmapColorRamp(styleLayer: BasemapStyleLayer): Uint8Array {
  let property = getCompiledStyleProperty(styleLayer, 'heatmap-color');
  if (!property) {
    defaultColor ??= compileStylePropertyValue(
      'heatmap-color',
      getStylePropertyDefault('heatmap-color')
    );
    property = defaultColor!;
  }
  let ramp = colorRampCache.get(property);
  if (!ramp) {
    ramp = new Uint8Array(COLOR_RAMP_SIZE * 4);
    for (let index = 0; index < COLOR_RAMP_SIZE; index++) {
      const color = property.evaluateWithGlobals({
        zoom: 0,
        heatmapDensity: index / (COLOR_RAMP_SIZE - 1)
      }) as number[] | null;
      const alpha = Math.round((color?.[3] ?? 0) * 255);
      for (let channel = 0; channel < 3; channel++) {
        const straight = alpha > 0 ? Math.round(color![channel]) : 0;
        ramp[index * 4 + channel] = Math.round((straight * alpha) / 255);
      }
      ramp[index * 4 + 3] = alpha;
    }
    colorRampCache.set(property, ramp);
  }
  return ramp;
}

type TileIndex = {x: number; y: number; z: number};

const tilePointCache = new WeakMap<any[], Map<string, HeatmapPoint[]>>();

/**
 * The points of a tile's features (each point of a multipoint) that lie in the tile, with their
 * longitude/latitude. A tile's features include a buffer around it, which its neighbors also hold;
 * MapLibre GL JS leaves out the points outside a tile, so that each point adds to the density once.
 * `features` are tile-local, from 0 to 1 across the tile, or in longitude/latitude with `lngLat`.
 */
export function getHeatmapPoints(features: any[], index: TileIndex, lngLat: boolean): HeatmapPoint[] {
  const key = `${index.x}/${index.y}/${index.z}/${lngLat}`;
  let cache = tilePointCache.get(features);
  if (!cache) {
    cache = new Map();
    tilePointCache.set(features, cache);
  }
  let points = cache.get(key);
  if (!points) {
    points = [];
    const scale = 2 ** index.z;
    const add = (feature: StyleFeature, coordinates: number[]) => {
      let x: number;
      let y: number;
      let position: [number, number];
      if (lngLat) {
        const [worldX, worldY] = lngLatToMercatorWorld([coordinates[0], coordinates[1]]);
        x = (worldX / MERCATOR_WORLD_SIZE) * scale - index.x;
        y = (1 - worldY / MERCATOR_WORLD_SIZE) * scale - index.y;
        position = [coordinates[0], coordinates[1]];
      } else {
        [x, y] = coordinates;
        position = mercatorWorldToLngLat([
          (MERCATOR_WORLD_SIZE * (index.x + x)) / scale,
          MERCATOR_WORLD_SIZE * (1 - (index.y + y) / scale)
        ]) as [number, number];
      }
      if (x >= 0 && x < 1 && y >= 0 && y < 1) {
        points!.push({position, feature});
      }
    };
    for (const feature of features) {
      const geometry = feature.geometry;
      if (geometry?.type === 'Point') {
        add(feature, geometry.coordinates);
      } else if (geometry?.type === 'MultiPoint') {
        for (const coordinates of geometry.coordinates) {
          add(feature, coordinates);
        }
      }
    }
    cache.set(key, points);
  }
  return points;
}

/**
 * The tiles of `tiles` that no other tile of `tiles` covers. Where a tile and its ancestor are both
 * drawn, as while the tile's siblings load, MapLibre GL JS draws the heatmap of the ancestor only.
 */
export function getTilesWithoutDrawnAncestor<T extends {index: TileIndex}>(tiles: T[]): T[] {
  const drawn = new Set(tiles.map(({index}) => `${index.x}/${index.y}/${index.z}`));
  return tiles.filter(({index}) => {
    for (let z = index.z - 1; z >= 0; z--) {
      const scale = 2 ** (index.z - z);
      if (drawn.has(`${Math.floor(index.x / scale)}/${Math.floor(index.y / scale)}/${z}`)) {
        return false;
      }
    }
    return true;
  });
}

/** A style accessor of features as an accessor of the points that carry them. */
function getPointAccessor<T>(accessor: StyleAccessor<T>): StyleAccessor<T> {
  const {value} = accessor;
  if (typeof value !== 'function') {
    return accessor;
  }
  const evaluate = value as (feature: StyleFeature) => T;
  return {...accessor, value: ((point: HeatmapPoint) => evaluate(point.feature)) as any};
}

/**
 * The layer of a `heatmap` style layer, drawing the points of all of its run's drawn tiles (see
 * `getHeatmapPoints`). `heatmap-radius` and `heatmap-weight` are evaluated per feature;
 * `heatmap-intensity` and `heatmap-opacity` at the style zoom. Nothing is drawn at
 * `heatmap-opacity: 0`, as in MapLibre GL JS.
 */
export function createHeatmapSubLayer({
  props,
  styleLayer,
  points,
  zoom
}: {
  props: Record<string, any>;
  styleLayer: BasemapStyleLayer;
  points: HeatmapPoint[];
  zoom: number;
}): BasemapHeatmapLayer | null {
  const radius = getPointAccessor(
    getStyleAccessor(styleLayer, ['heatmap-radius'], zoom, ([value]) =>
      Math.max(0, Number(value ?? DEFAULT_RADIUS) || 0)
    )
  );
  const weight = getPointAccessor(
    getStyleAccessor(styleLayer, ['heatmap-weight'], zoom, ([value]) =>
      Math.max(0, Number(value ?? DEFAULT_WEIGHT) || 0)
    )
  );
  const intensity = getStyleAccessor(styleLayer, ['heatmap-intensity'], zoom, ([value]) =>
    Math.max(0, Number(value ?? DEFAULT_INTENSITY) || 0)
  ).value as number;
  const opacity = getStyleAccessor(styleLayer, ['heatmap-opacity'], zoom, ([value]) =>
    Math.min(1, Math.max(0, Number(value ?? DEFAULT_OPACITY) || 0))
  ).value as number;
  if (points.length === 0 || opacity === 0) {
    return null;
  }
  return new BasemapHeatmapLayer({
    ...props,
    data: points,
    // Points are in longitude/latitude, whatever the tile layer's coordinates.
    coordinateSystem: 'lnglat',
    coordinateOrigin: [0, 0, 0],
    modelMatrix: null,
    extensions: [],
    pickable: false,
    opacity: (props.opacity ?? 1) * opacity,
    getRadius: radius.value,
    getWeight: weight.value,
    intensity,
    colorRamp: getHeatmapColorRamp(styleLayer),
    updateTriggers: {
      getRadius: radius.updateTrigger,
      getWeight: weight.updateTrigger
    }
  } as any);
}
