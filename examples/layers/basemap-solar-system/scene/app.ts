// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The solar system: an OrbitView overview of the Sun, the eight planets and the Moon at their
// positions for a date. A click flies to a body and hands over to a GlobeView with a BasemapLayer
// of that body. A compare mode shows the Earth, the Moon and Mars side by side.

import {
  AmbientLight,
  Deck,
  LightingEffect,
  OrbitView,
  PointLight,
  Viewport,
  _GlobeView as GlobeView
} from '@deck.gl/core';
import {BitmapLayer, PathLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {Geometry} from '@luma.gl/engine';
import {Matrix4} from '@math.gl/core';
import {BasemapLayer} from '@tangram.gl/basemap-layers';
import {
  ATMOSPHERE_IDS,
  BODY_IDS,
  EARTH_CLOUD_BASE_KM,
  EARTH_CLOUD_TOP_KM,
  GALILEAN,
  PHYSICAL_CONSTANTS,
  KM_PER_AU,
  NEOWISE,
  PLANET_IDS,
  SATURN_RINGS,
  STAR_SOURCE,
  angleDeg,
  checkTerminator,
  cometOrbit,
  dot,
  getAtmosphere,
  getBodyAxes,
  getGalileanOffsets,
  getMoonPhase,
  getNormalGravity,
  getPole,
  getStarPoints,
  getTerminator,
  moonGeocentric,
  getShadowGeometry,
  COMET_PERIHELION_DATE,
  findEclipses,
  planetOrbit,
  planetPosition,
  unit,
  SHADOWED_BODIES,
  type BodyId,
  type PlanetId,
  type ShadowGeometry,
  type SkyEvent,
  type V3
} from '../celestial';
import {
  BODIES,
  EARTH_CLOUD_CREDIT,
  EARTH_STYLE_URL,
  getEarthCloudMap,
  getBodyStyle,
  getVectorTexture,
  surfaceCredit,
  type BasemapStyle,
  type Body,
  type SurfaceMode
} from '../bodies';
import {AtmosphereLayer} from './atmosphere-layer';
import {LABEL_FONT} from './labels';
import {getMilkyWayTexture, getRingTexture} from './textures';
import {isCameraIdle, shiftCameras, shouldRebase, withoutTransition, type CameraActivity} from './floating-origin';
import {getEquirectTexture, getTileStats, shimFetch} from './tiles';
import {MULTIPLY_PARAMETERS, ShadowExtension, shadowUniforms} from './shadow-extension';
import {DEFAULT_LOOK, blendLook, exposureGain, type LookBlend} from './look-volumes';
import {CLOUDS, cloudPlacement, cometAt, lookVolumes, volumeFrame, type SpaceScene, type SpaceToggles} from './space';
import {QUALITY, createSpaceVolumes, type Quality, type SpaceVolumes} from './space-volumes';
import {CARD_IDS, createPanel, type CardId} from './panel';
type Mode = 'overview' | 'globe' | 'compare';

const params = new URLSearchParams(location.search);
/** `?comet=perihelion`: the clock starts at the comet's perihelion and the view shows the comet. */
const COMET_PERIHELION = params.get('comet') === 'perihelion';
const COMPARE_IDS: BodyId[] = ['earth', 'moon', 'mars'];
/** Compare globes stay clear of the status readout (top) and the time dock (bottom). */
const COMPARE_TOP = 48;
const COMPARE_BOTTOM = 96;
/** Rotation of the overview at the start, deg. */
const START_ORBIT = 30;
/** `?quality=`: one level for the cloud steps and the space volumes. */
const START_QUALITY = (['low', 'medium', 'high'].includes(params.get('quality') ?? '') ? params.get('quality') : 'medium') as Quality;
/** Ray-march steps through the cloud shell at each quality level. */
const QUALITY_CLOUD_STEPS: Record<Quality, number> = {low: 6, medium: 12, high: 24};
const state = {
  mode: (['overview', 'globe', 'compare'].includes(params.get('mode') ?? '') ? params.get('mode') : 'overview') as Mode,
  body: (params.get('body') ?? 'earth') in BODIES ? (params.get('body') as BodyId) : ('earth' as BodyId),
  scale: (params.get('scale') === 'true' ? 'true' : 'readable') as 'readable' | 'true',
  /** Centre of the time bar: the comet's perihelion (`comet=perihelion`), the `date` parameter (a
   * day at UTC midnight, or an ISO time), or now. */
  baseDate: COMET_PERIHELION ? COMET_PERIHELION_DATE : parseDate(params.get('date')),
  offsetDays: Number(params.get('offset') ?? 0),
  /** Half-width of the time bar, days. */
  spanDays: 365,
  linked: params.get('linked') !== 'off',
  playing: false,
  /** Playback speed, simulated seconds per real second. */
  speed: Number(params.get('speed') ?? 86400),
  surface: (params.get('surface') === 'imagery' ? 'imagery' : 'vector') as SurfaceMode,
  night: params.get('night') !== 'off',
  /** Eclipse shadows (analytic, in the fragment shader). */
  shadows: params.get('shadows') !== 'off',
  /** The globe camera turns with the body; off (default), it keeps its orientation in space. */
  corotate: params.get('rotate') === 'on',
  /** The Earth's clouds (and the cloud deck of Venus). */
  clouds: params.get('clouds') !== 'off',
  /** Ray-march steps through the cloud shell: the quality level, or `?cloudQuality=` (1 to 32). */
  cloudSteps: Math.min(32, Math.max(1, Math.round(Number(params.get('cloudQuality') ?? 0)) || QUALITY_CLOUD_STEPS[START_QUALITY])),
  /** Single-scattering atmospheres of the Earth, Mars and Venus. */
  atmosphere: params.get('atmosphere') !== 'off',
  overviewView: {target: [0, 0, 0] as V3, zoom: 0, rotationOrbit: START_ORBIT, rotationX: 35, minZoom: -12, maxZoom: 30},
  globeViews: {} as Record<string, {longitude: number; latitude: number; zoom: number; bearing?: number; pitch?: number; minZoom?: number; maxZoom?: number}>,
  clicked: null as null | {body: BodyId; lat: number; lon: number},
  /** Space volumes: look volumes, corona, comet, gas clouds, dust; and their quality. */
  space: {
    looks: params.get('looks') !== 'off',
    corona: params.get('corona') !== 'off',
    comet: params.get('comet') !== 'off',
    gas: params.get('gas') !== 'off',
    dust: params.get('dust') !== 'off',
    cloudMode: params.get('cloud') === 'procedural' ? 'procedural' : 'baked',
    quality: START_QUALITY
  } as SpaceToggles,
  /** Overview camera when it is not an OrbitView state: globe mode and the fly-out. */
  camera: null as null | Camera
};

/** `2024-04-08` is UTC midnight; `2024-04-08T18:18Z` (any ISO time) is that instant. */
function parseDate(value: string | null): Date {
  if (!value) return new Date();
  const date = new Date(value.includes('T') ? value : `${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

// ---------- Scene geometry ----------

const READABLE_DIST = (rAU: number) => 40 * Math.log2(1 + rAU / 0.2);
const READABLE_RADIUS = (rKm: number) => 1.2 + 1.6 * Math.log2(rKm / 1000 + 1);
const TRUE_UNIT_KM = 1e6;

const norm = (p: V3) => Math.hypot(p[0], p[1], p[2]);
const scaleV = (p: V3, k: number): V3 => [p[0] * k, p[1] * k, p[2] * k];
const addV = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** Heliocentric AU to scene units. */
function place(pAU: V3): V3 {
  if (state.scale === 'true') return scaleV(pAU, KM_PER_AU / TRUE_UNIT_KM);
  const r = norm(pAU);
  return r === 0 ? [0, 0, 0] : scaleV(pAU, READABLE_DIST(r) / r);
}
function radiusOf(body: Body) {
  return state.scale === 'true' ? body.radiusKm / TRUE_UNIT_KM : READABLE_RADIUS(body.radiusKm);
}

type Scene = {
  date: Date;
  pos: Record<BodyId, V3>;
  radius: Record<BodyId, number>;
  matrix: Record<BodyId, number[]>;
  orbits: {id: BodyId; path: V3[]}[];
  /** Anti-solar unit vectors (overview frame) for the Earth and Moon night caps. */
  earthNight: V3;
  moonNight: V3;
  /** Sub-solar direction, Earth-fixed, from math.gl getSunTerminator. */
  sunFixed: V3;
  /** Angle between math.gl's sub-solar direction and the scene's Earth-to-Sun line, deg. */
  earthLightErrorDeg: number;
  /** Illuminated fraction of the overview Moon seen from the Earth (scene geometry). */
  moonSceneFraction: number;
  galilean: {label: string; position: V3; radius: number}[];
  galileanOrbits: V3[][];
  saturnAxes: [V3, V3, V3];
  /** Anti-solar unit vector of each body (overview frame): its night caps and night cells. */
  night: Record<BodyId, V3>;
  /** Eclipse shadows on each body that can receive one, and on Saturn's rings (true geometry). */
  shadows: Partial<Record<BodyId, ShadowGeometry | null>>;
  ringShadow: ShadowGeometry | null;
  /** The comet (relative to the floating origin) and the inner part of its orbit. */
  comet: {position: V3; orbit: V3[]; r: number};
};
/** The comet's orbit inside 40 AU, heliocentric AU (fixed: two-body elements). */
const COMET_ORBIT_AU = cometOrbit(NEOWISE, 2048).filter(p => norm(p) < 40);


/** Column-major 4 x 4 from body axes (columns x, y, z) and a uniform scale. */
function axesMatrix([x, y, z]: [V3, V3, V3], s: number): number[] {
  return [x[0] * s, x[1] * s, x[2] * s, 0, y[0] * s, y[1] * s, y[2] * s, 0, z[0] * s, z[1] * s, z[2] * s, 0, 0, 0, 0, 1];
}
/** Any orthonormal basis whose z is `z`. */
function basisFromZ(z: V3): [V3, V3, V3] {
  const a: V3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = unit([a[1] * z[2] - a[2] * z[1], a[2] * z[0] - a[0] * z[2], a[0] * z[1] - a[1] * z[0]]);
  const y: V3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x, y, z];
}
/** Rotation part of a column-major 4 x 4, applied to a vector. */
const rotate4 = (m: number[], v: readonly number[]): V3 => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2]
];
/** Readable-scale orbit radii of the Galilean moons, in Jupiter radii. */
const GALILEAN_READABLE = [1.7, 2.25, 2.9, 3.6];

/** Orbits change slowly: sample each once per (UTC) year of the clock. */
const orbitCache = new Map<string, V3[]>();
function getOrbit(id: PlanetId, date: Date): V3[] {
  const year = date.getUTCFullYear();
  const key = `${id}:${year}`;
  let orbit = orbitCache.get(key);
  if (!orbit) {
    if (orbitCache.size > 64) orbitCache.clear();
    orbit = planetOrbit(id, new Date(Date.UTC(year, 6, 1)));
    orbitCache.set(key, orbit);
  }
  return orbit;
}

function computeScene(): Scene {
  const date = new Date(state.baseDate.getTime() + state.offsetDays * 86400000);
  const pos = {} as Record<BodyId, V3>;
  const radius = {} as Record<BodyId, number>;
  const matrix = {} as Record<BodyId, number[]>;
  for (const id of BODY_IDS) radius[id] = radiusOf(BODIES[id]);
  pos.sun = [0, 0, 0];
  const helio = {} as Record<BodyId, V3>;
  for (const id of PLANET_IDS) {
    helio[id] = planetPosition(id, date);
    pos[id] = place(helio[id]);
  }
  const moonGeo = moonGeocentric(date);
  const moonDir = scaleV(moonGeo, 1 / norm(moonGeo));
  const moonDist =
    state.scale === 'true' ? (norm(moonGeo) * KM_PER_AU) / TRUE_UNIT_KM : radius.earth + 2.2 + radius.moon;
  pos.moon = addV(pos.earth, scaleV(moonDir, moonDist));

  // Pole and prime meridian of every body: IAU WGCCRE models from Astronomy Engine.
  const axes = {} as Record<BodyId, [V3, V3, V3]>;
  for (const id of BODY_IDS) {
    axes[id] = getBodyAxes(id, date);
    matrix[id] = axesMatrix(axes[id], radius[id]);
  }

  // Earth day/night from math.gl: the Earth-fixed sub-solar direction, turned into the overview
  // frame by the same Earth axes that orient the texture. earthLightErrorDeg checks the two models.
  const sunFixed = getTerminator(date).sunDirection;
  const sunScene = unit(rotate4(axesMatrix(axes.earth, 1), sunFixed));
  const earthNight: V3 = [-sunScene[0], -sunScene[1], -sunScene[2]];
  const earthLightErrorDeg = angleDeg(sunScene, [-helio.earth[0], -helio.earth[1], -helio.earth[2]]);
  // The Moon's night side faces away from the Sun along the true heliocentric Moon direction (in
  // readable scale the drawn Moon is not where the real one is, so a point light would be wrong).
  const moonNight = unit(addV(helio.earth, moonGeo));
  const moonToEarth = unit(scaleV(moonGeo, -1));
  const moonSceneFraction = (1 + dot(scaleV(moonNight, -1), moonToEarth)) / 2;

  // Galilean moons: true direction from Jupiter; readable scale puts them on enlarged circles
  // in Jupiter's equator plane.
  const [jx, jy] = axes.jupiter;
  const jupiterR = radius.jupiter;
  const offsets = getGalileanOffsets(date);
  const galilean = GALILEAN.map((moon, k) => {
    const o = offsets[k];
    let position: V3;
    if (state.scale === 'true') {
      position = addV(pos.jupiter, scaleV(o, KM_PER_AU / TRUE_UNIT_KM));
    } else {
      const a = Math.atan2(dot(o, jy), dot(o, jx));
      const r = GALILEAN_READABLE[k] * jupiterR;
      position = addV(pos.jupiter, addV(scaleV(jx, r * Math.cos(a)), scaleV(jy, r * Math.sin(a))));
    }
    const r = state.scale === 'true' ? moon.radiusKm / TRUE_UNIT_KM : 0.35 * READABLE_RADIUS(moon.radiusKm);
    return {label: moon.label, position, radius: r};
  });
  const galileanOrbits = GALILEAN.map((moon, k) => {
    const r = state.scale === 'true' ? moon.orbitKm / TRUE_UNIT_KM : GALILEAN_READABLE[k] * jupiterR;
    const path: V3[] = [];
    for (let i = 0; i <= 128; i++) {
      const a = (2 * Math.PI * i) / 128;
      path.push(addV(pos.jupiter, addV(scaleV(jx, r * Math.cos(a)), scaleV(jy, r * Math.sin(a)))));
    }
    return path;
  });

  const orbits: {id: BodyId; path: V3[]}[] = PLANET_IDS.map(id => ({id, path: getOrbit(id, date).map(place)}));
  const moonOrbit: V3[] = [];
  for (let k = 0; k <= 96; k++) {
    const a = (2 * Math.PI * k) / 96;
    moonOrbit.push(addV(pos.earth, [moonDist * Math.cos(a), moonDist * Math.sin(a), 0]));
  }
  orbits.push({id: 'moon', path: moonOrbit});
  const night = {sun: [0, 0, 1]} as Record<BodyId, V3>;
  for (const id of PLANET_IDS) night[id] = unit(helio[id]);
  night.earth = earthNight;
  night.moon = moonNight;
  // Floating origin: every position goes to the GPU relative to `origin`, subtracted here in
  // double precision, so float32 keeps its precision near the body in view.
  const rel = (p: V3): V3 => [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
  for (const id of BODY_IDS) pos[id] = rel(pos[id]);
  for (const orbit of orbits) orbit.path = orbit.path.map(rel);
  for (const g of galilean) g.position = rel(g.position);
  for (const sun of sunLights) sun.position = pos.sun;
  // Shadows use true positions and radii in any scale: they are computed per receiving body, in
  // its body-fixed frame, and drawn onto the drawn sphere by direction (scene/shadow-extension.ts).
  const shadows: Scene['shadows'] = {};
  for (const id of SHADOWED_BODIES) shadows[id] = getShadowGeometry(id, date, SATURN_RINGS);
  const ringShadow = getShadowGeometry('saturn', date, SATURN_RINGS, 'rings');
  const cometNow = cometAt(date);
  const comet = {position: rel(place(cometNow.position)), orbit: COMET_ORBIT_AU.map(p => rel(place(p))), r: cometNow.r};
  return {
    comet,
    date, pos, radius, matrix, orbits, earthNight, moonNight, sunFixed, earthLightErrorDeg,
    moonSceneFraction, galilean, galileanOrbits: galileanOrbits.map(path => path.map(rel)), saturnAxes: axes.saturn, night,
    shadows, ringShadow
  };
}

/**
 * The floating origin, in absolute scene units (Sun at 0), kept in double precision. Between
 * flights it follows the body or the point in view (originUpdate); during a flight it stays put,
 * because the flight keeps camera positions relative to it.
 */
let origin: V3 = [0, 0, 0];
/** Moves the floating origin to an absolute point, and shifts the cameras with it in one step. */
function rebaseOrigin(next: V3) {
  const cameras = shiftCameras(subV(next, origin), state.overviewView, state.camera);
  origin = next;
  state.overviewView = cameras.overview;
  state.camera = cameras.camera;
}
/** The absolute point that the floating origin follows: the globe body, or the overview target. */
function originTarget(): V3 {
  const p = state.mode === 'globe' ? scene.pos[state.body] : (state.camera?.target ?? state.overviewView.target);
  return [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]];
}
/** Interaction flags of the overview controller. */
let overviewActivity: CameraActivity = {};
/**
 * The next origin, or null: a rebase waits for an idle overview camera, and for float32 steps at
 * the target larger than MAX_STEP_PX. The globe camera is body-relative (longitude, latitude), so
 * its gestures do not stop a rebase in the globe mode.
 */
function originUpdate(): V3 | null {
  if (flightPhase || state.mode === 'compare') return null;
  const next = originTarget();
  const globe = state.mode === 'globe';
  const camera = globe ? cameraFromGlobe(state.body) : (state.camera ?? cameraOf(orbitViewport(), state.overviewView.target));
  // The nearest geometry: the surface of the globe body, or the overview target.
  const depth = globe ? norm(subV(camera.eye, scene.pos[state.body])) - scene.radius[state.body] : norm(subV(camera.eye, camera.target));
  const pixelSize = Math.max(depth, 0) / (focalOf(overviewFovy) * innerHeight);
  return shouldRebase(subV(next, origin), pixelSize, globe || isCameraIdle(overviewActivity)) ? next : null;
}
/** Clock time to body positions, then the rebase: the scene in the frame of the camera. */
function updateScene() {
  scene = computeScene();
  const next = originUpdate();
  if (!next) return;
  rebaseOrigin(next);
  scene = computeScene();
}

// ---------- Overview layers ----------

const SHADOW_EXTENSION = new ShadowExtension();
/** Extension props of a shadowed layer: the uniforms are left at "off" when shadows are off. */
function shadowProps(geometry: ShadowGeometry | null | undefined, kind: 'sphere' | 'rings' | 'lnglat', replace = false) {
  return {extensions: [SHADOW_EXTENSION], shadowUniforms: shadowUniforms(state.shadows ? geometry : null, kind, replace)};
}

function sphereGeometry(nLon = 72, nLat = 36) {
  const positions: number[] = [], normals: number[] = [], texCoords: number[] = [], indices: number[] = [];
  for (let j = 0; j <= nLat; j++) {
    const lat = Math.PI / 2 - (Math.PI * j) / nLat;
    for (let i = 0; i <= nLon; i++) {
      const lon = -Math.PI + (2 * Math.PI * i) / nLon;
      const p = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      positions.push(...p);
      normals.push(...p);
      texCoords.push(i / nLon, j / nLat);
    }
  }
  for (let j = 0; j < nLat; j++) {
    for (let i = 0; i < nLon; i++) {
      const a = j * (nLon + 1) + i, b = a + nLon + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return new Geometry({
    topology: 'triangle-list',
    attributes: {
      positions: {size: 3, value: new Float32Array(positions)},
      normals: {size: 3, value: new Float32Array(normals)},
      texCoords: {size: 2, value: new Float32Array(texCoords)}
    },
    indices: {size: 1, value: new Uint32Array(indices)}
  } as never);
}
const SPHERE = sphereGeometry();

function meshGeometry(positions: number[], normals: number[], texCoords: number[], indices: number[]) {
  return new Geometry({
    topology: 'triangle-list',
    attributes: {
      positions: {size: 3, value: new Float32Array(positions)},
      normals: {size: 3, value: new Float32Array(normals)},
      texCoords: {size: 2, value: new Float32Array(texCoords)}
    },
    indices: {size: 1, value: new Uint32Array(indices)}
  } as never);
}

/** Unit-sphere cap around +z, of angular radius `rhoDeg`. */
function capGeometry(rhoDeg: number, nTheta = 24, nPhi = 96) {
  const positions: number[] = [], texCoords: number[] = [], indices: number[] = [];
  const rho = (rhoDeg * Math.PI) / 180;
  for (let j = 0; j <= nTheta; j++) {
    const t = (rho * j) / nTheta;
    for (let i = 0; i <= nPhi; i++) {
      // i = nPhi repeats i = 0 exactly: rounding of 2 pi left a seam that blended twice.
      const p = (2 * Math.PI * (i % nPhi)) / nPhi;
      positions.push(Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t));
      texCoords.push(i / nPhi, j / nTheta);
    }
  }
  for (let j = 0; j < nTheta; j++) {
    for (let i = 0; i < nPhi; i++) {
      const a = j * (nPhi + 1) + i, b = a + nPhi + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return meshGeometry(positions, positions, texCoords, indices);
}
/** Night caps: nested, semi-transparent, so the terminator is soft. Angle from the anti-solar point. */
const toCaps = (spec: {rho: number; alpha: number}[]) => spec.map(({rho, alpha}) => ({rho, alpha, mesh: capGeometry(rho)}));
const EARTH_NIGHT = toCaps([{rho: 97, alpha: 40}, {rho: 94, alpha: 45}, {rho: 91, alpha: 50}, {rho: 88, alpha: 55}, {rho: 84, alpha: 60}, {rho: 78, alpha: 60}]);
// About 80% dark at most, so the map stays readable on the night side.
const MOON_NIGHT = toCaps([{rho: 91, alpha: 100}, {rho: 89.5, alpha: 100}, {rho: 88, alpha: 110}]);
/** Airless bodies get the sharp terminator. */
const NIGHT_PROFILE = (id: BodyId) => (id === 'moon' || id === 'mercury' ? MOON_NIGHT : EARTH_NIGHT);
const NIGHT_COLOR = [0, 2, 10] as const;
const TERMINATOR_COLOR: [number, number, number, number] = [255, 190, 80, 230];
/**
 * Alpha (0-255) of the stacked caps at a solar altitude, deg: the globe's night image uses it.
 * Each cap edge is a ramp over the spacing of the caps, not a step, so the globe shows no bands.
 */
function capAlphaAt(caps: {rho: number; alpha: number}[], altitudeDeg: number) {
  const theta = 90 + altitudeDeg;
  const ramp = caps === MOON_NIGHT ? 1.5 : 5;
  let clear = 1;
  for (const cap of caps) {
    const cover = Math.max(0, Math.min(1, (cap.rho - theta) / ramp + 0.5));
    clear *= 1 - (cover * cap.alpha) / 255;
  }
  return 255 * (1 - clear);
}

/** Flat annulus in the xy plane, radii in units of the body radius; u runs inner to outer. */
function annulusGeometry(inner: number, outer: number, n = 192) {
  const positions: number[] = [], normals: number[] = [], texCoords: number[] = [], indices: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (2 * Math.PI * i) / n;
    for (const [r, u] of [[inner, 0], [outer, 1]]) {
      positions.push(r * Math.cos(a), r * Math.sin(a), 0);
      normals.push(0, 0, 1);
      texCoords.push(u, i / n);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = 2 * i;
    indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  return meshGeometry(positions, normals, texCoords, indices);
}
const SATURN_KM = BODIES.saturn.radiusKm;
const RING_MESH = annulusGeometry(SATURN_RINGS.innerKm / SATURN_KM, SATURN_RINGS.outerKm / SATURN_KM);

// ---------- Sky (stars, Milky Way) ----------

/**
 * The sky (stars, Milky Way) is a sphere centred on the overview camera, of radius
 * SKY_DISTANCE x the camera-to-target distance: the stars turn with the camera but do not move
 * when the camera moves. It draws first, with no depth test or depth write, so every body draws
 * over it. Star positions are recomputed on the CPU on each view change (7000 points).
 * The sky draws nothing beyond about 10x the camera distance (between 2x and 20x: the far plane
 * is not where `far` says), so SKY_DISTANCE is 2. A second OrbitView for the sky and a
 * camera-centred model matrix failed the same way.
 */
const OVERVIEW_NEAR = 0.01;
const OVERVIEW_FAR = 100000;
/** Overview field of view, deg. The flights use the field of view of the globe. */
let overviewFovy = 50;
const SKY_DISTANCE = Number(params.get('skyDistance') ?? 2);
const STARS = getStarPoints(2000 + (state.baseDate.getTime() - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400000), 1);
function skyFrame(): {eye: V3; radius: number} {
  const eye = [...overviewViewport().cameraPosition] as V3;
  const target = state.camera ? state.camera.target : state.overviewView.target;
  return {eye, radius: SKY_DISTANCE * norm(subV(eye, target))};
}
let milkyWay: ImageBitmap | null = null;
let ringTexture: ImageBitmap | null = null;
getRingTexture().then(t => {
  ringTexture = t;
  if (state.mode !== 'compare') render();
});
setTimeout(() => {
  getMilkyWayTexture().then(t => {
    milkyWay = t;
    if (state.mode !== 'compare') render();
  });
}, 0);
getEarthCloudMap()
  .then(image => {
    cloudMap = image;
    if (state.mode !== 'compare' && !flightPhase) render();
  })
  .catch(error => textureErrors.push(`clouds: ${error}`));
const SKY_PARAMETERS = {depthWriteEnabled: false, depthCompare: 'always'} as const;

function skyLayers() {
  const {eye, radius} = skyFrame();
  const key = `${eye.join(',')}:${radius}`;
  // The look volumes dim or brighten the star field (stars < 1 dims, > 1 brightens).
  const stars = lookAt(eye).params.stars;
  return [
    ...(milkyWay
      ? [
          new SimpleMeshLayer({
            id: 'sky-milky-way',
            data: [0],
            mesh: SPHERE as never,
            texture: milkyWay,
            getPosition: () => eye,
            getColor: [255, 255, 255, 255],
            getTransformMatrix: () => new Matrix4().scale(radius * 1.05).toArray() as number[],
            material: {ambient: 1, diffuse: 0, shininess: 1, specularColor: [0, 0, 0]},
            opacity: Math.min(1, stars),
            parameters: SKY_PARAMETERS,
            updateTriggers: {getPosition: key, getTransformMatrix: key}
          })
        ]
      : []),
    new ScatterplotLayer<(typeof STARS)[number]>({
      id: 'sky-stars',
      data: STARS,
      getPosition: d => [eye[0] + radius * d.position[0], eye[1] + radius * d.position[1], eye[2] + radius * d.position[2]],
      getFillColor: d => d.color,
      getRadius: d => d.radius,
      radiusUnits: 'pixels',
      radiusScale: Math.sqrt(Math.max(0.05, stars)),
      opacity: Math.min(1, stars),
      billboard: true,
      antialiasing: true,
      parameters: SKY_PARAMETERS,
      updateTriggers: {getPosition: key}
    })
  ];
}

/**
 * Overview textures of each surface mode. 'imagery': the raster mosaics; 'vector': the vector
 * map drawn in plate carree (bodies/textures.ts). A body with no vector map, or one whose vector
 * texture is still loading, shows its imagery texture.
 */
const textures: Record<SurfaceMode, Partial<Record<BodyId, ImageBitmap>>> = {imagery: {}, vector: {}};
const texturesRequested = new Set<string>();
const textureErrors: string[] = [];
let texturesPending = 0;
let warmUpScheduled = false;
function loadOverviewTextures(surface: SurfaceMode) {
  for (const id of BODY_IDS) {
    const key = `${surface}:${id}`;
    if (texturesRequested.has(key)) continue;
    texturesRequested.add(key);
    texturesPending++;
    const load = surface === 'vector' ? getVectorTexture(id) : getEquirectTexture(BODIES[id]);
    load
      .then(image => {
        if (image) textures[surface][id] = image;
      })
      .catch(error => textureErrors.push(`${key}: ${error}`))
      .finally(() => {
        texturesPending--;
        if (state.mode !== 'compare' && !flightPhase) render();
        if (texturesPending === 0 && !warmUpScheduled) {
          warmUpScheduled = true;
          setTimeout(warmUp, 0);
        }
      });
  }
}
/** The overview texture of a body in the current surface mode, and its mode. */
function textureOf(id: BodyId): {image?: ImageBitmap; surface: SurfaceMode} {
  const image = textures[state.surface][id];
  return image ? {image, surface: state.surface} : {image: textures.imagery[id], surface: 'imagery'};
}
loadOverviewTextures('imagery');
if (state.surface === 'vector') loadOverviewTextures('vector');

/** The Sun lights of the two overview decks: they move with the floating origin. */
const sunLights: PointLight[] = [];
const makeLighting = () => {
  const sun = new PointLight({color: [255, 250, 240], intensity: 1.8, position: [0, 0, 0]});
  sunLights.push(sun);
  return new LightingEffect({ambient: new AmbientLight({color: [255, 255, 255], intensity: 1}), sun});
};
const lighting = makeLighting();
const frontLighting = makeLighting();
const SUN_MATERIAL = {ambient: 1, diffuse: 0, shininess: 1, specularColor: [0, 0, 0] as [number, number, number]};
/** Galilean moons only: lit by the Sun point light. */
const BODY_MATERIAL = {ambient: 0.1, diffuse: 0.95, shininess: 6, specularColor: [25, 25, 25] as [number, number, number]};
/**
 * Every body and the rings: unlit, so the overview shows the texture colour exactly as the
 * globe's tiles do; the night side comes from the night caps, which the globe repeats as cells.
 */
const UNLIT_MATERIAL = {ambient: 1, diffuse: 0, shininess: 1, specularColor: [0, 0, 0] as [number, number, number]};
/** Bodies left out of the overview (the body the camera looks from). */
const hidden = new Set<BodyId>();

/** What the overview draws: everything, only the focus body (behind the globe), or the rest (in front of it). */
type Part = {mode: 'all' | 'body' | 'rest'; focus?: BodyId; fade?: number; exclude?: ReadonlySet<BodyId>};

function overviewLayers(scene: Scene, part: Part = {mode: 'all'}) {
  const {mode, focus} = part;
  // Faded-out layers are left out: at near-zero opacity they still write depth.
  const fade = (part.fade ?? 1) < 0.01 ? 0 : part.fade ?? 1;
  const trigger = scene.date.getTime() + state.scale;
  const inPart = (id: BodyId) =>
    !hidden.has(id) && !part.exclude?.has(id) && (mode === 'all' || (mode === 'body') === (id === focus));
  const ids = BODY_IDS.filter(inPart);
  const meshLayers = ids.map(
    id =>
      new SimpleMeshLayer({
        id: textureOf(id).image ? `mesh-${id}-${textureOf(id).surface}` : `mesh-${id}`,
        data: [{id}],
        mesh: SPHERE as never,
        ...((textureOf(id).image ? {texture: textureOf(id).image} : {}) as object),
        getPosition: () => scene.pos[id],
        getColor: [...BODIES[id].color, 255] as [number, number, number, number],
        getTransformMatrix: () => scene.matrix[id],
        material: id === 'sun' ? SUN_MATERIAL : UNLIT_MATERIAL,
        pickable: true,
        ...(SHADOWED_BODIES.has(id) ? shadowProps(scene.shadows[id], 'sphere') : {}),
        updateTriggers: {getPosition: trigger, getTransformMatrix: trigger}
      } as never)
  );
  const capLayers = state.night ? nightLayers(scene, ids.filter(id => id !== 'sun')) : [];
  const terminator = ids.includes('earth') ? [overviewTerminatorLayer(scene)] : [];
  if (mode === 'body') return [...meshLayers, ...capLayers, ...terminator];

  // In front of the globe: the focus body only writes depth (alpha 0), so what is behind it hides.
  const occluder =
    mode === 'rest' && focus
      ? [
          new SimpleMeshLayer({
            id: `occluder-${focus}`,
            data: [0],
            mesh: SPHERE as never,
            getPosition: () => scene.pos[focus],
            getColor: [0, 0, 0, 0],
            getTransformMatrix: () => scene.matrix[focus],
            material: UNLIT_MATERIAL,
            updateTriggers: {getPosition: trigger, getTransformMatrix: trigger}
          })
        ]
      : [];
  const galileanLayers = [
    ...(fade > 0
      ? [
          new PathLayer<V3[]>({
            id: 'galilean-orbits',
            data: scene.galileanOrbits,
            getPath: d => d,
            getColor: [205, 170, 130, 90],
            getWidth: 1,
            widthUnits: 'pixels',
            opacity: fade,
            updateTriggers: {getPath: trigger}
          })
        ]
      : []),
    new SimpleMeshLayer({
      id: 'galilean',
      data: scene.galilean,
      mesh: SPHERE as never,
      getPosition: (d: Scene['galilean'][number]) => d.position,
      getColor: [215, 205, 180, 255],
      getTransformMatrix: (d: Scene['galilean'][number]) => new Matrix4().scale(d.radius).toArray() as number[],
      material: BODY_MATERIAL,
      updateTriggers: {getPosition: trigger, getTransformMatrix: trigger}
    }),
    new TextLayer<Scene['galilean'][number]>({
      id: 'galilean-labels',
      data: scene.galilean,
      getPosition: d => d.position,
      getText: d => d.label,
      getPixelOffset: [0, 11],
      getSize: 11,
      getColor: [220, 210, 190],
      ...LABEL_FONT,
      billboard: true,
      updateTriggers: {getPosition: trigger}
    })
  ];
  const ringLayers =
    ringTexture && !hidden.has('saturn')
      ? [
          new SimpleMeshLayer({
            id: 'saturn-rings',
            data: [0],
            mesh: RING_MESH as never,
            texture: ringTexture,
            getPosition: () => scene.pos.saturn,
            getColor: [255, 255, 255, 255],
            getTransformMatrix: () => axesMatrix(scene.saturnAxes, scene.radius.saturn),
            material: UNLIT_MATERIAL,
            parameters: {depthWriteEnabled: false},
            ...shadowProps(scene.ringShadow, 'rings'),
            updateTriggers: {getPosition: trigger, getTransformMatrix: trigger}
          } as never)
        ]
      : [];
  const labelLayer = (layerId: string, data: BodyId[], opacity: number) =>
    new TextLayer<BodyId>({
      id: layerId,
      data,
      getPosition: id => scene.pos[id],
      getText: id => BODIES[id].label,
      getPixelOffset: id => [0, id === 'moon' ? 14 : -16],
      getSize: 13,
      getColor: [235, 240, 255],
      ...LABEL_FONT,
      billboard: true,
      pickable: true,
      opacity,
      updateTriggers: {getPosition: trigger}
    });
  const labelIds = ids.filter(id => id !== focus);
  const cometLayers = state.space.comet && fade > 0
    ? [
        new PathLayer<V3[]>({
          id: 'comet-orbit',
          data: [scene.comet.orbit],
          getPath: d => d,
          getColor: [150, 200, 220, 70],
          getWidth: 1,
          widthUnits: 'pixels',
          opacity: fade,
          updateTriggers: {getPath: trigger}
        }),
        new TextLayer<V3>({
          id: 'comet-label',
          data: [scene.comet.position],
          getPosition: d => d,
          getText: () => `${NEOWISE.name}, ${scene.comet.r.toFixed(2)} AU`,
          // Every printable ASCII character: the label text changes with the clock.
          characterSet: Array.from({length: 95}, (_, k) => String.fromCharCode(32 + k)),
          getPixelOffset: [0, 14],
          getSize: 11,
          getColor: [190, 225, 240],
          ...LABEL_FONT,
          billboard: true,
          opacity: fade,
          updateTriggers: {getPosition: trigger, getText: trigger}
        })
      ]
    : [];
  return [
    ...cometLayers,
    ...(fade > 0
      ? [
          new PathLayer<{id: BodyId; path: V3[]}>({
            id: 'orbits',
            data: scene.orbits,
            getPath: d => d.path,
            getColor: d => [...BODIES[d.id].color.map(c => c * 0.6), 150] as [number, number, number, number],
            getWidth: 1.2,
            widthUnits: 'pixels',
            opacity: fade,
            updateTriggers: {getPath: trigger}
          })
        ]
      : []),
    ...occluder,
    ...meshLayers,
    ...capLayers,
    ...terminator,
    ...atmosphereLayers(scene, mode === 'rest' && focus ? [focus, ...ids] : ids),
    ...ringLayers,
    ...galileanLayers,
    labelLayer('labels', labelIds, 1),
    ...(focus && ids.includes(focus) && fade > 0 ? [labelLayer('label-focus', [focus], fade)] : [])
  ];
}

/** Night caps of bodies, around their anti-solar directions: one instanced layer per cap level. */
function nightLayers(scene: Scene, ids: BodyId[]) {
  const trigger = scene.date.getTime() + state.scale;
  const key = ids.join(',');
  return [EARTH_NIGHT, MOON_NIGHT].flatMap((profile, n) => {
    const members = ids.filter(id => NIGHT_PROFILE(id) === profile);
    if (!members.length) return [];
    return profile.map(
      ({mesh, alpha}, k) =>
        new SimpleMeshLayer<BodyId>({
          id: `night-${n}-${k}`,
          data: members,
          mesh: mesh as never,
          getPosition: id => scene.pos[id],
          getColor: [...NIGHT_COLOR, alpha] as [number, number, number, number],
          getTransformMatrix: id => axesMatrix(basisFromZ(scene.night[id]), scene.radius[id] * 1.004),
          material: SUN_MATERIAL,
          parameters: {depthWriteEnabled: false},
          updateTriggers: {getPosition: trigger + key, getTransformMatrix: trigger + key}
        })
    );
  });
}

/**
 * Atmospheres (Earth, Mars, Venus) and the Earth's clouds: one ray-marched layer per body, after
 * the bodies, so that a body in front hides it and one behind shows through it.
 */
let cloudMap: ImageBitmap | null = null;
function atmosphereLayers(scene: Scene, ids: BodyId[]) {
  if (!state.clouds && !state.atmosphere) return [];
  const steps = state.cloudSteps;
  return ATMOSPHERE_IDS.filter(id => ids.includes(id)).map(id => {
    const m = scene.matrix[id];
    const r = scene.radius[id];
    const axes = [unit([m[0], m[1], m[2]]), unit([m[4], m[5], m[6]]), unit([m[8], m[9], m[10]])] as [V3, V3, V3];
    const earth = id === 'earth';
    const km = (value: number) => 1 + value / PHYSICAL_CONSTANTS[id].radiusKm;
    return new AtmosphereLayer({
      id: `atmosphere-${id}`,
      atmosphere: getAtmosphere(id) as NonNullable<ReturnType<typeof getAtmosphere>>,
      center: scene.pos[id],
      radius: r,
      axes,
      sunDirection: scaleV(scene.night[id], -1),
      atmosphereEnabled: state.atmosphere,
      cloudBase: earth ? km(EARTH_CLOUD_BASE_KM) : 0,
      cloudTop: earth ? km(EARTH_CLOUD_TOP_KM) : 0,
      cloudImage: earth ? cloudMap : null,
      cloudSteps: earth && state.clouds ? steps : 0,
      lightSteps: steps >= 24 ? 4 : steps >= 12 ? 3 : 2,
      atmosphereSteps: steps >= 24 ? 12 : steps >= 12 ? 8 : 6,
      deckOpacity: state.clouds ? VENUS_DECK_OPACITY : 0
    });
  });
}
/**
 * Venus's cloud deck is opaque. It draws at 0.8 so that the vector map under it stays readable:
 * a choice for the example, not physics.
 */
const VENUS_DECK_OPACITY = 0.8;

/** math.gl's terminator line on the overview Earth, as the globe draws it. */
function overviewTerminatorLayer(scene: Scene) {
  const lines = getTerminator(scene.date).lines.map(line =>
    line.map(([lon, lat]) => {
      const a = (lon * Math.PI) / 180, b = (lat * Math.PI) / 180;
      const p = rotate4(scene.matrix.earth, [Math.cos(b) * Math.cos(a), Math.cos(b) * Math.sin(a), Math.sin(b)]);
      return addV(scene.pos.earth, scaleV(p, 1.002)) as V3;
    })
  );
  return new PathLayer<V3[]>({
    id: 'earth-overview-terminator',
    data: lines,
    getPath: d => d,
    getColor: TERMINATOR_COLOR,
    getWidth: 1.5,
    widthUnits: 'pixels',
    parameters: {depthWriteEnabled: false},
    updateTriggers: {getPath: scene.date.getTime() + state.scale}
  });
}

// ---------- Globe layers ----------

function basemapFor(id: BodyId, style: BasemapStyle) {
  return new BasemapLayer({
    id: `${id}-basemap`,
    style,
    loadOptions: {fetch: shimFetch},
    mode: 'globe',
    globe: {config: {atmosphere: false, basemap: true, labels: true}}
  });
}
/**
 * A new basemap layer of a body. Each mount gets a new instance: deck.gl cannot add a layer
 * instance again once a Deck has removed it.
 */
async function loadBasemap(id: BodyId, mode: SurfaceMode) {
  try {
    return basemapFor(id, await getBodyStyle(id, mode));
  } catch (error) {
    textureErrors.push(`${id} style: ${error}`);
    return basemapFor(id, await getBodyStyle(id, 'imagery').catch(() => EARTH_STYLE_URL as unknown as BasemapStyle));
  }
}
/** Compare mode's basemaps, made when compare mode opens. */
let compareBasemaps: Partial<Record<BodyId, BasemapLayer>> = {};

/**
 * Subdivisions of the globe per revolution. deck.gl 10 sets 0 by default: then each raster tile
 * draws as one flat quad and each polygon as flat triangles, so the limb is a polygon. 90 gives
 * 4° steps, under 0.25 px of sag at whole-globe zoom.
 */
const GLOBE_RESOLUTION = Number(params.get('resolution') ?? 90);

/**
 * Night side of a body on the GlobeView: one equirectangular image (0.5 deg pixels, linear
 * filtering). Each pixel has the alpha that the overview's stacked night caps have
 * there, from the body-fixed sub-solar direction of the same scene. Earth also gets math.gl's
 * terminator line.
 */
const NIGHT_W = 720;
const NIGHT_H = 360;
function nightImage(sunFixed: V3, caps: {rho: number; alpha: number}[]) {
  const canvas = document.createElement('canvas');
  canvas.width = NIGHT_W;
  canvas.height = NIGHT_H;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  const image = context.createImageData(NIGHT_W, NIGHT_H);
  const alphaAt = (lat: number, lon: number) => {
    const sinAlt =
      Math.cos(lat) * Math.cos(lon) * sunFixed[0] + Math.cos(lat) * Math.sin(lon) * sunFixed[1] + Math.sin(lat) * sunFixed[2];
    return capAlphaAt(caps, Math.asin(Math.max(-1, Math.min(1, sinAlt))) / DEG);
  };
  for (let y = 0; y < NIGHT_H; y++) {
    const lat = (90 - ((y + 0.5) * 180) / NIGHT_H) * DEG;
    for (let x = 0; x < NIGHT_W; x++) {
      const lon = (-180 + ((x + 0.5) * 360) / NIGHT_W) * DEG;
      const i = (y * NIGHT_W + x) * 4;
      image.data[i] = NIGHT_COLOR[0];
      image.data[i + 1] = NIGHT_COLOR[1];
      image.data[i + 2] = NIGHT_COLOR[2];
      image.data[i + 3] = alphaAt(lat, lon);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}
/**
 * Night images by body and sub-solar point (to 0.1 deg), least recently used first. Layer
 * instances are not cached: deck.gl cannot add a layer instance again once a Deck has removed it.
 */
const nightCache = new Map<string, HTMLCanvasElement>();
const NIGHT_CACHE_SIZE = 12;
function bodyNightImage(id: BodyId) {
  const sunFixed = unit(toFixed(id, scaleV(scene.night[id], -1)));
  const key = `${id}:${sunFixed.map(v => Math.round(v * 600)).join(',')}`;
  let image = nightCache.get(key);
  if (image) {
    nightCache.delete(key);
  } else {
    image = nightImage(sunFixed, NIGHT_PROFILE(id));
  }
  nightCache.set(key, image);
  while (nightCache.size > NIGHT_CACHE_SIZE) nightCache.delete(nightCache.keys().next().value as string);
  return image;
}
function bodyNightLayers(id: BodyId) {
  if (id === 'sun' || !state.night) return [];
  const layers: unknown[] = [
    new BitmapLayer({
      id: `${id}-night`,
      image: bodyNightImage(id),
      bounds: [-180, -90, 180, 90],
      textureParameters: {minFilter: 'linear', magFilter: 'linear'},
      // The image lies on the tile surface: a depth bias toward the camera stops z-fighting at
      // grazing angles near the limb.
      parameters: {depthWriteEnabled: false, depthBias: -2000, depthBiasSlopeScale: -4}
    } as never)
  ];
  if (id === 'earth') {
    const lines = getTerminator(scene.date).lines.map(line => line.map(([lon, lat]) => [lon, lat, 2500] as V3));
    layers.push(
      new PathLayer<V3[]>({
        id: 'earth-terminator',
        data: lines,
        getPath: d => d,
        getColor: TERMINATOR_COLOR,
        getWidth: 1.5,
        widthUnits: 'pixels',
        parameters: {depthWriteEnabled: false}
      })
    );
  }
  return layers;
}

/** A white pixel: the shadow overlay's colour comes from its shader. */
const WHITE = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 1, 1);
  return canvas;
})();
/**
 * Eclipse shadows on a GlobeView: one BitmapLayer over the whole body whose fragment shader
 * computes the light at its longitude and latitude, drawn with a multiply blend, so it darkens
 * the BasemapLayer tiles under it. (The tiles are BasemapLayer sublayers; an overlay needs no
 * shader injection into them.) Left out while no shadow can reach the body.
 */
function bodyShadowLayers(id: BodyId) {
  const geometry = scene.shadows[id];
  if (!state.shadows || !geometry || (!geometry.occluders.length && !geometry.ring)) return [];
  return [
    new BitmapLayer({
      id: `${id}-shadow`,
      image: WHITE,
      bounds: [-180, -90, 180, 90],
      ...shadowProps(geometry, 'lnglat', true),
      parameters: {...MULTIPLY_PARAMETERS, depthWriteEnabled: false, depthBias: -2000, depthBiasSlopeScale: -4}
    } as never)
  ];
}

/** Compare mode only (deck.gl's default camera). */
function defaultGlobeView(single: boolean, id?: BodyId) {
  const w = single ? innerWidth : innerWidth / 3;
  // GlobeView: at zoom 0 the globe is 512 px around, about 163 px across.
  const h = single ? innerHeight : innerHeight - COMPARE_TOP - COMPARE_BOTTOM;
  // Saturn: fit the rings (outer edge 2.27 radii) instead of the planet.
  const fit = id === 'saturn' ? SATURN_RINGS.outerKm / SATURN_KM + 0.05 : 1;
  const zoom = Math.log2((Math.min(w, h) * 0.85) / 163 / fit);
  return {longitude: 0, latitude: id === 'saturn' ? 20 : 15, zoom, minZoom: zoom - 1.5, maxZoom: 14.7};
}

// ---------- Cameras ----------

/**
 * Three decks, stacked:
 * - `deck` (#map, back): the overview, or in globe mode the sky and the focus body (the sphere
 *   shows where the globe has no tiles), from the camera of the globe.
 * - `globeDeck` (#globe, middle): GlobeView + BasemapLayer, transparent around the globe.
 * - `frontDeck` (#front, top, no pointer events): in globe mode the rest of the system, with the
 *   focus body as a depth-only occluder, so the rings and moons in front of the globe draw over it
 *   and the ones behind it do not.
 * One Deck cannot do this: a view has one projection, and a GlobeView and an OrbitView over the
 * same pixels cannot depth-test against each other. Separate canvases also give the cross-fade
 * for free (CSS opacity of #globe), and the hidden globe deck loads its tiles during the fly-in.
 */
type Camera = {eye: V3; target: V3; up: V3};
const subV = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const crossV = (a: readonly number[], b: readonly number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const DEG = Math.PI / 180;
/** Camera distance in viewport heights for a field of view (math.gl fovyToAltitude). */
const focalOf = (fovy: number) => 0.5 / Math.tan((fovy * DEG) / 2);
const GLOBE_FOVY = 50;

/** A camera at `eye` looking at `target`, scaled as OrbitView scales (one unit at the target = 2^zoom px). */
class CameraViewport extends Viewport {
  constructor(opts: Record<string, unknown>) {
    const {eye, target, up, fovy = 50, height = 1} = opts as Camera & {fovy?: number; height?: number};
    const focal = focalOf(fovy);
    const offset = subV(eye, target);
    const k = focal / norm(offset);
    const viewMatrix = new Matrix4().lookAt({eye: scaleV(offset, k), center: [0, 0, 0], up}).scale(k);
    super({...opts, viewMatrix, fovy, focalDistance: focal, position: target, zoom: Math.log2(k * height)} as never);
  }
}
class CameraView extends OrbitView {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getViewportType(): any {
    return CameraViewport;
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyViewport = any;
const overviewViewProps = () => ({id: 'overview', near: OVERVIEW_NEAR, far: OVERVIEW_FAR, fovy: overviewFovy});
/** Wheel zoom eases over a few frames instead of a step per wheel event. */
const CONTROLLER = {scrollZoom: {smooth: true}};
let orbitView = new OrbitView({...overviewViewProps(), controller: CONTROLLER});
let cameraView = new CameraView({...overviewViewProps(), controller: false});
function setOverviewFovy(fovy: number) {
  if (fovy === overviewFovy) return;
  overviewFovy = fovy;
  orbitView = new OrbitView({...overviewViewProps(), controller: CONTROLLER});
  cameraView = new CameraView({...overviewViewProps(), controller: false});
}
const globeView = new GlobeView({id: 'globe', controller: CONTROLLER, resolution: GLOBE_RESOLUTION, fovy: GLOBE_FOVY} as never);
const size = () => ({width: innerWidth, height: innerHeight});
const orbitViewport = (viewState: object = state.overviewView): AnyViewport => orbitView.makeViewport({...size(), viewState} as never);
const cameraViewport = (camera: Camera): AnyViewport => cameraView.makeViewport({...size(), viewState: camera} as never);
const globeViewport = (viewState: object = state.globeViews.globe): AnyViewport => globeView.makeViewport({...size(), viewState} as never);
function overviewViewport(): AnyViewport {
  return state.camera ? cameraViewport(state.camera) : orbitViewport();
}
/** Up and back (toward the camera) unit vectors of a viewport, in its common space. */
function viewAxes(viewport: AnyViewport): {up: V3; back: V3} {
  const m = viewport.viewMatrixInverse as number[];
  return {up: unit([m[4], m[5], m[6]]), back: unit([m[8], m[9], m[10]])};
}
function cameraOf(viewport: AnyViewport, target: V3): Camera {
  return {eye: [...viewport.cameraPosition] as V3, target, up: viewAxes(viewport).up};
}

/** Body axes (x = prime meridian, y = 90 E, z = north) in the overview frame. */
function bodyAxes(id: BodyId): [V3, V3, V3] {
  const m = scene.matrix[id];
  const r = scene.radius[id];
  return [unit([m[0] / r, m[1] / r, m[2] / r]), unit([m[4] / r, m[5] / r, m[6] / r]), unit([m[8] / r, m[9] / r, m[10] / r])];
}
const toFixed = (id: BodyId, w: readonly number[]): V3 => {
  const [x, y, z] = bodyAxes(id);
  return [dot(w, x), dot(w, y), dot(w, z)];
};
const fromFixed = (id: BodyId, f: readonly number[]): V3 => {
  const [x, y, z] = bodyAxes(id);
  return [0, 1, 2].map(i => x[i] * f[0] + y[i] * f[1] + z[i] * f[2]) as V3;
};
const lonLatOf = (f: readonly number[]) => ({lon: Math.atan2(f[1], f[0]) / DEG, lat: Math.asin(Math.max(-1, Math.min(1, f[2] / Math.hypot(f[0], f[1], f[2])))) / DEG});
const fixedOf = (lon: number, lat: number): V3 => [Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)];

/** GlobeView common space to body-fixed unit vectors: the globe is a sphere at the origin. */
function globeFrame(viewport: AnyViewport) {
  const e0 = viewport.projectPosition([0, 0, 0]) as V3;
  const r = norm(e0);
  const ex = unit(e0), ey = unit(viewport.projectPosition([90, 0, 0])), ez = unit(viewport.projectPosition([0, 90, 0]));
  return {radius: r, toFixed: (c: readonly number[]): V3 => [dot(c, ex), dot(c, ey), dot(c, ez)]};
}
/** deck.gl's latitude zoom adjustment of the GlobeView scale (zoomAdjust, not exported). */
const zoomAdjustAt = (lat: number) => -Math.log2(globeViewport({longitude: 0, latitude: lat, zoom: 0}).scale);
/** Globe radius, viewport heights, at which its limb is `px` from the centre (fovy GLOBE_FOVY). */
function globeRadiusForLimb(px: number) {
  const a = focalOf(GLOBE_FOVY);
  const rho = px / innerHeight;
  return (rho * rho + rho * Math.sqrt(rho * rho + a * a)) / a;
}
/** Hand-off limb radius, px: 0.425 x the short side, or the rings for Saturn. */
function handoffLimbPx(id: BodyId) {
  const fit = id === 'saturn' ? SATURN_RINGS.outerKm / SATURN_KM + 0.05 : 1;
  return (0.425 * Math.min(innerWidth, innerHeight)) / fit;
}
/**
 * Overview zoom (body at the target) at which the body looks exactly as the globe does: the
 * same field of view and the same camera distance in body radii. The globe camera is `a` viewport
 * heights above the surface (a = focalOf(fovy)), so for globe radius R the distance is (a + R) / R
 * radii; the OrbitView camera is `a` from the target, so its radius must be a R / (a + R).
 */
function handoffOverviewZoom(id: BodyId) {
  const a = focalOf(overviewFovy);
  const rGlobe = globeRadiusForLimb(handoffLimbPx(id));
  return Math.log2((innerHeight * ((a * rGlobe) / (a + rGlobe))) / scene.radius[id]);
}

/**
 * Zoom range of the globe of a body: out to 0.35 x the hand-off size, in to two levels past its
 * most detailed tiles. A GlobeView loads tiles about 1.3 levels above its view zoom.
 */
const DETAIL_TILE_ZOOM: Partial<Record<BodyId, number>> = {earth: 16, moon: 11, mars: 10, mercury: 8};
/** The planetary vector data is simplified to about 0.02-0.06 deg: no detail past this tile zoom. */
const VECTOR_TILE_ZOOM = 8;
function globeZoomLimits(id: BodyId) {
  const handoff = Math.log2((globeRadiusForLimb(handoffLimbPx(id)) * innerHeight) / 256) + zoomAdjustAt(0);
  const tileZoom =
    state.surface === 'vector' && id !== 'earth' && BODIES[id].vector ? VECTOR_TILE_ZOOM : DETAIL_TILE_ZOOM[id];
  return {minZoom: handoff - 1.5, maxZoom: tileZoom === undefined ? handoff + 3 : tileZoom - 1.3};
}

/** The GlobeView state that shows what an overview viewport (looking at the body centre) shows. */
function globeStateFromOverview(id: BodyId, viewport: AnyViewport) {
  const offset = subV(viewport.cameraPosition, scene.pos[id]);
  const distance = norm(offset) / scene.radius[id];
  const {lon, lat} = lonLatOf(toFixed(id, offset));
  const up = toFixed(id, viewAxes(viewport).up);
  const north = [-Math.sin(lat * DEG) * Math.cos(lon * DEG), -Math.sin(lat * DEG) * Math.sin(lon * DEG), Math.cos(lat * DEG)];
  const east = [-Math.sin(lon * DEG), Math.cos(lon * DEG), 0];
  const bearing = Math.atan2(dot(up, east), dot(up, north)) / DEG;
  const rGlobe = focalOf(GLOBE_FOVY) / (distance - 1);
  return {
    longitude: lon,
    latitude: lat,
    zoom: Math.log2((rGlobe * innerHeight) / 256) + zoomAdjustAt(lat),
    bearing,
    pitch: 0,
    ...globeZoomLimits(id)
  };
}
/** The overview camera that sees what the globe camera sees (any bearing and pitch). */
function cameraFromGlobe(id: BodyId, viewport: AnyViewport = globeViewport()): Camera {
  const frame = globeFrame(viewport);
  const {up, back} = viewAxes(viewport);
  const s = scene.radius[id] / frame.radius;
  const eye = addV(scene.pos[id], scaleV(fromFixed(id, frame.toFixed(viewport.cameraPosition)), s));
  const forward = scaleV(fromFixed(id, frame.toFixed(back)), -1);
  const distance = norm(subV(eye, scene.pos[id]));
  return {eye, target: addV(eye, scaleV(forward, distance)), up: fromFixed(id, frame.toFixed(up))};
}

/**
 * The globe view in space: its target direction and heading, in the overview frame. The Carbon
 * engine advances the world on a tick and moves the camera with the reference point; the camera
 * keeps its orientation. Here the globe camera follows the body centre but not its spin, so at
 * 1 day/s the stars stay still and the surface turns under the camera.
 */
function globeInertial(id: BodyId) {
  const {longitude: lon, latitude: lat, bearing = 0} = state.globeViews.globe;
  const north: V3 = [-Math.sin(lat * DEG) * Math.cos(lon * DEG), -Math.sin(lat * DEG) * Math.sin(lon * DEG), Math.cos(lat * DEG)];
  const east: V3 = [-Math.sin(lon * DEG), Math.cos(lon * DEG), 0];
  const b = bearing * DEG;
  const heading = addV(scaleV(north, Math.cos(b)), scaleV(east, Math.sin(b)));
  return {target: fromFixed(id, fixedOf(lon, lat)), heading: fromFixed(id, heading)};
}
function applyGlobeInertial(id: BodyId, inertial: ReturnType<typeof globeInertial>) {
  const {lon, lat} = lonLatOf(toFixed(id, inertial.target));
  const h = toFixed(id, inertial.heading);
  const north = [-Math.sin(lat * DEG) * Math.cos(lon * DEG), -Math.sin(lat * DEG) * Math.sin(lon * DEG), Math.cos(lat * DEG)];
  const east = [-Math.sin(lon * DEG), Math.cos(lon * DEG), 0];
  const bearing = Math.atan2(dot(h, east), dot(h, north)) / DEG;
  state.globeViews.globe = {...state.globeViews.globe, longitude: lon, latitude: lat, bearing};
  globeDeck.setProps({viewState: {globe: state.globeViews.globe}});
}

// ---------- Decks ----------

const errors = new Set<string>();
const onError = (error: unknown) => {
  console.error(error);
  errors.add(String(error));
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const deck: any = new Deck({
  parent: document.getElementById('map') as HTMLDivElement,
  views: [orbitView],
  viewState: {overview: state.overviewView},
  layers: [],
  getCursor: ({isHovering, isDragging}: {isHovering: boolean; isDragging: boolean}) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
  onInteractionStateChange: (activity: CameraActivity) => {
    overviewActivity = {...activity};
    // Paused, nothing else renders: rebase on the next frame after the gesture.
    if (isCameraIdle(activity) && !state.playing) {
      requestAnimationFrame(() => {
        if (!state.playing && isCameraIdle(overviewActivity) && originUpdate()) render();
      });
    }
  },
  onViewStateChange: ({viewState}: {viewId: string; viewState: Record<string, unknown>}) => {
    if (state.mode === 'overview') {
      if (state.camera) return;
      state.overviewView = {...state.overviewView, ...(viewState as typeof state.overviewView)};
    } else if (state.mode === 'compare' && state.linked) {
      const {longitude, latitude, zoom} = viewState as {longitude: number; latitude: number; zoom: number};
      for (const id of COMPARE_IDS) state.globeViews[id] = {...state.globeViews[id], longitude, latitude, zoom};
    } else if (state.mode === 'compare') {
      return;
    }
    renderViewState();
  },
  onClick: (info: {object?: unknown; coordinate?: number[]; viewport?: {id: string}}) => {
    if (state.mode === 'overview') {
      const object = info.object as {id?: BodyId} | BodyId | undefined;
      const id = typeof object === 'string' ? object : object?.id;
      if (id) flyTo(id);
    } else if (state.mode === 'compare' && info.coordinate) {
      state.clicked = {body: (info.viewport?.id ?? 'earth') as BodyId, lon: info.coordinate[0], lat: info.coordinate[1]};
      renderPanel();
    }
  },
  layerFilter: ({layer, viewport}: {layer: {id: string}; viewport: {id: string}}) =>
    state.mode !== 'compare' || layer.id.startsWith(`${viewport.id}-`),
  onAfterRender: () => drawSpace(),
  onError
} as never);

const globeDiv = document.getElementById('globe') as HTMLDivElement;
const frontDiv = document.getElementById('front') as HTMLDivElement;
let globeFrames = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globeDeck: any = new Deck({
  parent: globeDiv as HTMLDivElement,
  views: [globeView],
  viewState: {globe: {longitude: 0, latitude: 0, zoom: 0}},
  layers: [],
  onViewStateChange: ({viewState}: {viewState: Record<string, number>}) => {
    if (state.mode !== 'globe' || flightPhase) return;
    state.globeViews.globe = {...state.globeViews.globe, ...viewState};
    renderViewState();
  },
  onClick: (info: {coordinate?: number[]}) => {
    if (state.mode === 'globe' && info.coordinate) {
      state.clicked = {body: state.body, lon: info.coordinate[0], lat: info.coordinate[1]};
      renderPanel();
    }
  },
  onAfterRender: () => {
    globeFrames++;
  },
  onError
} as never);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const frontDeck: any = new Deck({
  parent: frontDiv as HTMLDivElement,
  views: [cameraView],
  viewState: {overview: {eye: [0, -1, 0], target: [0, 0, 0], up: [0, 0, 1]}},
  layers: [],
  controller: false,
  onError
} as never);

let scene = computeScene();

// ---------- Space volumes ----------

const stageDiv = document.getElementById('stage') as HTMLDivElement;
const lookMatrix = document.getElementById('look-matrix') as unknown as SVGFEColorMatrixElement;
const volumesCanvas = document.getElementById('volumes') as HTMLCanvasElement;
let space: SpaceVolumes | null = null;
try {
  space = createSpaceVolumes(volumesCanvas);
} catch (error) {
  textureErrors.push(String(error));
}
/** The baked cloud density (scene/data/bake-cloud.mjs), 96^3 R8. */
const CLOUD_SIZE = 96;
fetch(new URL('./data/cloud-96.r8', import.meta.url))
  .then(response => response.arrayBuffer())
  .then(buffer => {
    space?.setCloudVolume({size: CLOUD_SIZE, data: new Uint8Array(buffer)});
    cloudLoaded = true;
    if (state.mode !== 'compare') deck.redraw('cloud');
  })
  .catch(error => textureErrors.push(`cloud volume: ${error}`));
let cloudLoaded = false;

function spaceScene(): SpaceScene {
  return {
    date: scene.date,
    pos: scene.pos,
    radius: scene.radius,
    matrix: scene.matrix,
    scale: state.scale,
    toScene: p => subV(place(p), origin),
    origin,
    colors: Object.fromEntries(BODY_IDS.map(id => [id, BODIES[id].color])) as unknown as Record<BodyId, readonly number[]>
  };
}
let lookCache: {scene: Scene; volumes: ReturnType<typeof lookVolumes>} | null = null;
/** The blended look at a camera position (relative to the floating origin). */
function lookAt(eye: readonly number[]): LookBlend {
  if (!state.space.looks || state.mode === 'compare') return {params: {...DEFAULT_LOOK}, weights: []};
  if (lookCache?.scene !== scene) lookCache = {scene, volumes: lookVolumes(spaceScene())};
  return blendLook(lookCache.volumes, eye);
}
/** Last frame of the space volumes, for the panel and automated checks. */
const spaceStats = {drawMs: 0, look: null as LookBlend | null, frames: 0};
let spaceCleared = false;
function drawSpace() {
  if (!space) return;
  const t = state.space;
  const anything = t.looks || t.corona || t.comet || t.gas || t.dust;
  if (state.mode === 'compare' || !anything) {
    if (!spaceCleared) {
      space.clear();
      stageDiv.style.filter = '';
      spaceCleared = true;
    }
    return;
  }
  spaceCleared = false;
  const viewport: AnyViewport = deck.getViewports()[0] ?? overviewViewport();
  const eye = [...viewport.cameraPosition] as V3;
  const target = state.camera?.target ?? state.overviewView.target;
  const look = lookAt(eye);
  const {params: p} = look;
  // Tint and exposure: one colour matrix (SVG feColorMatrix) over the decks and the volumes.
  const gains = p.tint.map(c => Math.max(0, c) * exposureGain(p.exposure));
  if (gains.some(g => Math.abs(g - 1) > 0.003)) {
    lookMatrix.setAttribute('values', `${gains[0].toFixed(4)} 0 0 0 0 0 ${gains[1].toFixed(4)} 0 0 0 0 0 ${gains[2].toFixed(4)} 0 0 0 0 0 1 0`);
    stageDiv.style.filter = 'url(#look-filter)';
  } else {
    stageDiv.style.filter = '';
  }
  const {frame, viewProjection} = volumeFrame(
    spaceScene(),
    {eye, distance: norm(subV(eye, target)), viewProjection: [...viewport.viewProjectionMatrix], width: innerWidth, height: innerHeight},
    t,
    {color: p.fogColor, density: p.fogDensity}
  );
  spaceStats.drawMs = space.draw(frame, viewProjection);
  spaceStats.look = look;
  spaceStats.frames++;
}

let overviewCache: unknown[] = [];
let bodyCache: unknown[] = [];
/** Opacity of the globe canvas (cross-fade), and whether the globe takes pointer events. */
let globeOpacity = 0;
/** 'in' or 'out' while a flight runs: the user cannot steer then. */
let flightPhase: '' | 'fly-in' | 'travel' | 'wait' | 'fade-in' | 'fade-out' | 'fly-out' = '';
/** Focus body and opacity of the orbits and the focus label during a flight. */
let flightFocus: BodyId | undefined;
let flightFade = 1;

function setDecks() {
  // Before the hand-off the globe and front decks draw (load tiles, compile shaders) but are not
  // composited: `visibility: hidden` keeps two full-screen canvases out of each fly-in frame.
  const shown = state.mode === 'globe';
  globeDiv.style.opacity = String(globeOpacity);
  globeDiv.style.visibility = shown && globeOpacity > 0 ? 'visible' : 'hidden';
  globeDiv.style.pointerEvents = shown && !flightPhase ? 'auto' : 'none';
  frontDiv.style.visibility = shown ? 'visible' : 'hidden';
  frontDiv.style.opacity = '1';
}

function renderViewState() {
  if (state.mode === 'compare') {
    deck.setProps({viewState: {...state.globeViews}});
    return;
  }
  if (state.mode === 'globe') {
    state.camera = cameraFromGlobe(state.body);
    globeDeck.setProps({viewState: {globe: state.globeViews.globe}});
    deck.setProps({viewState: {overview: state.camera}, layers: [...skyLayers(), ...bodyCache]});
    updateFrontLayers();
    frontDeck.setProps({viewState: {overview: state.camera}});
    return;
  }
  deck.setProps({viewState: {overview: state.camera ?? state.overviewView}, layers: [...skyLayers(), ...overviewCache]});
}

/**
 * The rest of the system in front of the globe. In readable scale a body nearer to the camera than
 * the centre of the focus body is left out: the Moon's neighbour Earth (or a planet next to its
 * moons) would otherwise fill the view from some sides of the globe. This is the geometry of the
 * readable scale, not depth precision: in true scale nothing is left out.
 */
let frontExcluded = '';
function updateFrontLayers(force = false) {
  const eye = (state.camera as Camera).eye;
  const focusDistance = norm(subV(eye, scene.pos[state.body]));
  const exclude = new Set(
    state.scale === 'true' ? [] : BODY_IDS.filter(id => id !== state.body && norm(subV(eye, scene.pos[id])) < focusDistance)
  );
  const key = [...exclude].join(',');
  if (!force && key === frontExcluded) return;
  frontExcluded = key;
  frontDeck.setProps({layers: overviewLayers(scene, {mode: 'rest', focus: state.body, fade: 0, exclude})});
}

/** Globe deck content for a body; `globeOpacity` sets whether it shows. */
async function mountGlobe(id: BodyId) {
  globeFrames = 0;
  globeMounted = '';
  const basemap = await loadBasemap(id, state.surface);
  globeBasemap = basemap;
  globeDeck.setProps({
    views: [globeView],
    viewState: {globe: state.globeViews.globe},
    layers: [basemap, ...bodyShadowLayers(id), ...bodyNightLayers(id)],
    // During the fly-in the globe deck updates its layers (selects and loads tiles) but does not
    // draw: each draw of the hidden globe would cost a fly-in frame. It draws from the wait on.
    _customRender: flightPhase === 'fly-in' || flightPhase === 'travel' ? () => {} : null
  });
  globeMounted = id;
  globeFrames = 0;
}
let globeMounted: BodyId | '' = '';
let globeBasemap: BasemapLayer | null = null;
/** New night layers on the mounted globe (after a time step), with the same basemap layer. */
function updateGlobeNight() {
  if (globeMounted && globeBasemap) {
    globeDeck.setProps({layers: [globeBasemap, ...bodyShadowLayers(globeMounted), ...bodyNightLayers(globeMounted)]});
  }
}
/** Empties the globe and front decks when the globe mode ends. */
function unmountGlobe() {
  globeMounted = '';
  globeBasemap = null;
  globeDeck.setProps({layers: []});
  frontDeck.setProps({layers: []});
}
/** All globe layers loaded, and drawn at least twice since (textures uploaded). */
function globeReady() {
  if (!globeMounted || globeMounted !== state.body) return false;
  const layers = globeDeck.layerManager?.getLayers() ?? [];
  return layers.length > 1 && layers.every((layer: {isLoaded: boolean}) => layer.isLoaded) && globeFrames >= 3;
}

function render() {
  setDecks();
  if (state.mode === 'overview') {
    updateScene();
    deck.setProps({
      views: [state.camera ? cameraView : orbitView],
      viewState: {overview: state.camera ?? state.overviewView},
      layers: [...skyLayers(), ...(overviewCache = overviewLayers(scene, {mode: 'all', focus: flightFocus, fade: flightFade}))],
      effects: [lighting]
    });
    renderViewState();
  } else if (state.mode === 'globe') {
    const inertial = state.corotate || !scene ? null : globeInertial(state.body);
    updateScene();
    if (inertial) applyGlobeInertial(state.body, inertial);
    bodyCache = overviewLayers(scene, {mode: 'body', focus: state.body});
    state.camera = cameraFromGlobe(state.body);
    const viewState = {overview: state.camera};
    deck.setProps({views: [cameraView], viewState, effects: [lighting]});
    frontDeck.setProps({views: [cameraView], viewState, effects: [frontLighting]});
    updateFrontLayers(true);
    if (!flightPhase) updateGlobeNight();
    renderViewState();
  } else {
    deck.setProps({
      views: COMPARE_IDS.map(
        (id, i) =>
          new GlobeView({id, resolution: GLOBE_RESOLUTION, x: `${(i * 100) / 3}%`, width: `${100 / 3}%`, y: COMPARE_TOP, height: innerHeight - COMPARE_TOP - COMPARE_BOTTOM, controller: CONTROLLER})
      ),
      viewState: {...state.globeViews},
      layers: [
        ...COMPARE_IDS.map(id => compareBasemaps[id] ?? null),
        ...COMPARE_IDS.flatMap(bodyShadowLayers),
        ...COMPARE_IDS.flatMap(bodyNightLayers)
      ],
      effects: []
    });

  }
  renderPanel();
}

function fitZoom(scale: 'readable' | 'true') {
  const extent = scale === 'true' ? (30.5 * KM_PER_AU) / TRUE_UNIT_KM : READABLE_DIST(30.5);
  return Math.log2((Math.min(innerWidth, innerHeight) * 0.48) / extent);
}

// ---------- Flights ----------

const clock = () => performance.now();
const FLY_MS = 1800;
const FADE_MS = 320;
/** Longest wait for the globe tiles after the fly-in, ms of real time; then the fade starts anyway. */
const READY_TIMEOUT_MS = 6000;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (t: number) => t * t * (3 - 2 * t);
function frameLoop(step: (now: number) => boolean) {
  const loop = () => {
    if (step(clock())) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

let flight = 0;
function flyTo(id: BodyId) {
  if (state.mode !== 'overview' || flightPhase || state.camera) return;
  const token = ++flight;
  setOverviewFovy(GLOBE_FOVY);
  hidden.clear();
  scene = computeScene();
  const from = {...state.overviewView};
  const to = {...from, target: scene.pos[id], zoom: handoffOverviewZoom(id), rotationX: 15};
  // The globe opens at the face, size and north direction of the last overview frame; it loads
  // its tiles behind the overview, invisible, during the fly-in.
  state.body = id;
  state.clicked = null;
  state.globeViews = {globe: globeStateFromOverview(id, orbitViewport(to))};
  globeOpacity = 0;
  flightPhase = 'fly-in';
  flightFocus = id;
  setDecks();
  frontDeck.setProps({
    views: [cameraView],
    viewState: {overview: cameraOf(orbitViewport(to), to.target)},
    layers: overviewLayers(scene, {mode: 'rest', focus: id, fade: 0}),
    effects: [frontLighting]
  });
  if (params.get('prefetch') !== 'off') mountGlobe(id);
  const start = clock();
  let mounted = params.get('prefetch') !== 'off';
  const handoff = makeHandoff(() => {
    if (!mounted) {
      mounted = true;
      mountGlobe(id);
    }
  });
  frameLoop(now => {
    if (token !== flight) return false;
    if (flightPhase === 'fly-in') {
      const t = Math.min(1, (now - start) / FLY_MS);
      const e = ease(t);
      // Fly the target in log space of the scale, so the view does not jump at the end.
      state.overviewView = {
        ...from,
        target: from.target.map((v, k) => v + (to.target[k] - v) * Math.min(1, e * 1.15)) as V3,
        zoom: from.zoom + (to.zoom - from.zoom) * e,
        rotationX: from.rotationX + (to.rotationX - from.rotationX) * e
      };
      flightFade = 1 - e;
      overviewCache = overviewLayers(scene, {mode: 'all', focus: id, fade: flightFade});
      if (t >= 1) {
        state.overviewView = to;
        flightPhase = 'wait';
        globeDeck.setProps({_customRender: null});
        globeFrames = 0;
      }
      renderViewState();
      return true;
    }
    return handoff(now);
  });
}

/**
 * The end of a flight to a body: wait (up to READY_TIMEOUT_MS) until the hidden globe has its
 * tiles, then switch the decks to globe mode at the same camera and fade the globe in.
 */
function makeHandoff(mountIfNeeded: () => void) {
  let readySince = 0;
  return (now: number): boolean => {
    if (flightPhase === 'wait') {
      if (!readySince) readySince = performance.now();
      mountIfNeeded();
      if (state.playing) {
        // The clock runs: the overview camera moves with the body, and the hidden globe keeps the
        // face that the overview shows (the body turns under the camera).
        scene = computeScene();
        state.overviewView = {...state.overviewView, target: scene.pos[state.body]};
        state.globeViews = {globe: globeStateFromOverview(state.body, orbitViewport(state.overviewView))};
        globeDeck.setProps({viewState: {globe: state.globeViews.globe}});
        overviewCache = overviewLayers(scene, {mode: 'all', focus: flightFocus, fade: flightFade});
        renderViewState();
      }
      // Draw the hidden globe (uploads tiles to textures) even when no tile arrives.
      if (globeFrames < 3) globeDeck.redraw('hand-off');
      const ready = globeReady();
      if (!ready && performance.now() - readySince < READY_TIMEOUT_MS) return true;
      // Hand-off: the decks change from the overview to globe + focus body + rest, at the same camera.
      flightPhase = 'fade-in';
      state.mode = 'globe';
      fadeStart = now;
      render();
      return true;
    }
    if (flightPhase === 'fade-in') {
      const a = Math.min(1, (now - fadeStart) / FADE_MS);
      globeOpacity = smooth(a);
      if (a >= 1) {
        flightPhase = '';
        flightFocus = undefined;
        flightFade = 1;
      }
      setDecks();
      return a < 1;
    }
    return false;
  };
}
let fadeStart = 0;

/**
 * Compiles the shaders of the front and globe decks once, invisibly, while the overview is idle:
 * a first draw of a new layer type costs 100-300 ms, which would otherwise fall in the fly-in or
 * in the hand-off frame. The globe deck draws a plain body (tiles from the workers).
 */
let warmed = false;
async function warmUp() {
  if (warmed || state.mode !== 'overview' || flightPhase || params.get('warm') === 'off') return;
  warmed = true;
  const id: BodyId = 'jupiter';
  frontDeck.setProps({
    views: [cameraView],
    viewState: {overview: cameraOf(orbitViewport(), state.overviewView.target)},
    layers: overviewLayers(scene, {mode: 'rest', focus: id, fade: 0}),
    effects: [frontLighting]
  });
  const view = globeStateFromOverview(id, orbitViewport({...state.overviewView, target: scene.pos[id], zoom: handoffOverviewZoom(id)}));
  // A throw-away basemap: a layer removed from a Deck cannot be added again.
  const basemap = await loadBasemap(id, 'imagery');
  globeDeck.setProps({views: [globeView], viewState: {globe: view}, layers: [basemap, ...bodyNightLayers(id)]});
  const t0 = performance.now();
  await new Promise<void>(resolve => {
    const check = () => {
      const layers = globeDeck.layerManager?.getLayers() ?? [];
      const loaded = layers.length > 1 && layers.every((l: {isLoaded: boolean}) => l.isLoaded);
      if ((loaded && performance.now() - t0 > 300) || performance.now() - t0 > 8000) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
  // Night images of every body, one per idle slot.
  for (const body of BODY_IDS) {
    await new Promise(resolve => setTimeout(resolve, 30));
    if (flightPhase) break;
    if (body !== 'sun') bodyNightImage(body);
  }
  if (!flightPhase && state.mode === 'overview') {
    globeDeck.setProps({layers: []});
    frontDeck.setProps({layers: []});
    setDecks();
  }
}

/** Back to the system: fade the globe out over the same camera, then fly out from that camera. */
function flyOut() {
  if (state.mode !== 'globe' || flightPhase) {
    enterOverview();
    return;
  }
  const token = ++flight;
  const id = state.body;
  flightPhase = 'fade-out';
  flightFocus = id;
  flightFade = 0;
  setDecks();
  const fadeOut = clock();
  let start = 0;
  let cam0: Camera, cam1: Camera, zoom0 = 0, zoom1 = 0;
  const end = {...state.overviewView, target: scene.pos.sun, zoom: fitZoom(state.scale), rotationX: 35};
  frameLoop(now => {
    if (token !== flight) return false;
    if (flightPhase === 'fade-out') {
      const a = Math.min(1, (now - fadeOut) / FADE_MS);
      globeOpacity = 1 - smooth(a);
      setDecks();
      if (a < 1) return true;
      // The overview takes over at the globe's camera, then flies to the system view.
      cam0 = {...(state.camera as Camera)};
      const endViewport = orbitViewport(end);
      cam1 = cameraOf(endViewport, end.target);
      zoom0 = cameraViewport(cam0).zoom;
      zoom1 = endViewport.zoom;
      state.mode = 'overview';
      flightPhase = 'fly-out';
      start = now;
      render();
      return true;
    }
    const t = Math.min(1, (now - start) / FLY_MS);
    const e = ease(t);
    // The time-reverse of the fly-in: the target leaves the body late.
    const p = 1 - Math.min(1, (1 - e) * 1.15);
    const target = cam0.target.map((v, k) => v + (cam1.target[k] - v) * p) as V3;
    const v = slerp(unit(subV(cam0.eye, cam0.target)), unit(subV(cam1.eye, cam1.target)), e);
    let up = slerp(cam0.up, cam1.up, e);
    up = unit(subV(up, scaleV(v, dot(up, v))));
    const zoom = zoom0 + (zoom1 - zoom0) * e;
    const distance = (focalOf(overviewFovy) * innerHeight) / 2 ** zoom;
    state.camera = {eye: addV(target, scaleV(v, distance)), target, up};
    flightFade = e;
    overviewCache = overviewLayers(scene, {mode: 'all', focus: id, fade: flightFade});
    if (t >= 1) {
      state.camera = null;
      state.overviewView = end;
      flightPhase = '';
      flightFocus = undefined;
      flightFade = 1;
      unmountGlobe();
      render();
      if (pendingTravel) {
        const next = pendingTravel;
        pendingTravel = null;
        flyTo(next);
      }
      return false;
    }
    renderViewState();
    return true;
  });
}
/** A body to fly to when the fly-out ends. */
let pendingTravel: BodyId | null = null;
/** Flies to a body from any mode: from a globe it flies directly to the other globe. */
function travelTo(id: BodyId) {
  if (flightPhase) return;
  if (state.mode === 'globe') {
    if (id !== state.body) flyBetween(id);
    return;
  }
  if (state.mode === 'compare' || state.camera) enterOverview();
  flyTo(id);
}

/** Longest direct flight between two globes, ms. */
const TRAVEL_MAX_MS = 4000;
const ECLIPTIC_NORTH: V3 = [0, 0, 1];

/**
 * A direct flight from the globe of the current body A to the globe of body B. The globe of A
 * fades out over the overview at the same camera; then one camera path runs in the overview:
 * - the target moves from A to B (the bodies keep moving when the clock plays),
 * - the camera distance follows log space from A's size to B's size, with a rise in the middle
 *   that shows both bodies for a far pair (a short arc for a near pair),
 * - the view turns from A's view to look along the line from A to B, then turns to face B.
 * The path ends at the hand-off camera of B, so the globe of B fades in as after a fly-in.
 */
function flyBetween(id: BodyId) {
  const from = state.body;
  const token = ++flight;
  flightPhase = 'fade-out';
  flightFocus = from;
  flightFade = 0;
  setDecks();
  const fadeOut = clock();
  let start = 0;
  let duration = 0;
  let cam0: Camera;
  let fromPos0: V3;
  let rise = 0;
  /** The hand-off view of B in the current scene. */
  const handoffView = () => ({...state.overviewView, target: scene.pos[id], zoom: handoffOverviewZoom(id), rotationX: 15});
  let mounted = false;
  let lastLabel = 0;
  const handoff = makeHandoff(() => {});
  frameLoop(now => {
    if (token !== flight) return false;
    if (flightPhase === 'fade-out') {
      const a = Math.min(1, (now - fadeOut) / FADE_MS);
      globeOpacity = 1 - smooth(a);
      setDecks();
      if (a < 1) return true;
      // The overview takes over at the globe's camera.
      cam0 = {...(state.camera as Camera)};
      fromPos0 = scene.pos[from];
      const to = handoffView();
      const cam1 = cameraOf(orbitViewport(to), to.target);
      const d0 = norm(subV(cam0.eye, cam0.target));
      const d1 = norm(subV(cam1.eye, cam1.target));
      const gap = norm(subV(cam1.target, cam0.target));
      // Distance from which the gap fills half of the view height.
      const see = gap / Math.tan((overviewFovy * DEG) / 2);
      rise = Math.max(0, Math.log(see) - (Math.log(d0) + Math.log(d1)) / 2);
      duration = Math.min(TRAVEL_MAX_MS, 1500 + 450 * (rise + 0.5 * Math.abs(Math.log(d1 / d0))));
      state.mode = 'overview';
      state.body = id;
      state.clicked = null;
      flightPhase = 'travel';
      hidden.clear();
      start = now;
      render();
      return true;
    }
    if (flightPhase === 'travel') {
      if (state.playing) {
        scene = computeScene();
        if (now - lastLabel > 250) {
          lastLabel = now;
          $('date-label').textContent = `${scene.date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
        }
      }
      const t = Math.min(1, (now - start) / duration);
      const e = ease(t);
      const to = handoffView();
      const cam1 = cameraOf(orbitViewport(to), to.target);
      // A's centre moves with A; the path ends at B's hand-off camera.
      const a = addV(cam0.target, subV(scene.pos[from], fromPos0));
      const target = a.map((v, k) => v + (cam1.target[k] - v) * e) as V3;
      const v0 = unit(subV(cam0.eye, cam0.target));
      const v1 = unit(subV(cam1.eye, cam1.target));
      const along = subV(cam1.target, a);
      const vLine = norm(along) > 0 ? unit(addV(scaleV(unit(along), -1), scaleV(ECLIPTIC_NORTH, 0.6))) : v1;
      const v = t < 0.5 ? slerp(v0, vLine, smooth(2 * t)) : slerp(vLine, v1, smooth(2 * t - 1));
      let up = t < 0.5 ? slerp(cam0.up, ECLIPTIC_NORTH, smooth(2 * t)) : slerp(ECLIPTIC_NORTH, cam1.up, smooth(2 * t - 1));
      up = subV(up, scaleV(v, dot(up, v)));
      up = norm(up) > 1e-6 ? unit(up) : cam1.up;
      const d0 = norm(subV(cam0.eye, cam0.target));
      const d1 = norm(subV(cam1.eye, cam1.target));
      const logD = Math.log(d0) + (Math.log(d1) - Math.log(d0)) * e + rise * Math.sin(Math.PI * e);
      state.camera = {eye: addV(target, scaleV(v, Math.exp(logD))), target, up};
      // The orbits and labels fade in around A, then fade out around B.
      flightFocus = t < 0.5 ? from : id;
      flightFade = t < 0.5 ? smooth(2 * t) : 1 - smooth(2 * t - 1);
      if (!mounted && t > 0.5) {
        // Prefetch: the hidden globe of B loads its tiles during the second half.
        mounted = true;
        state.globeViews = {globe: globeStateFromOverview(id, orbitViewport(to))};
        mountGlobe(id);
      }
      overviewCache = overviewLayers(scene, {mode: 'all', focus: flightFocus, fade: flightFade});
      if (t >= 1) {
        state.camera = null;
        state.overviewView = to;
        state.globeViews = {globe: globeStateFromOverview(id, orbitViewport(to))};
        globeDeck.setProps({viewState: {globe: state.globeViews.globe}, _customRender: null});
        globeFrames = 0;
        flightPhase = 'wait';
        if (state.playing) syncTimeInputs();
        // The overview changes from the flight camera to the OrbitView at the same camera.
        render();
        return true;
      }
      renderViewState();
      return true;
    }
    return handoff(now);
  });
}

