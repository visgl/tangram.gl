// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Space volumes: a WebGL2 canvas over the decks that ray-marches the gas (solar corona, comet
// tails, zodiacal dust, artistic clouds), adds the look-volume haze and draws the seeded dust.
//
// The decks draw on their own canvases, so this pass cannot read their depth buffer. The bodies
// are spheres, so it intersects each ray with them instead: a body ends the ray exactly where
// the deck draws its limb. Every position comes in relative to the camera (subtracted in double
// precision on the CPU), so float32 keeps its precision at any distance.
//
// The march runs into a smaller target (the quality's resolution scale) and is upsampled; the
// dust points draw at full resolution. The canvas is premultiplied: emission adds light (alpha
// 0), clouds and haze also cover what is behind them (alpha > 0).

import type {V3} from '../celestial';
import {dustSeeds, type DustLevel} from './space-dust';

export type Quality = 'low' | 'medium' | 'high';
export const QUALITY: Readonly<Record<Quality, {scale: number; steps: number; dust: number; shadowSteps: number}>> = Object.freeze({
  low: {scale: 0.35, steps: 20, dust: 1000, shadowSteps: 2},
  medium: {scale: 0.5, steps: 36, dust: 2500, shadowSteps: 3},
  high: {scale: 0.75, steps: 64, dust: 5000, shadowSteps: 4}
});

export type CloudInstance = {
  /** Centre relative to the camera, and the radius of the bounding sphere. */
  center: V3;
  radius: number;
  /** World to cloud space (-1..1 per axis): rotation, scale and flip, row-major 3 x 3. */
  toLocal: number[];
  /** Density ramp: thin, middle, dense. Linear 0-1 colours. */
  ramp: [V3, V3, V3];
  /** Sun direction in cloud space (unit). */
  sunLocal: V3;
};

export type VolumeFrame = {
  width: number;
  height: number;
  quality: Quality;
  /** Ray directions (unnormalised, camera-relative) at the corners: bottom-left, bottom-right, top-left, top-right. */
  corners: [V3, V3, V3, V3];
  /** Occluding spheres relative to the camera: [x, y, z, radius]. */
  spheres: number[][];
  corona: null | {center: V3; radius: number; pole: V3; gain: number};
  comet: null | {head: V3; coma: number; ion: V3[]; dust: V3[]; width: number; activity: number};
  zodiacal: null | {sun: V3; bound: number; trueScale: boolean; gain: number};
  clouds: CloudInstance[];
  cloudMode: 'baked' | 'procedural';
  fog: {color: V3; density: number};
  dust: null | {levels: DustLevel[]; size: number};
};

const ION_POINTS = 8;
const DUST_POINTS = 12;
const MAX_SPHERES = 16;
const MAX_CLOUDS = 4;

