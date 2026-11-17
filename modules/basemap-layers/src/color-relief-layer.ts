// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Portions adapted from MapLibre GL JS
// SPDX-License-Identifier: BSD-3-Clause
// Copyright (c) 2023, MapLibre contributors
// Copyright (c) 2020, Mapbox

/**
 * @license
 * Portions of this file are adapted from MapLibre GL JS v6.13.0,
 * src/shaders/glsl/color_relief.fragment.glsl and
 * src/style/style_layer/color_relief_style_layer.ts,
 * under these licenses (see also THIRD-PARTY-NOTICES.md):
 *
 * Copyright (c) 2023, MapLibre contributors
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *     * Redistributions of source code must retain the above copyright notice,
 *       this list of conditions and the following disclaimer.
 *     * Redistributions in binary form must reproduce the above copyright notice,
 *       this list of conditions and the following disclaimer in the documentation
 *       and/or other materials provided with the distribution.
 *     * Neither the name of MapLibre GL JS nor the names of its contributors
 *       may be used to endorse or promote products derived from this software
 *       without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 *
 * MapLibre GL JS contains code from mapbox-gl-js v1.13 and earlier, licensed under a
 * BSD-3-Clause license:
 *
 * Copyright (c) 2020, Mapbox
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 * * Neither the name of Mapbox GL JS nor the names of its contributors
 *   may be used to endorse or promote products derived from this software
 *   without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
 * EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import type {Layer, LayersList, UpdateParameters} from '@deck.gl/core';
import type {Device, Texture} from '@luma.gl/core';
import {
  type DemNeighbors,
  type DemTile,
  type DemTileHeader,
  DemTileLayer,
  type DemTileLayerProps,
  type DemUnpackVector,
  PREMULTIPLIED_BLEND_PARAMETERS,
  getBorderedElevations
} from './hillshade-layer';
import {ProjectedBitmapLayer} from './projected-bitmap-layer';
import {type ColorRampStops, getColorRampStops} from './style-expression';

/**
 * `color-relief` style layers over `raster-dem` sources, drawn as MapLibre GL JS draws them.
 *
 * MapLibre reads the stops of the `color-relief-color` ramp, an `interpolate` expression over
 * `["elevation"]`, into two textures: the stops' elevations, packed with the DEM's encoding, and
 * their colors. Its fragment shader finds a pixel's elevation between two stops with a binary
 * search and blends their colors linearly, whatever the interpolation type. Here the ramp is one
 * float texture of the same values, and the DEM tile a texture of its elevations, with a
 * one-pixel border from its neighbors, as the hillshade layers prepare theirs.
 */

/** A color ramp, as MapLibre GL JS's `ColorReliefStyleLayer` makes it. */
export type ColorRamp = {
  /** Elevations in meters, ascending. */
  elevationStops: number[];
  /** Premultiplied RGBA in 0-1, one per elevation stop. */
  colorStops: [number, number, number, number][];
};

const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];

/**
 * The stops of each `color-relief-color` value, with its contents when they were read, so that a
 * value edited in place is read again.
 */
const stopsCache = new WeakMap<object, {snapshot: string; stops: ColorRampStops | null}>();

function getStops(value: unknown): ColorRampStops | null {
  if (!value || typeof value !== 'object') {
    return getColorRampStops('color-relief-color', value, 'elevation');
  }
  const snapshot = JSON.stringify(value);
  let cached = stopsCache.get(value);
  if (cached?.snapshot !== snapshot) {
    cached = {snapshot, stops: getColorRampStops('color-relief-color', value, 'elevation')};
    stopsCache.set(value, cached);
  }
  return cached.stops;
}

/**
 * The color ramp of a `color-relief-color` value, at most `maxLength` stops long, as MapLibre GL JS
 * creates it: the stops of an `interpolate` expression, or one transparent stop for any other
 * value. A single stop is repeated one meter higher. A longer ramp is resampled to `maxLength`
 * stops, which MapLibre warns may not render properly.
 */
export function createColorRamp(value: unknown, maxLength: number): ColorRamp {
  const stops = getStops(value);
  const ramp: ColorRamp = stops
    ? {elevationStops: [...stops.inputs], colorStops: [...stops.colors]}
    : {elevationStops: [], colorStops: []};
  if (ramp.elevationStops.length < 1) {
    ramp.elevationStops = [0];
    ramp.colorStops = [TRANSPARENT];
  }
  if (ramp.elevationStops.length < 2) {
    ramp.elevationStops.push(ramp.elevationStops[0] + 1);
    ramp.colorStops.push(ramp.colorStops[0]);
  }
  if (ramp.elevationStops.length <= maxLength) {
    return ramp;
  }
  const remapped: ColorRamp = {elevationStops: [], colorStops: []};
  const step = (ramp.elevationStops.length - 1) / (maxLength - 1);
  for (let i = 0; i < ramp.elevationStops.length - 0.5; i += step) {
    remapped.elevationStops.push(ramp.elevationStops[Math.round(i)]);
    remapped.colorStops.push(ramp.colorStops[Math.round(i)]);
  }
  return remapped;
}

