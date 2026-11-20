// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {IconLayer} from '@deck.gl/layers';
import type {IconLayerProps} from '@deck.gl/layers';
import type {Accessor, DefaultProps} from '@deck.gl/core';

/** Props of {@link StretchIconLayer}. */
export type StretchIconLayerProps<DataT = unknown> = IconLayerProps<DataT> & {
  /**
   * How much wider (x) and taller (y) each icon is drawn than its mapping's aspect ratio at
   * `getSize`, before it is turned by `getAngle`. Default `[1, 1]`.
   */
  getIconStretch?: Accessor<DataT, [number, number]>;
};

/**
 * Where the icon shaders scale the unit quad by the icon's size. The stretch multiplies it there,
 * so that the stretched quad turns with the icon. Each source must contain its pattern.
 */
const GLSL_PATCHES: [RegExp, string][] = [
  [/(\nin vec2 instancePixelOffset;)/, '$1\nin vec2 instanceIconStretch;'],
  [
    /(vec2 pixelOffset = positions \/ 2\.0 \* iconSize)( \+ instanceOffsets;)/,
    '$1 * instanceIconStretch$2'
  ]
];
const WGSL_PATCHES: [RegExp, string][] = [
  [
    /(@location\(9\) instancePixelOffset: vec2<f32>,)/,
    '$1\n  @location(11) instanceIconStretch: vec2<f32>,'
  ],
  [
    /(var pixelOffset = \w+(?:\.\w+)? \/ 2\.0 \* iconSize)( \+ inp\.instanceOffsets;)/,
    '$1 * inp.instanceIconStretch$2'
  ]
];

/** Applies `patches` to a shader source, throwing if one does not match: deck.gl changed it. */
export function patchIconShader(source: string, patches: [RegExp, string][]): string {
  return patches.reduce((patched, [pattern, replacement]) => {
    if (!pattern.test(patched)) {
      throw new Error(`StretchIconLayer: the IconLayer shader no longer matches ${pattern}`);
    }
    return patched.replace(pattern, replacement);
  }, source);
}

/** The shader patches of {@link StretchIconLayer}, for tests. */
export const STRETCH_ICON_SHADER_PATCHES = {glsl: GLSL_PATCHES, wgsl: WGSL_PATCHES};

const defaultProps: DefaultProps<StretchIconLayerProps> = {
  getIconStretch: {type: 'accessor', value: [1, 1]}
};

/**
 * An `IconLayer` whose icons can be drawn at another aspect ratio than their image's
 * (`getIconStretch`), as the parts of a stretched `icon-text-fit` icon are. WebGL and WebGPU.
 */
export class StretchIconLayer<DataT = unknown, ExtraProps extends {} = {}> extends IconLayer<
  DataT,
  Required<Pick<StretchIconLayerProps<DataT>, 'getIconStretch'>> & ExtraProps
> {
  static layerName = 'StretchIconLayer';
  static defaultProps = defaultProps;

  getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      vs: patchIconShader(shaders.vs, GLSL_PATCHES),
      ...(shaders.source ? {source: patchIconShader(shaders.source, WGSL_PATCHES)} : {})
    };
  }

  initializeState() {
    super.initializeState();
    this.getAttributeManager()!.addInstanced({
      instanceIconStretch: {
        size: 2,
        accessor: 'getIconStretch',
        defaultValue: [1, 1]
      }
    });
  }
}