const VS_QUAD = `#version 300 es
in vec2 aPos;
uniform vec3 uCorners[4];
out vec3 vDir;
out vec2 vUv;
void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vDir = mix(mix(uCorners[0], uCorners[1], t.x), mix(uCorners[2], uCorners[3], t.x), t.y);
  vUv = t;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FS_MARCH = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec3 vDir;
out vec4 fragColor;
uniform vec4 uSpheres[${MAX_SPHERES}];
uniform int uSphereCount;
uniform int uSteps;
uniform int uShadowSteps;
uniform bool uCoronaOn;
uniform vec4 uSun;
uniform vec3 uSunPole;
uniform float uCoronaGain;
uniform bool uCometOn;
uniform vec4 uComa;
uniform vec3 uIon[${ION_POINTS}];
uniform vec3 uDustTail[${DUST_POINTS}];
uniform float uTailWidth;
uniform float uActivity;
uniform vec4 uCometBound;
uniform bool uZodiOn;
uniform vec4 uZodi;
uniform bool uTrueScale;
uniform float uZodiGain;
uniform int uCloudCount;
uniform vec4 uCloudBound[${MAX_CLOUDS}];
uniform mat3 uCloudToLocal[${MAX_CLOUDS}];
uniform vec3 uRamp0[${MAX_CLOUDS}];
uniform vec3 uRamp1[${MAX_CLOUDS}];
uniform vec3 uRamp2[${MAX_CLOUDS}];
uniform vec3 uCloudSun[${MAX_CLOUDS}];
uniform bool uProcedural;
uniform sampler3D uCloudTex;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return s;
}
/** Entry and exit distances of the ray through a sphere; x > y when it misses. */
vec2 sphereSpan(vec3 rd, vec3 c, float r) {
  float b = dot(c, rd);
  float h = b * b - (dot(c, c) - r * r);
  if (h < 0.0) return vec2(1.0, 0.0);
  h = sqrt(h);
  return vec2(b - h, b + h);
}
float segmentDistance(vec3 p, vec3 a, vec3 b, out float h) {
  vec3 ab = b - a;
  h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-20), 0.0, 1.0);
  return length(p - a - ab * h);
}
float cloudDensity(int k, vec3 local) {
  if (any(greaterThan(abs(local), vec3(1.0)))) return 0.0;
  if (uProcedural) {
    float r = length(local * vec3(1.0, 1.15, 1.7));
    float envelope = pow(max(0.0, 1.0 - r * r), 1.5);
    return clamp((fbm(local * 2.6 + vec3(11.0, 0.0, 0.0)) * 1.6 - 0.55) * envelope * 2.4, 0.0, 1.0);
  }
  return texture(uCloudTex, local * 0.5 + 0.5).r;
}
vec3 rampAt(int k, float d) {
  vec3 c = mix(uRamp0[k], uRamp1[k], smoothstep(0.02, 0.35, d));
  return mix(c, uRamp2[k], smoothstep(0.35, 0.9, d));
}

void main() {
  vec3 rd = normalize(vDir);
  float jitter = hash13(vec3(gl_FragCoord.xy, 7.0));
  // Nearest body along the ray: the analytic depth.
  float tMax = 1e30;
  for (int k = 0; k < ${MAX_SPHERES}; k++) {
    if (k >= uSphereCount) break;
    vec2 s = sphereSpan(rd, uSpheres[k].xyz, uSpheres[k].w);
    if (s.x <= s.y && s.y > 0.0) tMax = min(tMax, max(s.x, 0.0));
  }
  vec3 emission = vec3(0.0);
  float steps = float(uSteps);

  if (uCoronaOn) {
    vec2 s = sphereSpan(rd, uSun.xyz, uSun.w * 3.0);
    s.x = max(s.x, 0.0); s.y = min(s.y, tMax);
    if (s.x < s.y) {
      float dt = (s.y - s.x) / steps;
      float sum = 0.0;
      for (int k = 0; k < 128; k++) {
        if (k >= uSteps) break;
        vec3 p = rd * (s.x + (float(k) + jitter) * dt) - uSun.xyz;
        float r = length(p) / uSun.w;
        if (r < 1.0) continue;
        // Baumbach (1937) electron density, in units of 1e8 cm^-3.
        float n = 0.036 * pow(r, -1.5) + 1.55 * pow(r, -6.0) + 2.99 * pow(r, -16.0);
        // Streamers (artistic): noise of the direction only, so the structure is radial,
        // stronger near the solar equator, bending a little with height.
        vec3 dir = p / (r * uSun.w);
        float lat = dot(dir, uSunPole);
        float streak = vnoise(dir * 6.0 + vec3(0.0, 0.0, r * 0.25)) * 0.6 + vnoise(dir * 15.0) * 0.4;
        float streamer = 0.35 + 2.2 * pow(streak, 3.0) * (1.0 - 0.7 * lat * lat);
        // Display compression: the density spans four decades from 1 to 3.5 radii, as an
        // eclipse photograph needs a radial filter to show it.
        sum += pow(n, 0.7) * streamer * smoothstep(3.0, 2.0, r) * dt / uSun.w;
      }
      emission += vec3(1.0, 0.82, 0.58) * uCoronaGain * sum;
    }
  }

  if (uCometOn && uActivity > 1e-3) {
    vec2 s = sphereSpan(rd, uCometBound.xyz, uCometBound.w);
    s.x = max(s.x, 0.0); s.y = min(s.y, tMax);
    if (s.x < s.y) {
      float n2 = 2.0 * steps;
      float dt = (s.y - s.x) / n2;
      vec3 ion = vec3(0.0), dust = vec3(0.0), coma = vec3(0.0);
      for (int k = 0; k < 256; k++) {
        if (float(k) >= n2) break;
        vec3 p = rd * (s.x + (float(k) + jitter) * dt);
        float dc = length(p - uComa.xyz) / uComa.w;
        coma += vec3(0.75, 0.95, 0.85) * exp(-dc * dc) * dt / uComa.w;
        float best = 0.0;
        for (int i = 0; i < ${ION_POINTS - 1}; i++) {
          float h;
          float d = segmentDistance(p, uIon[i], uIon[i + 1], h);
          float t = (float(i) + h) / ${(ION_POINTS - 1).toFixed(1)};
          float w = uTailWidth * (0.15 + 0.6 * t);
          best = max(best, exp(-(d * d) / (w * w)) * pow(1.0 - t, 1.5) * uTailWidth / w);
        }
        ion += vec3(0.35, 0.6, 1.0) * best * dt / uTailWidth;
        best = 0.0;
        for (int i = 0; i < ${DUST_POINTS - 1}; i++) {
          float h;
          float d = segmentDistance(p, uDustTail[i], uDustTail[i + 1], h);
          float t = (float(i) + h) / ${(DUST_POINTS - 1).toFixed(1)};
          float w = uTailWidth * (0.25 + 2.2 * t);
          best = max(best, exp(-(d * d) / (w * w)) * pow(1.0 - t, 1.2) * uTailWidth / w);
        }
        dust += vec3(1.0, 0.88, 0.66) * best * dt / uTailWidth;
      }
      emission += uActivity * (0.9 * coma + 0.55 * ion + 0.7 * dust);
    }
  }

  if (uZodiOn) {
    vec2 s = sphereSpan(rd, uZodi.xyz, uZodi.w);
    s.x = max(s.x, 0.0); s.y = min(s.y, tMax);
    if (s.x < s.y) {
      float dt = (s.y - s.x) / steps;
      float sum = 0.0;
      for (int k = 0; k < 128; k++) {
        if (k >= uSteps) break;
        vec3 p = rd * (s.x + (float(k) + jitter) * dt) - uZodi.xyz;
        float d = length(p);
        // Scene distance to AU: the inverse of the readable or true scale.
        float r = uTrueScale ? d * 1e6 / 149597870.7 : 0.2 * (exp2(d / 40.0) - 1.0);
        float zeta = abs(p.z) / max(d, 1e-6);
        float g = zeta < 0.189 ? zeta * zeta / 0.378 : zeta - 0.0945;
        // Kelsall et al. (1998) fan; lit by sunlight (1 / r^2, softened to 1 / r).
        float n = pow(max(r, 0.05), -1.34) * exp(-4.14 * pow(g, 0.942));
        sum += n / max(r, 0.1) * smoothstep(0.1, 0.5, r) * smoothstep(5.0, 3.0, r) * dt / uZodi.w;
      }
      emission += vec3(0.95, 0.85, 0.7) * uZodiGain * sum;
    }
  }

  // Clouds: front-to-back with absorption, lit by the Sun through a few self-shadow steps.
  vec3 cloud = vec3(0.0);
  float transmittance = 1.0;
  for (int k = 0; k < ${MAX_CLOUDS}; k++) {
    if (k >= uCloudCount) break;
    vec2 s = sphereSpan(rd, uCloudBound[k].xyz, uCloudBound[k].w);
    s.x = max(s.x, 0.0); s.y = min(s.y, tMax);
    if (s.x >= s.y) continue;
    float dt = (s.y - s.x) / steps;
    // Optical depth per unit of cloud space (the cloud spans 2 units).
    float dtLocal = dt / uCloudBound[k].w;
    for (int i = 0; i < 128; i++) {
      if (i >= uSteps || transmittance < 0.02) break;
      vec3 p = rd * (s.x + (float(i) + jitter) * dt) - uCloudBound[k].xyz;
      vec3 local = uCloudToLocal[k] * p;
      float d = cloudDensity(k, local);
      if (d < 0.01) continue;
      float tau = 0.0;
      for (int j = 1; j <= 4; j++) {
        if (j > uShadowSteps) break;
        tau += cloudDensity(k, local + uCloudSun[k] * (0.12 * float(j)));
      }
      float light = exp(-tau * 1.6);
      vec3 c = rampAt(k, d);
      float sigma = 5.0 * d * dtLocal;
      cloud += transmittance * (c * (0.25 + 1.1 * light) + c * c * 0.35) * sigma;
      transmittance *= exp(-sigma);
    }
  }
  // Emission is additive (alpha 0); the clouds cover what is behind them.
  vec3 glow = 1.0 - exp(-emission);
  fragColor = vec4(cloud + glow * transmittance, 1.0 - transmittance);
}`;