/** Whether a ramp draws anything: whether any of its colors is not transparent. */
export function isColorRampVisible(ramp: ColorRamp): boolean {
  return ramp.colorStops.some(color => color[3] > 0);
}

/**
 * An elevation as the shader reads a DEM pixel of it: rounded to the steps of the encoding
 * `unpack`, `min(factors)` meters, within what its 8-bit red, green and blue hold, as MapLibre GL
 * JS's `packDEMData` rounds it; then to the steps of the elevation texture (see
 * `prepareColorReliefTexture`). Unlike `packDEMData`, it counts the elevation once where factors
 * overlap, as in the default custom factors `[1, 1, 1, 0]`, whose pixel `[100, 0, 0]` is 100 m.
 */
export function quantizeElevation(
  elevation: number,
  [redFactor, greenFactor, blueFactor, baseShift]: DemUnpackVector
): number {
  const factors = [redFactor, greenFactor, blueFactor].filter(factor => factor !== 0);
  if (factors.length === 0) {
    return getTextureElevation(-baseShift);
  }
  const minScale = Math.min(...factors);
  const maxSteps = Math.round((255 * factors.reduce((sum, factor) => sum + factor)) / minScale);
  const steps = Math.min(Math.max(Math.round((elevation + baseShift) / minScale), 0), maxSteps);
  return getTextureElevation(steps * minScale - baseShift);
}

/**
 * The texels of a ramp's texture, `colorStops.length` wide and 2 high, RGBA: the first row holds
 * the colors, premultiplied and rounded to 8 bits as MapLibre GL JS uploads them, and the second
 * the elevations, in red, as the shader reads them back from the DEM encoding `unpack`.
 */
export function getColorRampTexels(ramp: ColorRamp, unpack: DemUnpackVector): Float32Array {
  const size = ramp.colorStops.length;
  const texels = new Float32Array(size * 2 * 4);
  ramp.colorStops.forEach(([r, g, b, a], index) => {
    // MapLibre stores the color unpremultiplied in 8 bits, and premultiplies it on upload.
    const alpha = Math.round(a * 255);
    const premultiply = (channel: number) =>
      a === 0 ? 0 : Math.round((Math.round((channel * 255) / a) * alpha) / 255) / 255;
    texels.set([premultiply(r), premultiply(g), premultiply(b), alpha / 255], index * 4);
  });
  ramp.elevationStops.forEach((elevation, index) => {
    texels[(size + index) * 4] = quantizeElevation(elevation, unpack);
  });
  return texels;
}

/** The elevations a DEM texture holds: as terrarium, in 1/256 meter steps. */
const ELEVATION_SHIFT = 32768;
const ELEVATION_STEPS = 256;
const MAX_TEXTURE_VALUE = 2 ** 24 - 1;

/** An elevation as the elevation texture stores it, in 1/256 meter steps, 24 bits. */
function getTextureValue(elevation: number): number {
  return Math.min(
    Math.max(Math.round((elevation + ELEVATION_SHIFT) * ELEVATION_STEPS), 0),
    MAX_TEXTURE_VALUE
  );
}

/** An elevation as the shader reads it from the elevation texture. */
function getTextureElevation(elevation: number): number {
  return getTextureValue(elevation) / ELEVATION_STEPS - ELEVATION_SHIFT;
}

/**
 * The elevation texture of a DEM tile, `dim + 2` pixels square: the tile and a one-pixel border
 * from its loaded neighbors (see `getBorderedElevations`), RGBA. Elevations are encoded as
 * terrarium: `R * 256 + G + B / 256 - 32768`, whatever the source's encoding, which keeps their
 * linear filtering, and are clamped to that encoding's range.
 */
export function prepareColorReliefTexture(
  dem: DemTile,
  getNeighbor: DemNeighbors = () => null
): Uint8ClampedArray<ArrayBuffer> {
  const getElevation = getBorderedElevations(dem, getNeighbor);
  const size = dem.dim + 2;
  const texture = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const value = getTextureValue(getElevation(column - 1, row - 1));
      const index = (row * size + column) * 4;
      texture[index] = Math.floor(value / 65536);
      texture[index + 1] = Math.floor(value / 256) % 256;
      texture[index + 2] = value % 256;
      texture[index + 3] = 255;
    }
  }
  return texture;
}