function slerp(a: V3, b: V3, t: number): V3 {
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  const w = Math.acos(c);
  if (w < 1e-6) return a;
  if (Math.PI - w < 1e-3) {
    // Opposite: turn about any perpendicular axis.
    const p = basisFromZ(a)[0];
    return unit(addV(scaleV(a, Math.cos(Math.PI * t)), scaleV(p, Math.sin(Math.PI * t))));
  }
  const s = Math.sin(w);
  return unit(addV(scaleV(a, Math.sin((1 - t) * w) / s), scaleV(b, Math.sin(t * w) / s)));
}

/** Globe mode without a fly-in (`?mode=globe`): longitude 0, latitude 15 (or `lon`, `lat`, `zoom`), north up. */
function enterGlobe(id: BodyId, query: URLSearchParams = params) {
  ++flight;
  flightPhase = '';
  flightFocus = undefined;
  flightFade = 1;
  setOverviewFovy(GLOBE_FOVY);
  hidden.clear();
  scene = computeScene();
  state.mode = 'globe';
  state.body = id;
  state.clicked = null;
  // `view=sun`: face the sub-solar point of the body (where its eclipse shadows fall).
  const subSolar = lonLatOf(toFixed(id, scaleV(scene.night[id], -1)));
  const facing = query.get('view') === 'sun' && id !== 'sun';
  const latitude = Number(query.get('lat') ?? (facing ? subSolar.lat : id === 'saturn' ? 20 : 15));
  const longitude = Number(query.get('lon') ?? (facing ? subSolar.lon : 0));
  const limits = globeZoomLimits(id);
  const fit = Math.log2((globeRadiusForLimb(handoffLimbPx(id)) * innerHeight) / 256) + zoomAdjustAt(latitude);
  const zoom = Math.min(limits.maxZoom, Math.max(limits.minZoom, Number(query.get('zoom') ?? fit)));
  state.globeViews = {globe: {longitude, latitude, zoom, bearing: 0, pitch: 0, ...limits}};
  globeOpacity = 1;
  mountGlobe(id);
  render();
}
function enterCompare() {
  ++flight;
  flightPhase = '';
  state.mode = 'compare';
  state.camera = null;
  unmountGlobe();
  state.clicked = null;
  globeOpacity = 0;
  state.globeViews = Object.fromEntries(COMPARE_IDS.map(id => [id, defaultGlobeView(false)]));
  compareBasemaps = {};
  for (const id of COMPARE_IDS) {
    loadBasemap(id, state.surface).then(layer => {
      compareBasemaps[id] = layer;
      if (state.mode === 'compare') render();
    });
  }
  render();
}
function enterOverview() {
  ++flight;
  flightPhase = '';
  flightFocus = undefined;
  flightFade = 1;
  state.mode = 'overview';
  state.camera = null;
  globeOpacity = 0;
  unmountGlobe();
  setOverviewFovy(50);
  hidden.clear();
  scene = computeScene();
  state.overviewView = {...state.overviewView, target: scene.pos.sun, zoom: fitZoom(state.scale), rotationX: 35};
  render();
}
/** Overview centred on a body, wide enough for its moons or rings (`?focus=`; `orbit`, `tilt` and `extent` set the camera). */
const FOCUS_EXTENT: Partial<Record<BodyId, number>> = {jupiter: 4, saturn: 2.6};
function focusOn(id: BodyId, query: URLSearchParams = params) {
  const extent = Number(query.get('extent') ?? FOCUS_EXTENT[id] ?? 1.5);
  state.mode = 'overview';
  state.camera = null;
  globeOpacity = 0;
  scene = computeScene();
  const radius = id === 'jupiter' && state.scale === 'true' ? 1.9 : scene.radius[id] * extent;
  state.overviewView = {
    ...state.overviewView,
    target: scene.pos[id],
    zoom: Math.log2((Math.min(innerWidth, innerHeight) * 0.42) / radius),
    rotationOrbit: Number(query.get('orbit') ?? state.overviewView.rotationOrbit),
    rotationX: Number(query.get('tilt') ?? 25)
  };
  render();
}

