// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl-community
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {LayerExtension} from '@deck.gl/core';
import type {Layer} from '@deck.gl/core';
import type {ShaderPlugin} from '@luma.gl/shaders';
import {createShaderInjectionPlugin} from './shader-injection-plugin';

/** A style's `light`, evaluated at one zoom. */
export type FillExtrusionLight = {
  /** Whether the light turns with the map (`map`) or stays fixed on the screen (`viewport`). */
  anchor: 'map' | 'viewport';
  /** Radial coordinate, azimuthal angle and polar angle, in degrees, as in the style spec. */
  position: [number, number, number];
  /** RGB in 0-1. */
  color: [number, number, number];
  /** 0-1. */
  intensity: number;
};

/** The style spec's default `light`. */
export const DEFAULT_FILL_EXTRUSION_LIGHT: FillExtrusionLight = Object.freeze({
  anchor: 'viewport',
  position: Object.freeze([1.15, 210, 30]),
  color: Object.freeze([1, 1, 1]),
  intensity: 0.5
}) as FillExtrusionLight;

type FillExtrusionLightingProps = {
  /** The light's direction in deck.gl's common space (x east, y north, z up), and intensity. */
  lightDirectionIntensity: [number, number, number, number];
  /** The light's color, and 1 when the walls darken toward the ground, else 0. */
  lightColorGradient: [number, number, number, number];
};

/**
 * Returns the light vector that deck.gl's normals, in common space (x east, y north, z up), are
 * shaded against, as MapLibre GL JS shades its own. MapLibre takes the light's spherical position
 * in tile coordinates (y south) and turns it by the map's bearing when the light is anchored to
 * the viewport. It keeps the light's radial length, which it does not normalize. Its wall normals
 * point into the buildings: `_generateSideFaces` takes the perpendicular `(-y, x)` of each edge
 * of a ring that is clockwise in tile coordinates. deck.gl's point out, so the horizontal part of
 * the light is reversed for them: x is negated, and y, negated from tile to common space, is
 * negated back.
 */
