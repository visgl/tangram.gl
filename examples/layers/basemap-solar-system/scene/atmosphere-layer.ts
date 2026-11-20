// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The atmosphere and the clouds of one body, ray-marched in one fragment shader on a sphere a
// little larger than the top of the atmosphere. Single scattering (Rayleigh + Mie) with the Sun's
// optical depth from Schüler's Chapman approximation; the Earth's clouds are a thin shell whose
// density comes from a cloud map, lit by math.gl `getCloudLighting` (a table by Sun altitude) with
// self-shadowing toward the Sun. Venus gets an opaque cloud deck at the base of its atmosphere.
// The functions are repeated, and tested, in celestial/atmosphere.ts. WebGL2 only: on WebGPU the
// layer draws nothing.

import {Layer, project32, type DefaultProps, type LayerProps} from '@deck.gl/core';
import type {Device, Texture} from '@luma.gl/core';
import {Geometry, Model} from '@luma.gl/engine';
import {
  CLOUD_LUT_DIFFUSE_SCALE,
  CLOUD_LUT_MAX_ALTITUDE,
  CLOUD_LUT_MIN_ALTITUDE,
  CLOUD_LUT_SIZE,
  CLOUD_MAP_FLOOR,
  getCloudLightTable,
  type Atmosphere,
  type V3
} from '../celestial';

const uniformBlock = /* glsl */ `\
layout(std140) uniform atmoUniforms {
  vec3 center;
  vec3 axisX;
  vec3 axisY;
  vec3 axisZ;
  vec3 sunDirection;
  vec3 rayleigh;
  vec3 mieScattering;
  vec3 mieExtinction;
  vec3 deckAlbedo;
  float radius;
  float meshScale;
  float inside;
  float baseRadius;
  float topRadius;
  float rayleighHeight;
  float mieHeight;
  float mieAsymmetry;
  float deckOpacity;
  float atmosphereOn;
  float cloudBase;
  float cloudTop;
  float cloudSteps;
  float lightSteps;
  float atmosphereSteps;
  float exposure;
  float opacity;
  float mapTexelsPerRadian;
} atmo;
`;

type AtmoUniforms = {
  center: V3;
  axisX: V3;
  axisY: V3;
  axisZ: V3;
  sunDirection: V3;
  rayleigh: V3;
  mieScattering: V3;
  mieExtinction: V3;
  deckAlbedo: V3;
  radius: number;
  meshScale: number;
  inside: number;
  baseRadius: number;
  topRadius: number;
  rayleighHeight: number;
  mieHeight: number;
  mieAsymmetry: number;
  deckOpacity: number;
  atmosphereOn: number;
  cloudBase: number;
  cloudTop: number;
  cloudSteps: number;
  lightSteps: number;
  atmosphereSteps: number;
  exposure: number;
  opacity: number;
  mapTexelsPerRadian: number;
  cloudMap: Texture;
  cloudLut: Texture;
};

const atmoModule = {
  name: 'atmo',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    center: 'vec3<f32>',
    axisX: 'vec3<f32>',
    axisY: 'vec3<f32>',
    axisZ: 'vec3<f32>',
    sunDirection: 'vec3<f32>',
    rayleigh: 'vec3<f32>',
    mieScattering: 'vec3<f32>',
    mieExtinction: 'vec3<f32>',
    deckAlbedo: 'vec3<f32>',
    radius: 'f32',
    meshScale: 'f32',
    inside: 'f32',
    baseRadius: 'f32',
    topRadius: 'f32',
    rayleighHeight: 'f32',
    mieHeight: 'f32',
    mieAsymmetry: 'f32',
    deckOpacity: 'f32',
    atmosphereOn: 'f32',
    cloudBase: 'f32',
    cloudTop: 'f32',
    cloudSteps: 'f32',
    lightSteps: 'f32',
    atmosphereSteps: 'f32',
    exposure: 'f32',
    opacity: 'f32',
    mapTexelsPerRadian: 'f32'
  }
} as const;