// ---------- Panel ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
/** Playback speeds: simulated seconds per real second. */
const SPEEDS: [number, string][] = [
  [1, '1× (real time)'],
  [60, '1 minute per second'],
  [3600, '1 hour per second'],
  [86400, '1 day per second'],
  [7 * 86400, '1 week per second'],
  [30 * 86400, '30 days per second'],
  [365.25 * 86400, '1 year per second']
];
/** Half-widths of the time bar, days. */
const SPANS: [number, string][] = [[30, '±30 days'], [365, '±1 year'], [3652.5, '±10 years'], [73050, '±200 years']];
/** The time bar marks every eclipse on a window of up to a year, and the major ones up to ten years. */
const ALL_MARKS_SPAN = 365;
const MAJOR_MARKS_SPAN = 3652.5;
/** The next-event button looks this far ahead, days. */
const NEXT_EVENT_DAYS = 400;

/**
 * One-click states. A scene with a `query` opens as the page does from that URL query; `on` names
 * the layers that it shows, which it turns on.
 */
type SceneSpec = {id: string; label: string; hint: string; query?: string; on?: ('shadows' | 'clouds')[]; run?: () => void};
const SCENES: SceneSpec[] = [
  {id: 'solar-eclipse', label: 'Total solar eclipse, 2024', hint: 'The shadow of the Moon on the Earth', query: 'mode=globe&body=earth&date=2024-04-08T18:17Z&lon=-100&lat=28', on: ['shadows']},
  {id: 'ring-shadow', label: 'Ring shadow of Saturn', hint: 'Saturn and its rings shade each other, 2017', query: 'focus=saturn&date=2017-06-01&orbit=120&tilt=35', on: ['shadows']},
  {id: 'lunar-eclipse', label: 'Total lunar eclipse, 2025', hint: 'The shadow of the Earth on the Moon', query: 'focus=moon&date=2025-03-14T06:58Z', on: ['shadows']},
  {id: 'comet', label: 'Comet at perihelion', hint: `${NEOWISE.name}, 2020-07-03`, query: 'comet=perihelion'},
  {id: 'ember', label: 'Into the Ember cloud', hint: 'A flight into a gas cloud (artistic)', run: () => flyIntoCloud()},
  {id: 'clouds', label: 'Clouds of the Earth', hint: 'The day side, from above the sub-solar point', query: 'mode=globe&body=earth&view=sun', on: ['clouds']}
];
const START_CARD = params.get('card');
const panel = createPanel($('panel'), {
  speeds: SPEEDS,
  spans: SPANS,
  bodyGroups: [
    {label: 'Sun and planets', bodies: BODY_IDS.filter(id => id !== 'moon').map(id => ({id, label: BODIES[id].label, color: BODIES[id].color}))},
    {label: 'Moons', bodies: [{id: 'moon', label: BODIES.moon.label, color: BODIES.moon.color}]}
  ],
  scenes: SCENES,
  // A wide window starts with the Navigate card; a narrow one starts with the view clear.
  card: CARD_IDS.includes(START_CARD as CardId) ? (START_CARD as CardId) : START_CARD === 'none' || innerWidth <= 640 ? null : 'navigate',
  hud: params.get('hud') !== 'off',
  onScene: id => openScene(id),
  onMark: index => jumpTo(marked[index]),
  onPlayPause: () => setPlaying(!state.playing),
  onSpeedStep: direction => {
    // From a speed that the list does not have (`?speed=`): the nearest listed speed in that direction.
    const next = direction > 0 ? SPEEDS.find(([v]) => v > state.speed) : [...SPEEDS].reverse().find(([v]) => v < state.speed);
    if (!next) return;
    state.speed = next[0];
    syncSpeed();
  },
  onBack: () => {
    if (state.mode === 'overview') return false;
    if (state.mode === 'globe') flyOut();
    else enterOverview();
    return true;
  }
});
$('fly').addEventListener('click', event => {
  const id = (event.target as HTMLElement).closest<HTMLElement>('[data-body]')?.dataset.body as BodyId | undefined;
  if (id) travelTo(id);
});
$('to-system').onclick = () => (state.mode === 'globe' ? flyOut() : enterOverview());
$('to-compare').onclick = () => enterCompare();
$('back').onclick = () => flyOut();
$<HTMLInputElement>('readable').checked = state.scale === 'readable';
$<HTMLInputElement>('readable').onchange = event => {
  state.scale = (event.target as HTMLInputElement).checked ? 'readable' : 'true';
  enterOverview();
};
$<HTMLSelectElement>('surface').value = state.surface;
$<HTMLSelectElement>('surface').onchange = event => {
  state.surface = (event.target as HTMLSelectElement).value as SurfaceMode;
  loadOverviewTextures(state.surface);
  if (state.mode === 'globe' && !flightPhase) {
    const limits = globeZoomLimits(state.body);
    const view = state.globeViews.globe;
    state.globeViews = {...state.globeViews, globe: {...view, ...limits, zoom: Math.min(limits.maxZoom, Math.max(limits.minZoom, view.zoom))}};
    mountGlobe(state.body);
    render();
  } else if (state.mode === 'compare') enterCompare();
  else if (!flightPhase) render();
};
$<HTMLInputElement>('corotate').checked = state.corotate;
$<HTMLInputElement>('corotate').onchange = event => {
  state.corotate = (event.target as HTMLInputElement).checked;
};
$<HTMLInputElement>('shadows').checked = state.shadows;
$<HTMLInputElement>('shadows').onchange = event => {
  state.shadows = (event.target as HTMLInputElement).checked;
  render();
};
$<HTMLInputElement>('clouds').checked = state.clouds;
$<HTMLInputElement>('clouds').onchange = event => {
  state.clouds = (event.target as HTMLInputElement).checked;
  if (state.mode !== 'compare' && !flightPhase) render();
};
/**
 * One quality level sets the cloud steps and the space-volume quality. `?cloudQuality=` can set
 * steps that no level has: the list then shows that as its own entry until a level is chosen.
 */