export function getFillExtrusionLightDirection(
  light: FillExtrusionLight,
  bearing: number
): [number, number, number] {
  const [radius, azimuthalDegrees, polarDegrees] = light.position;
  const azimuthal = ((azimuthalDegrees + 90) * Math.PI) / 180;
  const polar = (polarDegrees * Math.PI) / 180;
  let x = radius * Math.cos(azimuthal) * Math.sin(polar);
  let y = radius * Math.sin(azimuthal) * Math.sin(polar);
  const z = radius * Math.cos(polar);
  if (light.anchor === 'viewport') {
    const angle = (bearing * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    [x, y] = [cos * x - sin * y, sin * x + cos * y];
  }
  return [-x, y, z];
}

const UNIFORMS = /* glsl */ `\
layout(std140) uniform fillExtrusionLightingUniforms {
  vec4 lightDirectionIntensity;
  vec4 lightColorGradient;
} fillExtrusionLighting;
`;

/**
 * MapLibre GL JS's `fill-extrusion` shading (`fill_extrusion.vertex.glsl`): a directional light
 * whose strength rises with the color's darkness, a small ambient term, and walls that darken
 * toward the ground when `fill-extrusion-vertical-gradient` is on. `t` is 1 at the top of a wall
 * and 0 at its bottom; `base` and `height` are the extrusion's, in meters.
 */
const SHADE = /* glsl */ `\
vec3 fillExtrusionLighting_shade(vec3 color, vec3 normal, bool isWall, float t, float base, float height) {
  vec3 lightDirection = fillExtrusionLighting.lightDirectionIntensity.xyz;
  float intensity = fillExtrusionLighting.lightDirectionIntensity.w;
  vec3 lightColor = fillExtrusionLighting.lightColorGradient.rgb;
  float verticalGradient = fillExtrusionLighting.lightColorGradient.a;

  float colorValue = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  color += vec3(0.03);
  float directional = clamp(dot(normal, lightDirection), 0.0, 1.0);
  directional = mix(1.0 - intensity, max(1.0 - colorValue + intensity, 1.0), directional);
  if (isWall) {
    float gradient = clamp(
      (t + max(0.0, base)) * pow(max(0.0, height) / 150.0, 0.5),
      mix(0.7, 0.98, 1.0 - intensity),
      1.0
    );
    directional *= (1.0 - verticalGradient) + verticalGradient * gradient;
  }
  return clamp(color * directional * lightColor, mix(vec3(0.0), vec3(0.3), 1.0 - lightColor), vec3(1.0));
}
`;

const fillExtrusionLighting = createShaderInjectionPlugin({
  name: 'fillExtrusionLighting',
  inject: {
    'vs:#decl': `${UNIFORMS}${SHADE}
bool fillExtrusionLighting_isWall;
float fillExtrusionLighting_t;
float fillExtrusionLighting_base;
float fillExtrusionLighting_height;
`,
    // The attributes are declared in the layer's own shaders, which only `main` follows.
    'vs:#main-start': /* glsl */ `
#ifdef IS_SIDE_VERTEX
  fillExtrusionLighting_isWall = true;
  fillExtrusionLighting_t = positions.y;
#else
  fillExtrusionLighting_isWall = false;
  fillExtrusionLighting_t = 1.0;
#endif
  // Polygons are raised to fill-extrusion-base, and extruded from there by the rest of the height.
  fillExtrusionLighting_base = vertexPositions.z;
  fillExtrusionLighting_height = vertexPositions.z + elevations;
`,
    // The layer is drawn unlit (see `draw`), so color is the extrusion's own.
    'vs:DECKGL_FILTER_COLOR': /* glsl */ `
  // The light is placed relative to the ground under the building: east, north and up. On a
  // globe, deck.gl turns a roof's normal into globe space (project_normal), but leaves the walls
  // of longitude/latitude polygons in east and north (project_offset_normal). A roof faces up.
  vec3 fillExtrusionLighting_normal = geometry.normal;
  if (project.projectionMode == PROJECTION_MODE_GLOBE && !fillExtrusionLighting_isWall) {
    fillExtrusionLighting_normal = vec3(0.0, 0.0, 1.0);
  }
  color.rgb = fillExtrusionLighting_shade(
    color.rgb,
    fillExtrusionLighting_normal,
    fillExtrusionLighting_isWall,
    fillExtrusionLighting_t,
    fillExtrusionLighting_base,
    fillExtrusionLighting_height
  );
`
  },
  uniformTypes: {lightDirectionIntensity: 'vec4<f32>', lightColorGradient: 'vec4<f32>'}
});

/**
 * The WGSL of `fillExtrusionLighting`. deck.gl's WGSL extrusions have no vertex color hook, so the
 * color is shaded in the fragment stage, with MapLibre's per-vertex result: the vertex stage passes
 * the light's angle to the face and the wall gradient at the bottom and top of the wall, and the
 * fragment stage shades the color at both and interpolates between them by the height up the wall,
 * as the vertex colors of a wall are interpolated. A face has one color and one normal.
 */
const fillExtrusionLightingWGSL: ShaderPlugin = {
  name: 'fillExtrusionLighting',
  module: {
    name: 'fillExtrusionLighting',
    source: /* wgsl */ `\
struct FillExtrusionLightingUniforms {
  lightDirectionIntensity: vec4<f32>,
  lightColorGradient: vec4<f32>,
};

@group(0) @binding(auto) var<uniform> fillExtrusionLighting: FillExtrusionLightingUniforms;

var<private> fillExtrusionLighting_isWall: bool;
var<private> fillExtrusionLighting_base: f32;
var<private> fillExtrusionLighting_height: f32;

// The vertical gradient factor of the GLSL shade function, at a height t up the wall.
fn fillExtrusionLighting_gradient(t: f32) -> f32 {
  let intensity = fillExtrusionLighting.lightDirectionIntensity.w;
  let verticalGradient = fillExtrusionLighting.lightColorGradient.a;
  let gradient = clamp(
    (t + max(0.0, fillExtrusionLighting_base)) * pow(max(0.0, fillExtrusionLighting_height) / 150.0, 0.5),
    mix(0.7, 0.98, 1.0 - intensity),
    1.0
  );
  return (1.0 - verticalGradient) + verticalGradient * gradient;
}

// The GLSL shade function, for the light's angle to the face and a gradient factor.
fn fillExtrusionLighting_shade(color: vec3<f32>, directionalAngle: f32, gradient: f32) -> vec3<f32> {
  let intensity = fillExtrusionLighting.lightDirectionIntensity.w;
  let lightColor = fillExtrusionLighting.lightColorGradient.rgb;
  let colorValue = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  var directional = mix(1.0 - intensity, max(1.0 - colorValue + intensity, 1.0), directionalAngle);
  directional *= gradient;
  return clamp(
    (color + vec3<f32>(0.03)) * directional * lightColor,
    mix(vec3<f32>(0.0), vec3<f32>(0.3), 1.0 - lightColor),
    vec3<f32>(1.0)
  );
}
`,
    uniformTypes: {lightDirectionIntensity: 'vec4<f32>', lightColorGradient: 'vec4<f32>'}
  },
  interStageVariables: {
    // The light's angle to the face: clamp(dot(normal, light direction), 0, 1).
    fillExtrusionLighting_directional: {type: 'f32'},
    // The gradient factors at the bottom (x) and top (y) of the face, and the height up it (z).
    fillExtrusionLighting_gradients: {type: 'vec3<f32>'}
  },
  injections: [
    {
      stage: 'vertex',
      target: '#main-start',
      // The attributes are the entry point's, as in the GLSL injection.
      wgsl: /* wgsl */ `
#ifdef NON_INSTANCED_MODEL
  fillExtrusionLighting_isWall = false;
  fillExtrusionLighting_gradients = vec3<f32>(1.0, 1.0, 1.0);
#else
  fillExtrusionLighting_isWall = true;
  fillExtrusionLighting_gradients.z = attributes.positions.y;
#endif
  // Polygons are raised to fill-extrusion-base, and extruded from there by the rest of the height.
  fillExtrusionLighting_base = attributes.vertexPositions.z;
  fillExtrusionLighting_height = attributes.vertexPositions.z + attributes.elevations;
`
    },
    {
      stage: 'vertex',
      target: 'DECKGL_FILTER_GL_POSITION',
      wgsl: /* wgsl */ `
  // As in the GLSL injection: on a globe, a roof faces up.
  var fillExtrusionLighting_normal = geometry.normal;
  if (project.projectionMode == PROJECTION_MODE_GLOBE && !fillExtrusionLighting_isWall) {
    fillExtrusionLighting_normal = vec3<f32>(0.0, 0.0, 1.0);
  }
  fillExtrusionLighting_directional = clamp(
    dot(fillExtrusionLighting_normal, fillExtrusionLighting.lightDirectionIntensity.xyz),
    0.0,
    1.0
  );
  if (fillExtrusionLighting_isWall) {
    fillExtrusionLighting_gradients.x = fillExtrusionLighting_gradient(0.0);
    fillExtrusionLighting_gradients.y = fillExtrusionLighting_gradient(1.0);
  }
`
    },
    {
      stage: 'fragment',
      target: 'DECKGL_FILTER_COLOR',
      // The layer is drawn unlit (see `draw`), so color is the extrusion's own.
      wgsl: /* wgsl */ `
  *color = vec4<f32>(
    mix(
      fillExtrusionLighting_shade((*color).rgb, fillExtrusionLighting_directional, fillExtrusionLighting_gradients.x),
      fillExtrusionLighting_shade((*color).rgb, fillExtrusionLighting_directional, fillExtrusionLighting_gradients.y),
      fillExtrusionLighting_gradients.z
    ),
    (*color).a
  );
`
    }
  ]
};

/**
 * The material the extension draws with: deck.gl's lighting leaves the color as it is, for the
 * extension to shade.
 */
const UNLIT_MATERIAL = {unlit: true};

function isExtrudedPolygonLayer(layer: Layer): boolean {
  const state = layer.state as Record<string, unknown> | undefined;
  return Boolean(state && 'polygonTesselator' in state && (layer.props as any).extruded);
}

/**
 * Shades the extruded `SolidPolygonLayer`s of a layer as MapLibre GL JS shades `fill-extrusion`,
 * from the style's `light` (`fillExtrusionLight`) and `fill-extrusion-vertical-gradient`
 * (`fillExtrusionVerticalGradient`), instead of with deck.gl's lights, which it turns off for the
 * layer at every draw. A light anchored to the viewport turns with the viewport's bearing, which is
 * read at every draw. On a globe, the light is placed relative to
 * the ground under each building. Polygons must lie at `fill-extrusion-base` and be extruded by
 * the rest of the height. On WebGL and WebGPU.
 */
export class FillExtrusionLightingExtension extends LayerExtension {
  static extensionName = 'FillExtrusionLightingExtension';
  static defaultProps = {
    fillExtrusionLight: {type: 'object', value: DEFAULT_FILL_EXTRUSION_LIGHT},
    fillExtrusionVerticalGradient: true
  };

  isEnabled(layer: Layer): boolean {
    return isExtrudedPolygonLayer(layer);
  }

  getShaders(this: Layer, extension: this): any {
    if (!extension.isEnabled(this)) {
      return null;
    }
    return {
      plugins: [
        this.context.device.type === 'webgpu' ? fillExtrusionLightingWGSL : fillExtrusionLighting
      ]
    };
  }

  draw(this: Layer<any>, params: any, extension: this) {
    if (!extension.isEnabled(this)) {
      return;
    }
    const light: FillExtrusionLight = this.props.fillExtrusionLight || DEFAULT_FILL_EXTRUSION_LIGHT;
    const bearing = (this.context.viewport as {bearing?: number}).bearing || 0;
    const [x, y, z] = getFillExtrusionLightDirection(light, bearing);
    const fillExtrusionLightingProps: FillExtrusionLightingProps = {
      lightDirectionIntensity: [x, y, z, light.intensity],
      lightColorGradient: [...light.color, this.props.fillExtrusionVerticalGradient ? 1 : 0]
    };
    // After the lighting effect has set the layer's material (see `LayersPass`).
    this.setShaderModuleProps({
      fillExtrusionLighting: fillExtrusionLightingProps,
      phongMaterial: UNLIT_MATERIAL,
      gouraudMaterial: UNLIT_MATERIAL
    } as any);
  }
}
