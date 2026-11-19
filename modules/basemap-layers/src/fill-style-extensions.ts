// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension, project} from '@deck.gl/core';
import type {Layer} from '@deck.gl/core';
import {FillStyleExtension} from '@deck.gl/extensions';
import type {ShaderPlugin} from '@luma.gl/shaders';
import {createShaderInjectionPlugin} from './shader-injection-plugin';

/** Whether a layer's device runs the GLSL injections of these extensions. */
function isGLSLDevice(layer: Layer): boolean {
  return layer.context.device.type !== 'webgpu';
}

/**
 * `fill-translate` in common space. The offset is in pixels on the ground plane, as MapLibre GL
 * JS applies it in tile units: x east and y south on a map, along the local east and south on a
 * globe. Only the clip-space position moves: a pattern is placed by the vertex's own position, so
 * it moves with the fill, as in MapLibre GL JS.
 */
const fillTranslateModule = createShaderInjectionPlugin({
  name: 'fillTranslate',
  dependencies: [project],
  vs: /* glsl */ `\
layout(std140) uniform fillTranslateUniforms {
  vec2 offset;
} fillTranslate;
`,
  uniformTypes: {offset: 'vec2<f32>'},
  inject: {
    'vs:DECKGL_FILTER_GL_POSITION': {
      order: -1,
      injection: /* glsl */ `
  if (fillTranslate.offset != vec2(0.0)) {
    vec2 fillTranslate_pixels = vec2(fillTranslate.offset.x, -fillTranslate.offset.y);
    vec4 fillTranslate_position = geometry.position;
    if (project.projectionMode == PROJECTION_MODE_GLOBE) {
      // The globe is centred at the origin with its axis along z.
      vec3 fillTranslate_up = normalize(geometry.position.xyz);
      vec3 fillTranslate_east = vec3(-fillTranslate_up.y, fillTranslate_up.x, 0.0);
      fillTranslate_east = length(fillTranslate_east) > 0.0
        ? normalize(fillTranslate_east)
        : vec3(1.0, 0.0, 0.0);
      vec3 fillTranslate_north = cross(fillTranslate_up, fillTranslate_east);
      fillTranslate_position.xyz +=
        (fillTranslate_east * fillTranslate_pixels.x + fillTranslate_north * fillTranslate_pixels.y) /
        project.scale;
    } else {
      fillTranslate_position.xy += fillTranslate_pixels / project.scale;
    }
    position = project_common_position_to_clipspace(fillTranslate_position);
  }
`
    }
  }
});

/** The WGSL of `fillTranslateModule`. */
const fillTranslatePluginWGSL: ShaderPlugin = {
  name: 'fillTranslate',
  module: {
    name: 'fillTranslate',
    dependencies: [project],
    source: /* wgsl */ `\
struct FillTranslateUniforms {
  offset: vec2<f32>,
};

@group(0) @binding(auto) var<uniform> fillTranslate: FillTranslateUniforms;

// The common position moved by the offset, as the GLSL injection moves it.
fn fillTranslate_getPosition(position: vec4<f32>) -> vec4<f32> {
  let pixels = vec2<f32>(fillTranslate.offset.x, -fillTranslate.offset.y);
  if (project.projectionMode == PROJECTION_MODE_GLOBE) {
    // The globe is centred at the origin with its axis along z.
    let up = normalize(position.xyz);
    var east = vec3<f32>(-up.y, up.x, 0.0);
    east = select(vec3<f32>(1.0, 0.0, 0.0), normalize(east), length(east) > 0.0);
    let north = cross(up, east);
    return vec4<f32>(position.xyz + (east * pixels.x + north * pixels.y) / project.scale, position.w);
  }
  return vec4<f32>(position.xy + pixels / project.scale, position.zw);
}
`,
    uniformTypes: {offset: 'vec2<f32>'}
  },
  injections: [
    {
      stage: 'vertex',
      target: 'DECKGL_FILTER_GL_POSITION',
      order: -1,
      wgsl: /* wgsl */ `
  if (any(fillTranslate.offset != vec2<f32>(0.0))) {
    *position = project_common_position_to_clipspace(fillTranslate_getPosition(geometry.position));
  }
`
    }
  ]
};

/** The anchor of `fill-translate`. */
export type FillTranslateAnchor = 'map' | 'viewport';

/** The props of `FillTranslateExtension`. */
export type FillTranslateExtensionProps = {
  /** `fill-translate`: the offset in pixels, x right and y down. */
  fillTranslate?: [number, number];
  /** `fill-translate-anchor`: `'map'` turns the offset with the map, `'viewport'` keeps it on screen. */
  fillTranslateAnchor?: FillTranslateAnchor;
};

/**
 * Returns the ground offset of `fill-translate` in pixels, x east and y south, at a map bearing in
 * degrees. A `'viewport'` offset is turned by the bearing, so it keeps its direction on screen,
 * as in MapLibre GL JS.
 */