const qualitySelect = $<HTMLSelectElement>('quality');
function syncQuality() {
  qualitySelect.querySelector('[value="custom"]')?.remove();
  const custom = state.cloudSteps !== QUALITY_CLOUD_STEPS[state.space.quality];
  if (custom) {
    const level = state.space.quality;
    qualitySelect.add(new Option(`${level[0].toUpperCase()}${level.slice(1)}, clouds ${state.cloudSteps} steps`, 'custom'));
  }
  qualitySelect.value = custom ? 'custom' : state.space.quality;
}
syncQuality();
qualitySelect.onchange = () => {
  if (qualitySelect.value === 'custom') return;
  state.space.quality = qualitySelect.value as Quality;
  state.cloudSteps = QUALITY_CLOUD_STEPS[state.space.quality];
  syncQuality();
  if (state.mode !== 'compare' && !flightPhase) render();
  else deck.redraw('space');
};
$<HTMLInputElement>('atmosphere').checked = state.atmosphere;
$<HTMLInputElement>('atmosphere').onchange = event => {
  state.atmosphere = (event.target as HTMLInputElement).checked;
  if (state.mode !== 'compare' && !flightPhase) render();
};
$<HTMLInputElement>('night').checked = state.night;
$<HTMLInputElement>('night').onchange = event => {
  state.night = (event.target as HTMLInputElement).checked;
  render();
};