const FS_COMPOSE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVolume;
uniform vec2 uTexel;
uniform vec4 uFog;
void main() {
  // A 3 x 3 tent filter over the small target: it hides the noise of the jittered march.
  vec4 v = vec4(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    float w = float((2 - abs(x)) * (2 - abs(y)));
    v += w * texture(uVolume, vUv + vec2(x, y) * uTexel);
  }
  v /= 16.0;
  float f = uFog.a;
  fragColor = vec4(uFog.rgb * f + v.rgb * (1.0 - f), f + v.a * (1.0 - f));
}`;

const VS_DUST = `#version 300 es
in vec3 aSeed;
uniform mat4 uViewProjection;
uniform float uCell;
uniform vec3 uOffset;
uniform float uWeight;
uniform float uSize;
uniform vec4 uSpheres[${MAX_SPHERES}];
uniform int uSphereCount;
out float vAlpha;
void main() {
  vec3 v = aSeed * uCell - uOffset + 0.5 * uCell;
  vec3 p = v - uCell * floor(v / uCell) - 0.5 * uCell;
  float d = length(p);
  float near = min(1.0, d / (0.02 * uCell));
  float far = clamp((0.5 * uCell - d) / (0.25 * uCell), 0.0, 1.0);
  vAlpha = near * near * far * uWeight;
  // Hidden behind a body: the segment from the camera to the point crosses a sphere.
  vec3 rd = p / max(d, 1e-20);
  for (int k = 0; k < ${MAX_SPHERES}; k++) {
    if (k >= uSphereCount) break;
    float b = dot(uSpheres[k].xyz, rd);
    float h = b * b - (dot(uSpheres[k].xyz, uSpheres[k].xyz) - uSpheres[k].w * uSpheres[k].w);
    if (h > 0.0 && b - sqrt(h) < d && b + sqrt(h) > 0.0) vAlpha = 0.0;
  }
  gl_Position = uViewProjection * vec4(p, 1.0);
  gl_PointSize = uSize * (0.6 + 0.8 * fract(aSeed.x * 97.0));
}`;

const FS_DUST = `#version 300 es
precision highp float;
in float vAlpha;
out vec4 fragColor;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float a = vAlpha * max(0.0, 1.0 - dot(c, c));
  fragColor = vec4(vec3(0.75, 0.8, 0.9) * a * 0.8, 0.0);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const program = gl.createProgram() as WebGLProgram;
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`space volumes shader: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`space volumes link: ${gl.getProgramInfoLog(program)}`);
  const cache = new Map<string, WebGLUniformLocation | null>();
  const loc = (name: string) => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
    return cache.get(name) ?? null;
  };
  return {program, loc};
}

export type SpaceVolumes = ReturnType<typeof createSpaceVolumes>;

/** The space-volume renderer on a canvas; `draw` renders one frame, `clear` empties it. */
export function createSpaceVolumes(canvas: HTMLCanvasElement) {
  let cloudVolume: {size: number; data: Uint8Array} | null = null;
  const gl = canvas.getContext('webgl2', {alpha: true, premultipliedAlpha: true, antialias: false, depth: false}) as WebGL2RenderingContext;
  if (!gl) throw new Error('space volumes need WebGL2');
  const march = compile(gl, VS_QUAD, FS_MARCH);
  const compose = compile(gl, VS_QUAD, FS_COMPOSE);
  const dustProgram = compile(gl, VS_DUST, FS_DUST);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const seedBuffer = gl.createBuffer();
  let seedCount = 0;
  const cloudTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, cloudTexture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
  for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE]]) {
    gl.texParameteri(gl.TEXTURE_3D, p, v);
  }
  const target = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  let targetSize = [0, 0];

  function bindQuad(program: WebGLProgram) {
    const a = gl.getAttribLocation(program, 'aPos');
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(a);
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  }
  function setSpheres(loc: (n: string) => WebGLUniformLocation | null, spheres: number[][]) {
    const list = spheres.slice(0, MAX_SPHERES);
    gl.uniform1i(loc('uSphereCount'), list.length);
    if (list.length) gl.uniform4fv(loc('uSpheres[0]'), new Float32Array(list.flat()));
  }

  function clear() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Renders a frame; returns the CPU time spent, ms. */
  function draw(frame: VolumeFrame, viewProjection: ArrayLike<number>): number {
    const t0 = performance.now();
    const q = QUALITY[frame.quality];
    if (canvas.width !== frame.width || canvas.height !== frame.height) {
      canvas.width = frame.width;
      canvas.height = frame.height;
    }
    const w = Math.max(1, Math.round(frame.width * q.scale));
    const h = Math.max(1, Math.round(frame.height * q.scale));
    if (targetSize[0] !== w || targetSize[1] !== h) {
      targetSize = [w, h];
      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // 1. The march, into the small target.
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, w, h);
    const {program, loc} = march;
    gl.useProgram(program);
    bindQuad(program);
    gl.uniform3fv(loc('uCorners[0]'), new Float32Array(frame.corners.flat()));
    setSpheres(loc, frame.spheres);
    gl.uniform1i(loc('uSteps'), q.steps);
    gl.uniform1i(loc('uShadowSteps'), q.shadowSteps);
    const {corona, comet, zodiacal} = frame;
    gl.uniform1i(loc('uCoronaOn'), corona ? 1 : 0);
    if (corona) {
      gl.uniform4f(loc('uSun'), ...corona.center, corona.radius);
      gl.uniform3f(loc('uSunPole'), ...corona.pole);
      gl.uniform1f(loc('uCoronaGain'), corona.gain);
    }
    gl.uniform1i(loc('uCometOn'), comet ? 1 : 0);
    if (comet) {
      gl.uniform4f(loc('uComa'), ...comet.head, comet.coma);
      gl.uniform3fv(loc('uIon[0]'), new Float32Array(comet.ion.flat()));
      gl.uniform3fv(loc('uDustTail[0]'), new Float32Array(comet.dust.flat()));
      gl.uniform1f(loc('uTailWidth'), comet.width);
      gl.uniform1f(loc('uActivity'), comet.activity);
      const all = [comet.head, ...comet.ion, ...comet.dust];
      const c = [0, 1, 2].map(k => all.reduce((a, p) => a + p[k], 0) / all.length) as V3;
      const r = Math.max(...all.map(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]))) + 3 * comet.width + 3 * comet.coma;
      gl.uniform4f(loc('uCometBound'), ...c, r);
    }
    gl.uniform1i(loc('uZodiOn'), zodiacal ? 1 : 0);
    if (zodiacal) {
      gl.uniform4f(loc('uZodi'), ...zodiacal.sun, zodiacal.bound);
      gl.uniform1i(loc('uTrueScale'), zodiacal.trueScale ? 1 : 0);
      gl.uniform1f(loc('uZodiGain'), zodiacal.gain);
    }
    const clouds = frame.clouds.slice(0, MAX_CLOUDS);
    gl.uniform1i(loc('uCloudCount'), clouds.length);
    gl.uniform1i(loc('uProcedural'), frame.cloudMode === 'procedural' || !cloudVolume ? 1 : 0);
    if (clouds.length) {
      gl.uniform4fv(loc('uCloudBound[0]'), new Float32Array(clouds.flatMap(c => [...c.center, c.radius])));
      // uniformMatrix3fv reads column-major: transpose the row-major matrices.
      gl.uniformMatrix3fv(loc('uCloudToLocal[0]'), true, new Float32Array(clouds.flatMap(c => c.toLocal)));
      gl.uniform3fv(loc('uRamp0[0]'), new Float32Array(clouds.flatMap(c => c.ramp[0])));
      gl.uniform3fv(loc('uRamp1[0]'), new Float32Array(clouds.flatMap(c => c.ramp[1])));
      gl.uniform3fv(loc('uRamp2[0]'), new Float32Array(clouds.flatMap(c => c.ramp[2])));
      gl.uniform3fv(loc('uCloudSun[0]'), new Float32Array(clouds.flatMap(c => c.sunLocal)));
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, cloudTexture);
    gl.uniform1i(loc('uCloudTex'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 2. Upsample and haze, into the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(compose.program);
    bindQuad(compose.program);
    gl.uniform3fv(compose.loc('uCorners[0]'), new Float32Array(12));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.uniform1i(compose.loc('uVolume'), 1);
    gl.uniform2f(compose.loc('uTexel'), 1 / w, 1 / h);
    gl.uniform4f(compose.loc('uFog'), ...frame.fog.color, Math.max(0, Math.min(1, frame.fog.density)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. Dust, added at full resolution.
    if (frame.dust) {
      const count = q.dust;
      if (seedCount !== count) {
        seedCount = count;
        gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, dustSeeds(count), gl.STATIC_DRAW);
      }
      const {program: dp, loc: dl} = dustProgram;
      gl.useProgram(dp);
      const a = gl.getAttribLocation(dp, 'aSeed');
      gl.bindBuffer(gl.ARRAY_BUFFER, seedBuffer);
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 3, gl.FLOAT, false, 0, 0);
      gl.uniformMatrix4fv(dl('uViewProjection'), false, new Float32Array(viewProjection));
      setSpheres(dl, frame.spheres);
      gl.uniform1f(dl('uSize'), frame.dust.size);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (const level of frame.dust.levels) {
        if (level.weight < 0.01) continue;
        gl.uniform1f(dl('uCell'), level.cell);
        gl.uniform3f(dl('uOffset'), ...level.offset);
        gl.uniform1f(dl('uWeight'), level.weight);
        gl.drawArrays(gl.POINTS, 0, count);
      }
      gl.disable(gl.BLEND);
    }
    return performance.now() - t0;
  }
  /** The baked cloud density: size^3 bytes, x fastest. Until it arrives the clouds use the procedural density. */
  function setCloudVolume(volume: {size: number; data: Uint8Array}) {
    if (volume.data.length !== volume.size ** 3) throw new Error(`cloud volume: ${volume.data.length} bytes for size ${volume.size}`);
    cloudVolume = volume;
    gl.bindTexture(gl.TEXTURE_3D, cloudTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, volume.size, volume.size, volume.size, 0, gl.RED, gl.UNSIGNED_BYTE, volume.data);
  }
  return {draw, clear, setCloudVolume, gl};
}
