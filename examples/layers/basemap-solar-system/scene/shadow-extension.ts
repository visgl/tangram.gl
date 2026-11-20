// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Eclipse shadows in the fragment shader: the GLSL form of celestial/shadows.ts. Each fragment
// traces one ray toward the Sun, analytically, against up to four occluder spheres and the ring
// annulus, and takes the visible fraction of the solar disc (the "circular occluder" idea of
// CORTAO, github.com/carbonengine/CORTAO, MIT, in its exact disc-overlap form).
//
// The CPU sends the geometry in the receiver's body-fixed frame and in units of its equatorial
// radius, from true positions in double precision. The fragment's point comes from the drawn
// mesh by direction: a point of the drawn sphere at geodetic direction n stands for the true
// surface point at n. So the shadows are at true scale and in the true place on the map even
// when the readable scale enlarges and moves the bodies.
//
// Surfaces (`kind`): 0 = sphere mesh, local position = geodetic direction; 1 = ring mesh, local
// position = point in the ring plane; 2 = longitude/latitude geometry (BitmapLayer on GlobeView).
// `replace` (params.w) = 1 makes the layer output the light itself: with a multiply blend, an
// overlay on the GlobeView then darkens the basemap tiles under it.

import {LayerExtension} from '@deck.gl/core';
import {RING_SHADOW_FLOOR, SRGB_GAMMA, type ShadowGeometry} from '../celestial/shadows';

const MAX_OCCLUDERS = 4;

const glsl = /* glsl */ `\
layout(std140) uniform shadowUniforms {
  vec4 sun;
  vec4 occ0;
  vec4 occ1;
  vec4 occ2;
  vec4 occ3;
  vec4 tint0;
  vec4 tint1;
  vec4 tint2;
  vec4 tint3;
  vec4 ring;
  vec4 ringEdges;
  vec4 ringTau;
  vec4 params;
} shadow;

// Visible fraction of a light disc of radius 1 behind a disc of radius ro at distance d.
float shadow_discVisible(float ro, float d) {
  if (d >= 1.0 + ro) return 1.0;
  if (d <= abs(1.0 - ro)) return ro >= 1.0 ? 0.0 : 1.0 - ro * ro;
  float a1 = acos(clamp((d * d + 1.0 - ro * ro) / (2.0 * d), -1.0, 1.0));
  float a2 = acos(clamp((d * d + ro * ro - 1.0) / (2.0 * d * ro), -1.0, 1.0));
  float k = sqrt(max(0.0, (-d + 1.0 + ro) * (d + 1.0 - ro) * (d - 1.0 + ro) * (d + 1.0 + ro)));
  return clamp(1.0 - (a1 + ro * ro * a2 - 0.5 * k) / 3.14159265, 0.0, 1.0);
}

float shadow_sphere(vec3 p, vec4 occ, float zScale) {
  vec3 a = shadow.sun.xyz - p;
  vec3 b = occ.xyz - p;
  float rs = asin(min(1.0, shadow.sun.w / length(a)));
  a.z *= zScale;
  b.z *= zScale;
  float da = length(a);
  float db = length(b);
  if (db >= da) return 1.0;
  if (db <= occ.w) return 0.0;
  float ro = asin(occ.w / db);
  a /= da;
  b /= db;
  float d = atan(length(cross(a, b)), dot(a, b));
  return shadow_discVisible(ro / rs, d / rs);
}

float shadow_ringTau(float r) {
  if (r < shadow.ring.x || r > shadow.ring.y) return 0.0;
  if (r < shadow.ringEdges.x) return shadow.ringTau.x;
  if (r < shadow.ringEdges.y) return shadow.ringTau.y;
  if (r < shadow.ringEdges.z) return shadow.ringTau.z;
  return shadow.ringTau.w;
}

float shadow_ringTransmission(vec3 p) {
  vec3 s = normalize(shadow.sun.xyz - p);
  if (abs(s.z) < 1e-6) return 1.0;
  float t = -p.z / s.z;
  if (t <= 0.0) return 1.0;
  return exp(-shadow_ringTau(length(p.xy + t * s.xy)) / abs(s.z));
}

// The map colours are sRGB: light in linear units scales them by about light^(1 / 2.2).
float shadow_encode(float linear) {
  return pow(linear, ${(1 / SRGB_GAMMA).toFixed(4)});
}

vec3 shadow_occlude(vec3 light, vec3 p, int i, vec4 occ, vec4 tint) {
  if (i >= int(shadow.params.x + 0.5)) return light;
  return light * mix(tint.rgb, vec3(1.0), shadow_encode(shadow_sphere(p, occ, tint.w)));
}

// Light at a local point of the drawn geometry: rgb factors, 1 = full sunlight.
vec3 shadow_light(vec3 local) {
  float kind = shadow.params.z;
  vec3 p;
  if (kind > 1.5) {
    vec2 lnglat = radians(local.xy);
    local = vec3(cos(lnglat.y) * cos(lnglat.x), cos(lnglat.y) * sin(lnglat.x), sin(lnglat.y));
  }
  if (kind > 0.5 && kind < 1.5) {
    p = local;
  } else {
    vec3 n = normalize(local);
    float e2 = shadow.params.y;
    p = inversesqrt(1.0 - e2 * n.z * n.z) * vec3(n.x, n.y, (1.0 - e2) * n.z);
    // The night side gets no eclipse: the occluder is in front of the Sun there too.
    if (dot(n, shadow.sun.xyz - p) <= 0.0) return vec3(1.0);
  }
  vec3 light = vec3(1.0);
  light = shadow_occlude(light, p, 0, shadow.occ0, shadow.tint0);
  light = shadow_occlude(light, p, 1, shadow.occ1, shadow.tint1);
  light = shadow_occlude(light, p, 2, shadow.occ2, shadow.tint2);
  light = shadow_occlude(light, p, 3, shadow.occ3, shadow.tint3);
  if (shadow.ring.z > 0.5) {
    light *= mix(vec3(${RING_SHADOW_FLOOR.toFixed(3)}), vec3(1.0), shadow_encode(shadow_ringTransmission(p)));
  }
  return light;
}
`;