// The time bar: the clock is `baseDate + offsetDays`; the bar shows the offset on a window of
// `spanDays` each side of the base date.
const dateInput = $<HTMLInputElement>('date');
const timeInput = $<HTMLInputElement>('time');
const offsetInput = $<HTMLInputElement>('offset');
const clockTime = () => state.baseDate.getTime() + state.offsetDays * 86400000;
function syncTimeInputs() {
  // The clock left the window (playback): the window moves to it.
  if (Math.abs(state.offsetDays) > state.spanDays) {
    state.baseDate = new Date(clockTime());
    state.offsetDays = 0;
  }
  const iso = new Date(clockTime()).toISOString();
  if (document.activeElement !== dateInput) dateInput.value = iso.slice(0, 10);
  if (document.activeElement !== timeInput) timeInput.value = iso.slice(11, 16);
  offsetInput.min = String(-state.spanDays);
  offsetInput.max = String(state.spanDays);
  offsetInput.value = String(state.offsetDays);
  syncMarks();
}
/** Sets the clock; the window of the time bar moves to it. */
function setClock(date: Date) {
  state.baseDate = date;
  state.offsetDays = 0;
  syncTimeInputs();
}
/** A new day starts at UTC midnight, as `?date=` does; the time field then sets the time of day. */
dateInput.onchange = () => {
  if (!dateInput.value) return;
  timeInput.value = '00:00';
  setClock(new Date(`${dateInput.value}T00:00:00Z`));
  render();
};
timeInput.onchange = () => {
  const date = new Date(`${dateInput.value}T${timeInput.value || '00:00'}:00Z`);
  if (Number.isNaN(date.getTime())) return;
  setClock(date);
  render();
};
offsetInput.oninput = () => {
  state.offsetDays = Number(offsetInput.value);
  render();
};
const spanSelect = $<HTMLSelectElement>('span');
spanSelect.value = String(state.spanDays);
spanSelect.onchange = () => {
  state.spanDays = Number(spanSelect.value);
  syncTimeInputs();
};
const speedSelect = $<HTMLSelectElement>('speed');
function syncSpeed() {
  speedSelect.querySelector('[data-custom]')?.remove();
  if (!SPEEDS.some(([v]) => v === state.speed)) {
    const option = new Option(`${state.speed} s per second`, String(state.speed));
    option.dataset.custom = '';
    speedSelect.add(option);
  }
  speedSelect.value = String(state.speed);
}
syncSpeed();
speedSelect.onchange = () => {
  state.speed = Number(speedSelect.value);
  syncSpeed();
};
$('play').onclick = () => setPlaying(!state.playing);
$('now').onclick = () => {
  setClock(new Date());
  render();
};