const vs = /* glsl */ `\
#version 300 es
#define SHADER_NAME atmosphere-layer-vs
in vec3 positions;
out vec3 vCommon;
flat out vec3 vCamera;
flat out vec3 vCenter;
flat out float vRadius;
void main(void) {
  vec3 world = atmo.center + positions * (atmo.radius * atmo.meshScale);
  vec4 commonPosition;
  gl_Position = project_position_to_clipspace(world, vec3(0.0), vec3(0.0), commonPosition);
  vCommon = commonPosition.xyz;
  vCamera = project.cameraPosition;
  vCenter = project_position(atmo.center);
  vRadius = length(project_position(atmo.center + vec3(atmo.radius, 0.0, 0.0)) - vCenter);
}
`;

const fs = /* glsl */ `\
#version 300 es
#define SHADER_NAME atmosphere-layer-fs
precision highp float;
uniform sampler2D cloudMap;
uniform sampler2D cloudLut;
in vec3 vCommon;
flat in vec3 vCamera;
flat in vec3 vCenter;
flat in float vRadius;
out vec4 fragColor;

const float PI = 3.14159265;
const float LUT_MIN = ${CLOUD_LUT_MIN_ALTITUDE.toFixed(8)};
const float LUT_SPAN = ${(CLOUD_LUT_MAX_ALTITUDE - CLOUD_LUT_MIN_ALTITUDE).toFixed(8)};
const float LUT_DIFFUSE = ${(1 / CLOUD_LUT_DIFFUSE_SCALE).toFixed(8)};
// Multiple scattering reaches deeper than the direct beam: the optical depth toward the Sun is
// scaled by this factor for it (one octave of Wrenninge 2015).
const float CLOUD_MULTIPLE_DEPTH = 0.25;
const float CLOUD_ASYMMETRY = 0.7;
const float MAX_CLOUD_DEPTH = 60.0;
const float TWO_STREAM_BACKSCATTER = 0.15;
const float MAP_FLOOR = ${CLOUD_MAP_FLOOR.toFixed(4)};

vec2 raySphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float henyeyGreenstein(float c, float g) {
  float d = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (4.0 * PI * d * sqrt(d));
}

float rayleighPhase(float c) {
  return 3.0 / (16.0 * PI) * (1.0 + c * c);
}

// Column of exp(-h) along a ray, in scale heights: the Chapman function as
// sqrt(pi r / 2) erfcx(sqrt(r / 2) cos z), erfcx after Ren & MacKenzie (2007).
float erfcx(float y) {
  const float A = 2.911;
  return A / ((A - 1.0) * sqrt(PI) * y + sqrt(PI * y * y + A * A));
}
float chapman(float r, float cosine) {
  return sqrt(0.5 * PI * r) * erfcx(sqrt(0.5 * r) * cosine);
}
float chapmanColumn(float x, float h, float cosZenith) {
  float r = x + h;
  if (cosZenith >= 0.0) return chapman(r, cosZenith) * exp(-h);
  float x0 = sqrt(1.0 - cosZenith * cosZenith) * r;
  return 2.0 * sqrt(0.5 * PI * x0) * exp(x - x0) - chapman(r, -cosZenith) * exp(-h);
}

vec3 toFixed(vec3 p) {
  return vec3(dot(p, atmo.axisX), dot(p, atmo.axisY), dot(p, atmo.axisZ));
}

vec2 mapUV(vec3 p) {
  vec3 f = toFixed(p);
  float lon = atan(f.y, f.x);
  float lat = asin(clamp(f.z / length(f), -1.0, 1.0));
  return vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
}

// Cloud extinction per body radius at p; \`tau\` gets the vertical optical depth of the column.
float cloudDensity(vec3 p, float lod, out float tau) {
  tau = 0.0;
  float r = length(p);
  float hn = (r - atmo.cloudBase) / (atmo.cloudTop - atmo.cloudBase);
  if (hn <= 0.0 || hn >= 1.0) return 0.0;
  // The map's brightness read as albedo, above the clear-sky floor of the map.
  float a = clamp((textureLod(cloudMap, mapUV(p), lod).r - MAP_FLOOR) / (1.0 - MAP_FLOOR), 0.0, 0.999);
  if (a < 0.01) return 0.0;
  // Thicker clouds reach higher: the top is between 35 % and 100 % of the shell.
  float top = mix(0.35, 1.0, a);
  float profile = smoothstep(0.0, 0.15, hn) * (1.0 - smoothstep(0.5 * top, top, hn));
  // Two-stream conservative scattering: A = (1 - g) tau / (2 + (1 - g) tau), g = 0.85.
  tau = min(MAX_CLOUD_DEPTH, 2.0 * a / (TWO_STREAM_BACKSCATTER * (1.0 - a)));
  // The profile integrates to 0.75 top - 0.075 of the shell: the column keeps its optical depth.
  return profile * tau / ((0.75 * top - 0.075) * (atmo.cloudTop - atmo.cloudBase));
}
float cloudDensity(vec3 p, float lod) {
  float tau;
  return cloudDensity(p, lod, tau);
}

vec3 sunTransmittance(vec3 p, vec3 sun) {
  float r = length(p);
  float h = max(r - atmo.baseRadius, 0.0);
  float cz = dot(p / r, sun);
  float colR = atmo.rayleighHeight * chapmanColumn(atmo.baseRadius / atmo.rayleighHeight, h / atmo.rayleighHeight, cz);
  float colM = atmo.mieHeight * chapmanColumn(atmo.baseRadius / atmo.mieHeight, h / atmo.mieHeight, cz);
  return exp(-(atmo.rayleigh * colR + atmo.mieExtinction * colM));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}


float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Venus cloud-top streaks: bands along latitude, bent into the dark "Y" toward the equator.
float deckPattern(vec3 p) {
  vec3 f = toFixed(p);
  float lat = asin(clamp(f.z / length(f), -1.0, 1.0));
  float lon = atan(f.y, f.x);
  float bend = lon + 1.6 * abs(lat);
  float n = valueNoise(vec2(bend * 3.0, lat * 14.0)) * 0.6 + valueNoise(vec2(bend * 7.0, lat * 30.0)) * 0.4;
  float y = 1.0 - 0.18 * exp(-pow(lat * 4.0, 2.0)) * (0.5 + 0.5 * sin(bend * 2.0));
  return (0.84 + 0.16 * n) * y;
}

void main(void) {
  vec3 rd = normalize(vCommon - vCamera);
  float pixelAngle = length(fwidth(rd));
  vec3 camera = (vCamera - vCenter) / vRadius;
  // From outside, the ray starts at the mesh (near the body, so float32 keeps its precision).
  vec3 ro = atmo.inside > 0.5 ? camera : (vCommon - vCenter) / vRadius;
  float cameraOffset = atmo.inside > 0.5 ? 0.0 : length(vCommon - vCamera) / vRadius;
  vec3 sun = atmo.sunDirection;

  vec2 top = raySphere(ro, rd, atmo.topRadius);
  if (top.y <= 0.0 || top.x > top.y) discard;
  float tStart = max(top.x, 0.0);
  vec2 base = raySphere(ro, rd, atmo.baseRadius);
  if (base.x < 0.0 && base.y > 0.0) discard;
  bool hitBase = base.x <= base.y && base.x > 0.0;
  float tEnd = hitBase ? base.x : top.y;
  float jitter = hash(gl_FragCoord.xy);

  // Clouds.
  vec3 cloudLight = vec3(0.0);
  float cloudT = 1.0;
  float tCloud = -1.0;
  if (atmo.cloudTop > 0.0 && atmo.cloudSteps > 0.0) {
    vec2 shell = raySphere(ro, rd, atmo.cloudTop);
    float c0 = max(shell.x, 0.0);
    float c1 = min(shell.y, tEnd);
    if (c1 > c0) {
      float dt = (c1 - c0) / atmo.cloudSteps;
      float distance = cameraOffset + 0.5 * (c0 + c1);
      // Half a level of blur hides the 8 x 8 JPEG blocks of the map when it is magnified.
      float lod = max(0.5, log2(max(1.0, distance * pixelAngle * atmo.mapTexelsPerRadian)));
      float cosView = dot(rd, sun);
      float phase = henyeyGreenstein(cosView, CLOUD_ASYMMETRY);
      float t = c0 + dt * jitter;
      for (int i = 0; i < 32; i++) {
        if (float(i) >= atmo.cloudSteps) break;
        vec3 p = ro + rd * t;
        float columnTau;
        float sigma = cloudDensity(p, lod, columnTau);
        if (sigma > 0.0) {
          float sinAlt = dot(normalize(p), sun);
          float s = sqrt(clamp((asin(clamp(sinAlt, -1.0, 1.0)) - LUT_MIN) / LUT_SPAN, 0.0, 1.0));
          vec3 direct = texture(cloudLut, vec2(s, 0.25)).rgb;
          vec3 sky = texture(cloudLut, vec2(s, 0.75)).rgb * LUT_DIFFUSE;
          float lightDepth = 0.0;
          if (max(direct.r, max(direct.g, direct.b)) > 0.002) {
            float lightLength = min(raySphere(p, sun, atmo.cloudTop).y, 0.006) / atmo.lightSteps;
            for (int j = 0; j < 6; j++) {
              if (float(j) >= atmo.lightSteps) break;
              lightDepth += cloudDensity(p + sun * lightLength * (float(j) + 0.5), lod + 1.0) * lightLength;
            }
          }
          // Diffuse reflection scaled so that a slab of the column's depth reflects its two-stream
          // albedo A / pi per unit irradiance; single scattering adds the forward (silver) lobe.
          float albedo = TWO_STREAM_BACKSCATTER * columnTau / (2.0 + TWO_STREAM_BACKSCATTER * columnTau);
          float diffuse = albedo / (PI * max(1.0 - exp(-columnTau), 1e-3));
          float mu = max(sinAlt, 0.03);
          vec3 source = direct * (phase * exp(-lightDepth) + diffuse * mu * exp(-CLOUD_MULTIPLE_DEPTH * lightDepth)) + sky * diffuse;
          float stepT = exp(-sigma * dt);
          cloudLight += cloudT * source * (1.0 - stepT);
          cloudT *= stepT;
          if (tCloud < 0.0 && cloudT < 0.5) tCloud = t;
          if (cloudT < 0.01) break;
        }
        t += dt;
      }
    }
  }

  // Atmosphere, in front of the clouds or the base.
  vec3 light = vec3(0.0);
  vec3 transmittance = vec3(1.0);
  float aEnd = tCloud > 0.0 ? tCloud : tEnd;
  if (atmo.atmosphereOn > 0.5 && aEnd > tStart) {
    float dt = (aEnd - tStart) / atmo.atmosphereSteps;
    float cosView = dot(rd, sun);
    float phaseR = rayleighPhase(cosView);
    float phaseM = henyeyGreenstein(cosView, atmo.mieAsymmetry);
    float columnR = 0.0;
    float columnM = 0.0;
    // Midpoints, not jittered: the air is smooth, and jitter shows as grain on the disk.
    float t = tStart + dt * 0.5;
    for (int i = 0; i < 16; i++) {
      if (float(i) >= atmo.atmosphereSteps) break;
      vec3 p = ro + rd * t;
      float h = max(length(p) - atmo.baseRadius, 0.0);
      float dR = exp(-h / atmo.rayleighHeight);
      float dM = exp(-h / atmo.mieHeight);
      columnR += 0.5 * dR * dt;
      columnM += 0.5 * dM * dt;
      vec2 shadow = raySphere(p, sun, atmo.baseRadius);
      if (!(shadow.x <= shadow.y && shadow.x > 0.0)) {
        vec3 view = exp(-(atmo.rayleigh * columnR + atmo.mieExtinction * columnM));
        light += view * sunTransmittance(p, sun) * (atmo.rayleigh * dR * phaseR + atmo.mieScattering * dM * phaseM) * dt;
      }
      columnR += 0.5 * dR * dt;
      columnM += 0.5 * dM * dt;
      t += dt;
    }
    transmittance = exp(-(atmo.rayleigh * columnR + atmo.mieExtinction * columnM));
  }

  // Venus: the opaque deck under the atmosphere.
  vec3 deck = vec3(0.0);
  float deckAlpha = 0.0;
  if (hitBase && atmo.deckOpacity > 0.0 && tCloud < 0.0) {
    vec3 p = ro + rd * tEnd;
    vec3 n = normalize(p);
    float cosSun = dot(n, sun);
    // The haze above the deck scatters without loss (it belongs to the cloud system): only the
    // gas dims the light on the deck.
    float colR = atmo.rayleighHeight * chapmanColumn(atmo.baseRadius / atmo.rayleighHeight, 0.0, max(cosSun, 0.0));
    vec3 sunLight = cosSun > 0.0 ? exp(-atmo.rayleigh * colR) * cosSun : vec3(0.0);
    deck = atmo.deckAlbedo * deckPattern(p) / PI * sunLight;
    deckAlpha = atmo.deckOpacity;
  }

  vec3 radiance = light + transmittance * (cloudLight + deck * deckAlpha);
  vec3 color = 1.0 - exp(-radiance * atmo.exposure);
  float t = dot(transmittance, vec3(1.0 / 3.0)) * cloudT * (1.0 - deckAlpha);
  float alpha = max(1.0 - t, max(color.r, max(color.g, color.b)));
  if (alpha < 0.002) discard;
  fragColor = vec4(color, alpha) * atmo.opacity;
}
`;