const vec4 = 'vec4<f32>' as const;
const shadowModule = {
  name: 'shadow',
  vs: glsl,
  fs: glsl,
  uniformTypes: {
    sun: vec4, occ0: vec4, occ1: vec4, occ2: vec4, occ3: vec4,
    tint0: vec4, tint1: vec4, tint2: vec4, tint3: vec4,
    ring: vec4, ringEdges: vec4, ringTau: vec4, params: vec4
  }
};

const inject = {
  'vs:#decl': 'out vec3 shadow_vLocal;\n',
  'vs:#main-end': 'shadow_vLocal = positions;\n',
  'fs:#decl': 'in vec3 shadow_vLocal;\n',
  'fs:DECKGL_FILTER_COLOR': `
  if (!bool(picking.isActive) && (shadow.params.x > 0.5 || shadow.ring.z > 0.5)) {
    vec3 shadowLight = shadow_light(shadow_vLocal);
    color.rgb = mix(color.rgb * shadowLight, shadowLight, shadow.params.w);
    color.a = mix(color.a, 1.0, shadow.params.w);
  }
`
};

type Vec4 = [number, number, number, number];
export type ShadowUniforms = Record<string, Vec4>;
const ZERO: Vec4 = [0, 0, 0, 0];
const OFF: ShadowUniforms = {
  sun: [0, 0, 1, 1], occ0: ZERO, occ1: ZERO, occ2: ZERO, occ3: ZERO,
  tint0: ZERO, tint1: ZERO, tint2: ZERO, tint3: ZERO, ring: ZERO, ringEdges: ZERO, ringTau: ZERO, params: ZERO
};

/** Shader uniforms of a shadow geometry; null or no casters gives the "off" uniforms. */
export function shadowUniforms(
  geometry: ShadowGeometry | null | undefined,
  kind: 'sphere' | 'rings' | 'lnglat',
  replace = false
): ShadowUniforms {
  if (!geometry || (!geometry.occluders.length && !geometry.ring)) return OFF;
  const u: ShadowUniforms = {...OFF};
  u.sun = [...geometry.sun, geometry.sunRadius];
  const occluders = geometry.occluders.slice(0, MAX_OCCLUDERS);
  occluders.forEach((o, i) => {
    u[`occ${i}`] = [...o.center, o.radius];
    u[`tint${i}`] = [...o.tint, o.zScale];
  });
  const ring = geometry.ring;
  if (ring) {
    u.ring = [ring.inner, ring.outer, 1, 0];
    u.ringEdges = [...ring.edges, 0];
    u.ringTau = ring.tau;
  }
  u.params = [occluders.length, geometry.e2, kind === 'sphere' ? 0 : kind === 'rings' ? 1 : 2, replace ? 1 : 0];
  return u;
}

/** Adds the eclipse shadows to a SimpleMeshLayer or a BitmapLayer (`shadowUniforms` prop). */
export class ShadowExtension extends LayerExtension {
  static extensionName = 'ShadowExtension';
  static defaultProps = {shadowUniforms: {type: 'object', value: null, compare: true}};

  getShaders() {
    return {modules: [shadowModule], inject};
  }

  draw(this: never) {
    const layer = this as unknown as {props: {shadowUniforms?: ShadowUniforms | null}; setShaderModuleProps: (p: object) => void};
    layer.setShaderModuleProps({shadow: layer.props.shadowUniforms ?? OFF});
  }
}

/** Multiply blend: the overlay's colour scales the colour under it; alpha stays. */
export const MULTIPLY_PARAMETERS = {
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'dst',
  blendColorDstFactor: 'zero',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'zero',
  blendAlphaDstFactor: 'one'
} as const;