/**
 * Eclipses by UTC year. A search takes about 30 ms per year, so it runs one year per task, and
 * the marks appear as the years arrive.
 */
const eclipseYears = new Map<number, SkyEvent[]>();
let eclipseTask = 0;
function eclipsesBetween(from: number, to: number): SkyEvent[] {
  const found: SkyEvent[] = [];
  let missing: number | null = null;
  for (let year = new Date(from).getUTCFullYear(); year <= new Date(to).getUTCFullYear(); year++) {
    const list = eclipseYears.get(year);
    if (list) found.push(...list);
    else missing ??= year;
  }
  if (missing !== null && !eclipseTask) {
    const year = missing;
    eclipseTask = window.setTimeout(() => {
      eclipseTask = 0;
      if (eclipseYears.size > 64) eclipseYears.clear();
      eclipseYears.set(year, findEclipses(new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1) - 1)));
      syncMarks();
    }, 0);
  }
  return found.filter(e => e.date.getTime() >= from && e.date.getTime() <= to);
}
/** The events from the start of the eclipse marks to NEXT_EVENT_DAYS past the clock, in time order. */
let events: SkyEvent[] = [];
/** The events that have a mark now, in mark order. */
let marked: SkyEvent[] = [];
let marksKey = '';
function syncMarks() {
  const base = state.baseDate.getTime();
  const span = state.spanDays * 86400000;
  const eclipseSpan = state.spanDays <= MAJOR_MARKS_SPAN ? span : 0;
  const ahead = NEXT_EVENT_DAYS * 86400000;
  events = eclipsesBetween(base - eclipseSpan, Math.max(base + eclipseSpan, clockTime() + ahead));
  const perihelion = COMET_PERIHELION_DATE.getTime();
  if (Math.abs(perihelion - base) <= Math.max(span, ahead)) {
    events.push({kind: 'comet-perihelion', date: COMET_PERIHELION_DATE, label: `${NEOWISE.name} at perihelion`, major: true});
    events.sort((a, b) => a.date.getTime() - b.date.getTime());
  }
  const shown = events.filter(
    e => Math.abs(e.date.getTime() - base) <= span && (e.major || state.spanDays <= ALL_MARKS_SPAN)
  );
  const when = (e: SkyEvent) => `${e.date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const key = `${base}:${span}:${shown.length}:${shown[0]?.date.getTime()}:${shown[shown.length - 1]?.date.getTime()}`;
  if (key !== marksKey) {
    marksKey = key;
    marked = shown;
    panel.setMarks(
      shown.map(e => ({fraction: (e.date.getTime() - base + span) / (2 * span), kind: e.kind, major: e.major, label: `${e.label}, ${when(e)}`}))
    );
  }
  const next = nextEvent();
  const button = $<HTMLButtonElement>('next-event');
  const title = next ? `Next: ${next.label}, ${when(next)}` : `No event in the next ${NEXT_EVENT_DAYS} days`;
  if (button.title !== title) {
    button.title = title;
    button.setAttribute('aria-label', title);
    button.disabled = !next;
  }
}
/** The first event more than a minute after the clock. */
const nextEvent = () => events.find(e => e.date.getTime() > clockTime() + 60000);
/** Sets the clock to an event. The window stays, if it has the event. */
function jumpTo(event: SkyEvent | undefined) {
  if (!event) return;
  state.offsetDays = (event.date.getTime() - state.baseDate.getTime()) / 86400000;
  syncTimeInputs();
  render();
}
$('next-event').onclick = () => jumpTo(nextEvent());
syncTimeInputs();

for (const key of ['looks', 'corona', 'comet', 'gas', 'dust'] as const) {
  const input = $<HTMLInputElement>(`sp-${key}`);
  input.checked = state.space[key];
  input.onchange = () => {
    state.space[key] = input.checked;
    if (state.mode !== 'compare' && !flightPhase) render();
    else deck.redraw('space');
  };
}
$<HTMLSelectElement>('sp-cloud').value = state.space.cloudMode;
$<HTMLSelectElement>('sp-cloud').onchange = event => {
  state.space.cloudMode = (event.target as HTMLSelectElement).value as SpaceToggles['cloudMode'];
  deck.redraw('space');
};
$<HTMLInputElement>('linked').checked = state.linked;
$<HTMLInputElement>('linked').onchange = event => {
  state.linked = (event.target as HTMLInputElement).checked;
};

/** Opens the view of a URL query: the start state of the page, and the scenes. */
function openView(query: URLSearchParams) {
  const mode = query.get('mode');
  const body = query.get('body') ?? '';
  const focus = query.get('focus') ?? '';
  if (mode === 'globe') enterGlobe(body in BODIES ? (body as BodyId) : 'earth', query);
  else if (mode === 'compare') enterCompare();
  else if (focus in BODIES) focusOn(focus as BodyId, query);
  else if (query.get('comet') === 'perihelion') focusComet(true);
  else enterOverview();
}
function openScene(id: string) {
  const spec = SCENES.find(s => s.id === id);
  if (!spec) return;
  for (const key of spec.on ?? []) {
    state[key] = true;
    $<HTMLInputElement>(key).checked = true;
  }
  if (spec.run) {
    spec.run();
    return;
  }
  // A scene is one instant: the clock stops there.
  setPlaying(false);
  const query = new URLSearchParams(spec.query);
  if (query.has('date')) setClock(parseDate(query.get('date')));
  if (query.get('mode') !== 'globe') {
    // As the page starts: the system view, at the start rotation.
    enterOverview();
    state.overviewView = {...state.overviewView, rotationOrbit: START_ORBIT};
  }
  openView(query);
}

/**
 * Playback: the simulated time advances by the real time since the last frame times the speed.
 * The scene redraws at most PLAY_FRAME_MS apart (the globe night layer costs more per update),
 * so at real time the view changes about once a second and costs almost nothing.
 */
const PLAY_FRAME_MS = {overview: 33, globe: 100, compare: 250};
let lastPlayTime = 0;
let lastPlayRender = 0;
function setPlaying(playing: boolean) {
  state.playing = playing;
  panel.setPlaying(playing);
  lastPlayTime = performance.now();
  lastPlayRender = 0;
  if (playing) requestAnimationFrame(playStep);
}
function playStep(now: number) {
  if (!state.playing) return;
  state.offsetDays += ((now - lastPlayTime) / 1000) * (state.speed / 86400);
  lastPlayTime = now;
  // Flights own the frame loop; the clock still runs and the scene catches up afterwards.
  if (!flightPhase && now - lastPlayRender >= PLAY_FRAME_MS[state.mode]) {
    lastPlayRender = now;
    syncTimeInputs();
    render();
  }
  requestAnimationFrame(playStep);
}

/** Overview on the comet; `atPerihelion` also sets the clock to its perihelion. */
function focusComet(atPerihelion: boolean) {
  if (state.mode !== 'overview' || flightPhase) enterOverview();
  if (atPerihelion) {
    setClock(COMET_PERIHELION_DATE);
  }
  state.space.comet = true;
  $<HTMLInputElement>('sp-comet').checked = true;
  state.camera = null;
  scene = computeScene();
  const c = cometAt(scene.date);
  const tail = norm(subV(place(c.dustAU[c.dustAU.length - 1]), place(c.position)));
  state.overviewView = {
    ...state.overviewView,
    target: scene.comet.position,
    zoom: Math.log2((Math.min(innerWidth, innerHeight) * 0.3) / Math.max(tail, 1e-3)),
    rotationX: 30,
    rotationOrbit: 60
  };
  render();
}

/** A flight from the current overview camera into the Ember cloud (artistic), over 6 s. */
function flyIntoCloud(durationMs = Number(params.get('cloudMs') ?? 6000)) {
  if (state.mode !== 'overview' || flightPhase || state.camera) enterOverview();
  state.space.gas = true;
  $<HTMLInputElement>('sp-gas').checked = true;
  const token = ++flight;
  const placed = cloudPlacement(spaceScene(), CLOUDS[0]);
  const from = withoutTransition(state.overviewView);
  // Inside the cloud: the camera 0.6 half-sizes from its centre.
  const zoomInside = Math.log2((focalOf(overviewFovy) * innerHeight) / (0.6 * placed.half));
  // The path is in absolute scene units: with the clock running, the floating origin can move
  // during the flight (render() rebases it), and the next frame then follows it.
  const fromAbsolute = addV(from.target, origin);
  const toAbsolute = addV(placed.center, origin);
  const start = clock();
  frameLoop(now => {
    if (token !== flight) return false;
    const t = Math.min(1, (now - start) / durationMs);
    const e = ease(t);
    const a = Math.min(1, e * 1.3);
    state.overviewView = {
      ...from,
      target: subV(fromAbsolute.map((v, k) => v + (toAbsolute[k] - v) * a) as V3, origin),
      zoom: from.zoom + (zoomInside - from.zoom) * e,
      rotationX: from.rotationX + (12 - from.rotationX) * e,
      rotationOrbit: from.rotationOrbit + 40 * e
    };
    renderViewState();
    // At the end, a render lets the origin follow the camera when the clock is paused.
    if (t >= 1) render();
    return t < 1;
  });
}

function gravityText(id: BodyId, lat: number | null) {
  const body = BODIES[id];
  if (body.flattening > 0.02) return `${body.label}: no normal gravity (a level ellipsoid is a poor model of a gas giant).`;
  const g = getNormalGravity(body);
  const f = (v: number) => v.toFixed(4);
  const at = lat === null ? '' : ` · at ${lat.toFixed(2)}°: <b>${f(g.surfaceGravity(lat))} m/s²</b>`;
  return `${body.label}: normal gravity equator ${f(g.surfaceGravity(0))}, pole ${f(g.surfaceGravity(90))} m/s²${at}`;
}

/** Why a layer control does not apply to the view now (the reason shows beside it), or null. */
function layerLimits(): Record<'surface' | 'night' | 'shadows' | 'corotate' | 'clouds' | 'atmosphere', string | null> {
  const globe = state.mode === 'globe';
  const compare = state.mode === 'compare';
  const id = state.body;
  const air = ATMOSPHERE_IDS.includes(id);
  return {
    // A body with no vector data shows the same map in both modes.
    surface: globe && id !== 'earth' && !BODIES[id].vector ? 'no vector map' : null,
    night: globe && id === 'sun' ? 'no night side' : null,
    shadows: globe && !SHADOWED_BODIES.has(id) ? 'none on this body' : null,
    corotate: globe ? null : 'globe view only',
    // The compare view has no cloud or atmosphere layer.
    clouds: compare ? 'not in compare' : globe && id !== 'earth' && id !== 'venus' ? 'Earth and Venus only' : null,
    atmosphere: compare
      ? 'not in compare'
      : globe && !air
        ? id === 'moon' || id === 'mercury' ? 'no atmosphere' : 'Earth, Mars, Venus only'
        : null
  };
}

let panelMode = '';
function renderPanel() {
  const overview = state.mode === 'overview';
  $('overview-controls').style.display = overview ? '' : 'none';
  $('globe-controls').style.display = overview ? 'none' : '';
  $('fly').style.display = state.mode === 'compare' ? 'none' : '';
  $('link-row').style.display = state.mode === 'compare' ? '' : 'none';
  $('back').style.display = state.mode === 'globe' ? '' : 'none';
  $('to-system').setAttribute('aria-pressed', String(overview));
  $('to-compare').setAttribute('aria-pressed', String(state.mode === 'compare'));
  for (const button of $('fly').querySelectorAll<HTMLElement>('[data-body]')) {
    button.setAttribute('aria-pressed', String(state.mode === 'globe' && button.dataset.body === state.body));
  }
  // The notes open with the system view; the user can close them until the mode changes.
  if (panelMode !== state.mode) {
    panelMode = state.mode;
    ($('notes-box') as HTMLDetailsElement).open = overview && params.get('notes') !== 'off';
  }
  const limits = layerLimits();
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) panel.setAvailable(key, limits[key]);
  $('globe-title').textContent = state.mode === 'globe' ? BODIES[state.body].label : 'Earth | Moon | Mars';
  $('date-label').textContent = `${scene.date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  renderHud();
  const ids = state.mode === 'globe' ? [state.body] : state.mode === 'compare' ? COMPARE_IDS : [];
  const clicked = state.clicked;
  $('gravity').innerHTML = ids.length
    ? `${ids.map(id => gravityText(id, clicked && clicked.body === id ? clicked.lat : null)).join('<br>')}<br>` +
      '<span class="dim">Click the globe for the value at a latitude.</span>'
    : '';
  $('notes').innerHTML = overview
    ? `${state.scale === 'true' ? 'True scale: 1 unit = 10⁶ km; the bodies are at true size (zoom in to see them).' : 'Readable scale: distance = 40·log₂(1 + r/0.2 AU); radius = 1.2 + 1.6·log₂(1 + R/1000 km). The Moon is beside the Earth, in its true direction.'}<br>
       Positions of the planets, the Moon and the Galilean moons: Astronomy Engine (MIT). Poles and prime meridians of all bodies: Astronomy Engine RotationAxis (IAU WGCCRE). Night sides: math.gl getSunTerminator (Earth) and the true heliocentric directions, not the point light.`
    : `GlobeView draws every body on a sphere of the Earth's radius: heights and distances read as Earth units.
       Web Mercator tiles stop at ±85.05°: at the poles the overview sphere shows through.`;
  const cloudCredit = state.clouds && state.mode !== 'compare' && (state.mode === 'overview' || ids.includes('earth')) ? ` ${EARTH_CLOUD_CREDIT}` : '';
  const credit = `${creditText(ids)}${cloudCredit} ${SKY_CREDIT}`;
  if ($('credit').textContent !== credit) $('credit').textContent = credit;
  renderSky();
}

/** The status readout: the view, the scale and the frame rate. */
let fps = '-';
function renderHud() {
  const view = state.mode === 'globe' ? BODIES[state.body].label : state.mode === 'compare' ? 'Compare' : 'System';
  panel.setHud(`${view} · ${state.scale === 'true' ? 'true scale' : 'readable scale'} · ${fps} fps`);
}

function creditText(ids: BodyId[]) {
  if (state.mode === 'overview') {
    return state.surface === 'vector'
      ? 'Vector textures: Earth: OpenFreeMap "liberty", © OpenMapTiles, data © OpenStreetMap contributors (ODbL); Moon: USGS Unified Geologic Map of the Moon (CC0); Mars: USGS SIM 3292 (public domain); Mercury: USGS MESSENGER DEM contours (public domain); names and crater rims: IAU/USGS Gazetteer (public domain). Others: plain colour.'
      : 'Textures: NASA GIBS Blue Marble (Earth); NASA Trek (Moon LROC WAC, Mars Viking MDIM 2.1, Mercury MESSENGER MDIS). Others: plain colour.';
  }
  return ids.map(id => `${BODIES[id].label}: ${surfaceCredit(BODIES[id], state.surface)}`).join(' · ');
}

const SKY_CREDIT =
  `Sky: math.gl @math.gl/earth/sun; stars: ${STAR_SOURCE}; the Milky Way is a procedural math.gl approximation. ` +
  'Astronomy Engine (MIT, Don Cross): positions, Galilean moons, poles.';

function renderSky() {
  const date = scene.date;
  const moon = getMoonPhase(date);
  const t = getTerminator(date);
  const pct = (v: number) => `${(100 * v).toFixed(1)}%`;
  const ll = (lat: number, lon: number) =>
    `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  const lines = [
    `<b>Moon:</b> ${moon.name}, ${pct(moon.fraction)} lit (math.gl getMoonIllumination)`,
    `<b>Sub-solar point:</b> ${ll(t.subSolar.lat, t.subSolar.lon)} (math.gl getSunTerminator)`
  ];
  const casting = Object.values(scene.shadows).flatMap(g =>
    g ? g.occluders.map(o => `${o.id[0].toUpperCase()}${o.id.slice(1)} on ${BODIES[g.receiver].label}`) : []
  );
  lines.push(
    `<b>Eclipse shadows:</b> ${state.shadows ? (casting.length ? casting.join(', ') : 'none now') + '; Saturn and its rings' : 'off'}`
  );
  if (state.mode === 'overview') {
    lines.push(
      `<b>Galilean moons</b> (Astronomy Engine JupiterMoons): ${state.scale === 'true' ? 'true distances' : 'true directions on enlarged circles'}.`,
      `<b>Saturn's rings</b> ${(SATURN_RINGS.innerKm / 1000).toFixed(1)}–${(SATURN_RINGS.outerKm / 1000).toFixed(1)} Mm (math.gl).`
    );
  }
  $('sky').innerHTML = lines.join('<br>');
}