/** The `colorRelief` shader module's uniforms and bindings. */
export type ColorReliefUniforms = {
  /** `color-relief-opacity`. */
  opacity: number;
  /** The number of stops in the ramp. */
  rampSize: number;
  colorReliefRamp?: Texture;
};

const colorReliefModule = {
  name: 'colorRelief',
  fs: /* glsl */ `\
layout(std140) uniform colorReliefUniforms {
  float opacity;
  float rampSize;
} colorRelief;

// Colors in the first row, elevations in the second.
uniform highp sampler2D colorReliefRamp;

float colorRelief_getStop(int stop) {
  return texelFetch(colorReliefRamp, ivec2(stop, 1), 0).r;
}

// MapLibre GL JS's color-relief fragment shader. \`uv\` is the position in the tile.
vec4 colorRelief_getColor(sampler2D dem, vec2 uv) {
  // The texture has a one-pixel border around the tile.
  vec2 size = vec2(textureSize(dem, 0));
  vec4 data = texture(dem, (uv * (size - 2.0) + 1.0) / size) * 255.0;
  data.a = -1.0;
  float elevation = dot(data, vec4(256.0, 1.0, 1.0 / 256.0, 32768.0));

  // Binary search for the stops around the elevation.
  int count = int(colorRelief.rampSize + 0.5);
  int r = count - 1;
  int l = 0;
  float elevationL = colorRelief_getStop(l);
  float elevationR = colorRelief_getStop(r);
  while (r - l > 1) {
    int m = (r + l) / 2;
    float elevationM = colorRelief_getStop(m);
    if (elevation < elevationM) {
      r = m;
      elevationR = elevationM;
    } else {
      l = m;
      elevationL = elevationM;
    }
  }
  // Stops that round to one elevation step have no width: an elevation at or above them takes the
  // upper stop's color, as the search does where equal stops are followed by another.
  float t = elevationR > elevationL
    ? (elevation - elevationL) / (elevationR - elevationL)
    : (elevation < elevationL ? 0.0 : 1.0);
  // MapLibre samples a linearly filtered texture of the colors, clamped to its edges.
  float x = clamp(float(l) + t, 0.0, float(count - 1));
  int i = min(int(x), count - 2);
  vec4 color = mix(
    texelFetch(colorReliefRamp, ivec2(i, 0), 0),
    texelFetch(colorReliefRamp, ivec2(i + 1, 0), 0),
    x - float(i)
  );
  return color * colorRelief.opacity;
}
`,
  uniformTypes: {
    opacity: 'f32',
    rampSize: 'f32'
  }
} as const;

/** A ramp's texture, created by the `ColorReliefTileLayer` that owns it. */
export type ColorRampTexture = {texture: Texture; size: number};

type ColorReliefBitmapLayerProps = {
  colorRampTexture: ColorRampTexture;
  colorReliefOpacity: number;
};

/**
 * A `BitmapLayer` whose image is a tile's elevation texture (see `prepareColorReliefTexture`),
 * colored by a ramp as MapLibre GL JS colors it. WebGL only.
 */
class ColorReliefBitmapLayer extends ProjectedBitmapLayer<ColorReliefBitmapLayerProps> {
  static layerName = 'ColorReliefBitmapLayer';

  getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      modules: [...shaders.modules, colorReliefModule],
      inject: {
        ...shaders.inject,
        // At the end of main(), where the bitmap's sampler is in scope.
        'fs:#main-end': /* glsl */ `
  if (!bool(picking.isActive)) {
    fragColor = colorRelief_getColor(bitmapTexture, geometry.uv) * layer.opacity;
  }
`
      }
    };
  }

  draw(options: any) {
    const {colorRampTexture, colorReliefOpacity} = this.props;
    const colorRelief: ColorReliefUniforms = {
      opacity: colorReliefOpacity,
      rampSize: colorRampTexture.size,
      colorReliefRamp: colorRampTexture.texture
    };
    for (const model of this.getModels()) {
      model.shaderInputs.setProps({colorRelief});
    }
    super.draw(options);
  }
}

/** The elevation texture of a DEM tile, with the neighbors it was prepared with. */
const preparedTextures = new WeakMap<DemTile, {key: string; image: ImageData}>();