/** Unit sphere, positions only, fine enough that its facets stay within 0.12 % of the radius. */
function sphere(nLon = 96, nLat = 48): Geometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= nLat; j++) {
    const lat = Math.PI / 2 - (Math.PI * j) / nLat;
    for (let i = 0; i <= nLon; i++) {
      const lon = -Math.PI + (2 * Math.PI * i) / nLon;
      positions.push(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    }
  }
  for (let j = 0; j < nLat; j++) {
    for (let i = 0; i < nLon; i++) {
      const a = j * (nLon + 1) + i;
      const b = a + nLon + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return new Geometry({
    topology: 'triangle-list',
    attributes: {positions: {size: 3, value: new Float32Array(positions)}},
    indices: {size: 1, value: new Uint32Array(indices)}
  } as never);
}
/** Facet sag of the sphere above: the mesh is this much larger than the top of the atmosphere. */
const MESH_MARGIN = 1.003;

export type AtmosphereLayerProps = LayerProps & {
  atmosphere: Atmosphere;
  /** Body centre, scene units (after the floating origin). */
  center: V3;
  /** Body radius, scene units. */
  radius: number;
  /** Body axes (x = prime meridian, y = 90 E, z = north), unit vectors in the scene frame. */
  axes: [V3, V3, V3];
  /** Unit vector toward the Sun, scene frame. */
  sunDirection: V3;
  /** Draw the single-scattering atmosphere. */
  atmosphereEnabled: boolean;
  /** Cloud shell, body radii (0: none), and its map (luminance, plate carree, -180 at the left). */
  cloudBase: number;
  cloudTop: number;
  cloudImage: ImageBitmap | null;
  /** Ray-march steps through the clouds (0: no clouds), toward the Sun, and through the air. */
  cloudSteps: number;
  lightSteps: number;
  atmosphereSteps: number;
  /** Opacity of Venus's cloud deck (0: none). */
  deckOpacity: number;
  /** Radiance to display value: 1 - exp(-exposure L). */
  exposure: number;
};

const defaultProps: DefaultProps<AtmosphereLayerProps> = {
  atmosphere: {type: 'object', value: null as never, compare: false},
  center: {type: 'array', value: [0, 0, 0], compare: true},
  radius: 1,
  axes: {type: 'array', value: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as never, compare: true},
  sunDirection: {type: 'array', value: [1, 0, 0], compare: true},
  atmosphereEnabled: true,
  cloudBase: 0,
  cloudTop: 0,
  cloudImage: {type: 'object', value: null, compare: false},
  cloudSteps: 12,
  lightSteps: 3,
  atmosphereSteps: 8,
  deckOpacity: 0,
  exposure: 12
};

let cloudLightTable: Uint8Array | null = null;
/** Each Deck has its own device: the cloud map and the light table are uploaded once per device. */
const deviceTextures = new WeakMap<Device, {image: ImageBitmap | null; map: Texture | null; lut: Texture}>();
function getDeviceTextures(device: Device, image: ImageBitmap | null) {
  let entry = deviceTextures.get(device);
  if (!entry) {
    cloudLightTable ??= getCloudLightTable();
    const lut = device.createTexture({
      data: cloudLightTable,
      width: CLOUD_LUT_SIZE,
      height: 2,
      format: 'rgba8unorm',
      sampler: {minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'}
    });
    entry = {image: null, map: null, lut};
    deviceTextures.set(device, entry);
  }
  if (image && entry.image !== image) {
    entry.map?.destroy();
    const mipLevels = Math.floor(Math.log2(Math.max(image.width, image.height))) + 1;
    const map = device.createTexture({
      data: image,
      width: image.width,
      height: image.height,
      format: 'rgba8unorm',
      mipLevels,
      sampler: {
        minFilter: 'linear',
        magFilter: 'linear',
        mipmapFilter: 'linear',
        addressModeU: 'repeat',
        addressModeV: 'clamp-to-edge'
      }
    });
    map.generateMipmapsWebGL();
    entry.image = image;
    entry.map = map;
  }
  return entry;
}

/** The atmosphere (and clouds) of one body. */
export class AtmosphereLayer extends Layer<AtmosphereLayerProps> {
  static layerName = 'AtmosphereLayer';
  static defaultProps = defaultProps;
  declare state: {model?: Model; emptyTexture?: Texture};

  getShaders() {
    return super.getShaders({vs, fs, modules: [project32, atmoModule]});
  }

  initializeState() {
    if (this.context.device.type !== 'webgl') return;
    const emptyTexture = this.context.device.createTexture({data: new Uint8Array(4), width: 1, height: 1});
    const model = new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      geometry: sphere(),
      isInstanced: false
    });
    this.setState({model, emptyTexture});
  }

  finalizeState(context: Parameters<Layer['finalizeState']>[0]) {
    super.finalizeState(context);
    this.state.emptyTexture?.destroy();
  }

  draw() {
    const {model, emptyTexture} = this.state;
    if (!model || !emptyTexture) return;
    const p = this.props;
    const a = p.atmosphere;
    const {viewport, device} = this.context;
    const textures = getDeviceTextures(device, p.cloudImage);
    // The camera inside the mesh (or nearly): common space, where the viewport keeps its camera.
    const center = viewport.projectPosition(p.center);
    const edge = viewport.projectPosition([p.center[0] + p.radius, p.center[1], p.center[2]]);
    const radius = Math.hypot(edge[0] - center[0], edge[1] - center[1], edge[2] - center[2]);
    const eye = viewport.cameraPosition;
    const meshScale = a.topRadius * MESH_MARGIN;
    const inside = Math.hypot(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]) < radius * meshScale * 1.02;
    const clouds = Boolean(p.cloudTop > 0 && p.cloudSteps > 0 && textures.map);
    const uniforms: AtmoUniforms = {
      center: p.center,
      axisX: p.axes[0],
      axisY: p.axes[1],
      axisZ: p.axes[2],
      sunDirection: p.sunDirection,
      rayleigh: [...a.rayleigh],
      mieScattering: [...a.mieScattering],
      mieExtinction: [...a.mieExtinction],
      deckAlbedo: a.deckAlbedo ? [...a.deckAlbedo] : [0, 0, 0],
      radius: p.radius,
      meshScale,
      inside: inside ? 1 : 0,
      baseRadius: a.baseRadius,
      topRadius: a.topRadius,
      rayleighHeight: a.rayleighHeight,
      mieHeight: a.mieHeight,
      mieAsymmetry: a.mieAsymmetry,
      deckOpacity: a.deckAlbedo ? p.deckOpacity : 0,
      atmosphereOn: p.atmosphereEnabled ? 1 : 0,
      cloudBase: p.cloudBase,
      cloudTop: clouds ? p.cloudTop : 0,
      cloudSteps: clouds ? p.cloudSteps : 0,
      lightSteps: Math.max(1, p.lightSteps),
      atmosphereSteps: Math.max(1, p.atmosphereSteps),
      exposure: p.exposure,
      opacity: p.opacity,
      mapTexelsPerRadian: textures.map ? textures.map.width / (2 * Math.PI) : 1,
      cloudMap: textures.map ?? emptyTexture,
      cloudLut: textures.lut
    };
    model.shaderInputs.setProps({atmo: uniforms});
    // From outside: the front faces, depth-tested, so a moon in front hides the atmosphere.
    // From inside (a globe close to the surface): the back faces, drawn over everything.
    model.setParameters({
      cullMode: inside ? 'front' : 'back',
      depthCompare: inside ? 'always' : 'less-equal',
      depthWriteEnabled: false,
      blend: true,
      blendColorOperation: 'add',
      blendColorSrcFactor: 'one',
      blendColorDstFactor: 'one-minus-src-alpha',
      blendAlphaOperation: 'add',
      blendAlphaSrcFactor: 'one',
      blendAlphaDstFactor: 'one-minus-src-alpha'
    });
    model.draw(this.context.renderPass);
  }
}