setInterval(() => {
  const m = (state.mode === 'globe' ? globeDeck : deck).metrics as unknown as Record<string, number>;
  const tiles = getTileStats();
  fps = m.fps?.toFixed(0) ?? '-';
  renderHud();
  $('stats').textContent =
    `tiles ${tiles.served}, source tiles ${tiles.sourceTiles}` + (tiles.sourceMisses ? ` (failed ${tiles.sourceMisses})` : '');
  const failures = [...errors, ...textureErrors];
  $('errors').textContent = failures.slice(-3).join('\n');
  panel.setErrorCount(failures.length);
  const look = spaceStats.look;
  const shares = look ? look.weights.filter(w => w.share > 0.005).map(w => `${w.id} ${(100 * w.share).toFixed(0)}%`) : [];
  $('space-look').textContent =
    `Look: ${shares.length ? shares.join(', ') : 'none'} · EV ${(look?.params.exposure ?? 0).toFixed(2)} · ` +
    `volumes ${spaceStats.drawMs.toFixed(1)} ms CPU at ${state.space.quality} (${Math.round(QUALITY[state.space.quality].scale * 100)}% resolution)` +
    (cloudLoaded ? '' : ' · cloud volume loading');
}, 500);

/** Hooks for automated browser checks. */
Object.assign(window, {
  solarSystemExample: {
    state,
    flyTo,
    flyOut,
    travelTo,
    setPlaying,
    /** A scene of the Scenes menu, by id, and the events of the time bar. */
    openScene,
    scenes: () => SCENES.map(({id, query}) => ({id, query})),
    events: () => events,
    panel,
    phase: () => flightPhase,
    /** The camera of the overview deck (the view under the globe), for flight checks. */
    camera: () => {
      const cam = state.camera ?? cameraOf(orbitViewport(state.overviewView), state.overviewView.target);
      return {eye: [...cam.eye], target: [...cam.target]};
    },
    scene: () => scene,
    setGlobeView: (view: Partial<(typeof state.globeViews)[string]>) => {
      state.globeViews.globe = {...state.globeViews.globe, ...view};
      renderViewState();
    },
    globeLoaded: () => globeReady(),
    texturesPending: () => texturesPending,
    tileStats: getTileStats,
    errors: () => [...errors, ...textureErrors],
    /** The floating origin: absolute position = view state position + origin. */
    origin: () => [...origin] as V3,
    /** The three decks, for frame-cost checks. */
    decks: () => ({deck, globeDeck, frontDeck}),
    render,
    space: {
      stats: spaceStats,
      lookAt: (eye: V3) => lookAt(eye),
      focusComet,
      flyIntoCloud,
      cloudLoaded: () => cloudLoaded,
      redraw: () => deck.redraw('space'),
      viewport: () => {
        const v = deck.getViewports()[0];
        return v && {eye: [...v.cameraPosition], viewProjection: [...v.viewProjectionMatrix], project: (p: V3) => v.project(p)};
      }
    }
  }
});

// ---------- Start ----------

openView(params);