/** Props of a `ColorReliefTileLayer`. */
export type ColorReliefTileLayerProps = DemTileLayerProps & {
  /** `color-relief-color`, as the style sets it. */
  colorReliefColor: unknown;
  /** `color-relief-opacity`, evaluated. */
  colorReliefOpacity: number;
  /** The unpack vector of the source, to which MapLibre rounds the ramp's elevations. */
  colorReliefUnpack: DemUnpackVector;
  /** Extra props of every tile's bitmap layer, such as `parameters`. */
  colorReliefSubLayerProps?: Record<string, unknown>;
};

/**
 * The tiles of a `raster-dem` source, colored by elevation by one `color-relief` style layer (see
 * `DemTileLayer`). The layer owns the texture of its ramp, which its tiles share.
 */
export class ColorReliefTileLayer extends DemTileLayer<ColorReliefTileLayerProps> {
  static layerName = 'ColorReliefTileLayer';
  static defaultProps = {
    ...DemTileLayer.defaultProps,
    colorReliefColor: {type: 'object', value: null, compare: false},
    colorReliefOpacity: {type: 'number', value: 1},
    colorReliefUnpack: {type: 'array', value: [6553.6, 25.6, 0.1, 10000], compare: false},
    colorReliefSubLayerProps: {type: 'object', value: null, compare: false}
  };

  protected readonly styleLayerType = 'color-relief';

  declare state: DemTileLayer<ColorReliefTileLayerProps>['state'] & {
    colorRamp?: ColorRampTexture & {key: string; device: Device};
  };

  updateState(params: UpdateParameters<this>): void {
    super.updateState(params);
    const {colorRamp} = this.state;
    if (colorRamp && colorRamp.key !== this.getColorRampKey()) {
      // The tiles take the new ramp.
      this.state.tileLayers?.clear();
    }
  }

  finalizeState(): void {
    super.finalizeState();
    this.state.colorRamp?.texture.destroy();
    this.state.colorRamp = undefined;
  }

  private getColorRampKey(): string {
    const {colorReliefColor, colorReliefUnpack} = this.props;
    return JSON.stringify([colorReliefColor, colorReliefUnpack]);
  }

  /** The texture of the ramp, created again when the ramp or its encoding changes. */
  private getColorRampTexture(): ColorRampTexture {
    const {device} = this.context;
    const {colorReliefColor, colorReliefUnpack} = this.props;
    const key = this.getColorRampKey();
    const current = this.state.colorRamp;
    if (current?.key === key && current.device === device) {
      return current;
    }
    current?.texture.destroy();
    // MapLibre allows as many stops as a texture is wide.
    const ramp = createColorRamp(colorReliefColor, device.limits.maxTextureDimension2D);
    const size = ramp.colorStops.length;
    const texture = device.createTexture({
      format: 'rgba32float',
      width: size,
      height: 2,
      mipLevels: 1,
      // Float textures cannot be filtered without an extension; the shader reads exact texels.
      sampler: {minFilter: 'nearest', magFilter: 'nearest'}
    });
    texture.writeData(getColorRampTexels(ramp, colorReliefUnpack));
    this.state.colorRamp = {texture, size, key, device};
    return this.state.colorRamp;
  }

  renderSubLayers(props: any): Layer | null | LayersList {
    const dem = props.data as DemTile | null;
    const tile = props.tile as DemTileHeader;
    if (!dem || typeof ImageData === 'undefined') {
      return null;
    }
    const {getNeighbor, key} = this.getDemNeighbors(tile);
    // Kept with the decoded tile, so the source's color-relief layers prepare it once.
    let prepared = preparedTextures.get(dem);
    if (prepared?.key !== key) {
      const size = dem.dim + 2;
      prepared = {key, image: new ImageData(prepareColorReliefTexture(dem, getNeighbor), size, size)};
      preparedTextures.set(dem, prepared);
    }

    const {west, south, east, north} = tile.bbox as {
      west: number;
      south: number;
      east: number;
      north: number;
    };
    const {colorReliefOpacity, colorReliefSubLayerProps} = this.props;
    const textureParameters = colorReliefSubLayerProps?.textureParameters as
      | {magFilter?: string}
      | undefined;
    return new ColorReliefBitmapLayer({
      ...props,
      ...colorReliefSubLayerProps,
      // A texture keeps the filter it was created with, so a filter change needs a new layer.
      id: textureParameters?.magFilter === 'nearest' ? `${props.id}-nearest` : props.id,
      parameters: {
        ...(colorReliefSubLayerProps?.parameters as object),
        ...PREMULTIPLIED_BLEND_PARAMETERS
      },
      data: null,
      // Positions in the tile are Web Mercator, also on a globe.
      _imageCoordinateSystem: 'cartesian',
      image: prepared.image,
      bounds: [west, south, east, north],
      colorRampTexture: this.getColorRampTexture(),
      colorReliefOpacity
    } as any);
  }
}