export function getFillTranslateOffset(
  translate: readonly [number, number],
  anchor: FillTranslateAnchor,
  bearing: number
): [number, number] {
  const [x, y] = translate;
  if (anchor !== 'viewport' || !bearing) {
    return [x, y];
  }
  const angle = (bearing * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [x * cos - y * sin, x * sin + y * cos];
}

/**
 * Offsets a fill and its outline by `fill-translate` pixels, anchored to the map or to the
 * viewport by `fill-translate-anchor`, on WebGL and WebGPU.
 *
 * Added to a `GeoJsonLayer`, it reaches the polygon fill and outline sublayers.
 */
export class FillTranslateExtension extends LayerExtension {
  static extensionName = 'FillTranslateExtension';
  static defaultProps = {
    fillTranslate: {type: 'array', value: [0, 0], compare: true},
    fillTranslateAnchor: 'map'
  };

  getShaders(this: Layer) {
    return {plugins: [isGLSLDevice(this) ? fillTranslateModule : fillTranslatePluginWGSL]};
  }

  draw(this: Layer<FillTranslateExtensionProps>) {
    const {fillTranslate = [0, 0], fillTranslateAnchor = 'map'} = this.props;
    const bearing = (this.context.viewport as {bearing?: number}).bearing || 0;
    this.setShaderModuleProps({
      fillTranslate: {
        offset: getFillTranslateOffset(fillTranslate, fillTranslateAnchor, bearing)
      }
    });
  }
}

/**
 * On a globe, places the pattern by the vertex's Web Mercator position instead of `FillStyleExtension`'s
 * common position, whose x and y lie in the globe's equatorial plane: the pattern then keeps its
 * size and shape across the globe, and stays continuous across tiles, as on a map. Runs after
 * `FillStyleExtension`'s injection (`order: 1`), with the pattern size in common units.
 */
const globePatternModule = createShaderInjectionPlugin({
  name: 'globeFillPattern',
  dependencies: [project],
  inject: {
    'vs:DECKGL_FILTER_GL_POSITION': {
      order: 1,
      injection: /* glsl */ `
  if (project.projectionMode == PROJECTION_MODE_GLOBE && fill.patternEnabled && !fill.procedural) {
    vec2 globePattern_frame = fill.patternUnitScale * fillPatternScales * fillPatternFrames.zw;
    // Pattern atlases use top-left coordinates; Web Mercator y grows northward.
    fill_uv = project_mercator_(geometry.worldPosition.xy) / globePattern_frame * vec2(1.0, -1.0);
    fill_uv += fillPatternOffsets;
  }
`
    }
  }
});

/**
 * deck.gl 10.0.0-alpha.1's WGSL pattern places the pattern with
 * `project_common_position_to_flat_continuous(geometry.position, ...)`, which takes a `vec3<f32>`,
 * so its vertex shader does not compile. This copy of its plugin passes `geometry.position.xyz`.
 * Where the call is already correct, the plugin is returned unchanged.
 */
const BROKEN_FLAT_POSITION = 'project_common_position_to_flat_continuous(geometry.position,';
const FIXED_FLAT_POSITION = 'project_common_position_to_flat_continuous(geometry.position.xyz,';
const fixedPatternPlugins = new WeakMap<ShaderPlugin, ShaderPlugin>();

function fixPatternPluginWGSL(plugin: ShaderPlugin): ShaderPlugin {
  const {injections} = plugin;
  if (!injections || Array.isArray(injections)) {
    return plugin;
  }
  const key = 'wgsl:vs:DECKGL_FILTER_GL_POSITION';
  if (!injections[key]?.includes(BROKEN_FLAT_POSITION)) {
    return plugin;
  }
  let fixed = fixedPatternPlugins.get(plugin);
  if (!fixed) {
    fixed = {
      ...plugin,
      injections: {
        ...injections,
        [key]: injections[key].replaceAll(BROKEN_FLAT_POSITION, FIXED_FLAT_POSITION)
      }
    };
    fixedPatternPlugins.set(plugin, fixed);
  }
  return fixed;
}

/**
 * `FillStyleExtension` with image patterns, on WebGL and WebGPU. On a globe, the pattern is placed
 * by the vertex's Web Mercator position: by `globePatternModule` on WebGL, and by deck.gl's own
 * WGSL on WebGPU.
 */
export class FillPatternExtension extends FillStyleExtension {
  static extensionName = 'FillPatternExtension';

  constructor() {
    super({pattern: true});
  }

  getShaders(this: Layer, extension: this): any {
    const shaders = super.getShaders.call(this, extension);
    return (
      shaders && {
        ...shaders,
        plugins: isGLSLDevice(this)
          ? [...(shaders.plugins ?? []), globePatternModule]
          : (shaders.plugins ?? []).map(fixPatternPluginWGSL)
      }
    );
  }
}
