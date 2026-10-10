// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import TangramLayer, {
  TangramLayer as NamedTangramLayer,
  createTangramLayerClass,
  getExternalCameraFrame,
  getFirstPersonViewFrame,
  WebMercatorViewAdapter,
  FirstPersonViewAdapter,
  GlobeViewAdapter
} from '../modules/tangram-layers/dist/index.js';
import Tangram, {
  ClassicWebGLRenderer,
  HostFrame,
  LumaDeviceRenderer,
  Renderer,
  Scene,
  WebMercatorGlobeVisibilityAdapter,
  WebMercatorVisibilityAdapter,
  calculatePlanarGroundBounds,
  convertLumaLight,
  mapTangramLight
} from '../modules/tangram-renderer/dist/index.js';
import {TangramStyleSheetSchema} from '../modules/tangram-renderer/dist/style-schema.js';
import tangramStyleJsonSchema from '../modules/tangram-renderer/dist/tangram-style.schema.json';
import {hillshade, triplanar, planar, sphereMap, heightDecode, globeHorizon} from '../modules/tangram-renderer/dist/shader-modules.js';
import {resolveLabelPlacement, TileBuildQueue, intersectsScreenBounds,
  areGeographicLabelCopies, TileResidency, TileCachePolicy} from '../modules/tangram-renderer/dist/map-logic.js';
import {Renderer as CoreRenderer, HostFrame as CoreHostFrame,
  calculatePlanarGroundBounds as coreGroundBounds,
  PROJECTION_CONSTANTS, projectGeographicPosition, projectGeographicVector, unprojectGlobePosition, getGeographicProjectionProcedure,
  convertLumaLight as coreConvertLumaLight} from '../modules/tangram-renderer/dist/core.js';
import {
  WebXRMapView,
  WebXRPresentation
} from '../modules/tangram-layers/dist/experimental/webxr.js';
import layerPackage from '../modules/tangram-layers/package.json';
import rendererPackage from '../modules/tangram-renderer/package.json';

// Import artifacts explicitly so source aliases used for coverage cannot bypass
// the build. Check export mappings too, so these paths stay the published ones.

describe('published package entrypoints', () => {
  it.each([
    [layerPackage, '.', './dist/index.js'],
    [layerPackage, './experimental/webxr', './dist/experimental/webxr.js'],
    [rendererPackage, '.', './dist/index.js'],
    [rendererPackage, './core', './dist/core.js'],
    [rendererPackage, './map-logic', './dist/map-logic.js'],
    [rendererPackage, './experimental/shader-modules', './dist/shader-modules.js'],
    [rendererPackage, './style-schema', './dist/style-schema.js'],
    [rendererPackage, './tangram-style.schema.json', './dist/tangram-style.schema.json']
  ].map(([manifest, subpath, artifactPath]) => ({packageName: manifest.name, manifest, subpath, artifactPath})))
  ('tests the built artifact exported by $packageName $subpath', ({manifest, subpath, artifactPath}) => {
    const entry = manifest.exports[subpath];
    expect(typeof entry === 'string' ? entry : entry.import).toBe(artifactPath);
  });
  it('exports optional shader modules separately from the renderer', () => {
    expect(hillshade.name).toBe('hillshade');
    expect(hillshade.fs).toContain('hillshade_getNormal');
    expect(hillshade.source).toContain('hillshade_getIntensity');
    expect(Tangram).not.toHaveProperty('hillshade');
    for (const shaderModule of [triplanar, planar, sphereMap, heightDecode, globeHorizon]) {
      expect(shaderModule.fs).toBeTypeOf('string');
      expect(shaderModule.source).toBeTypeOf('string');
      expect(Tangram).not.toHaveProperty(shaderModule.name);
    }
  });
  it('exports neutral projection helpers from the built core entry', () => {
    const point = projectGeographicPosition([0, 0, 100], 'globe');
    expect(point[1]).toBeLessThan(-PROJECTION_CONSTANTS.globeRadius);
    expect(projectGeographicVector([0, 0, 0], [0, 0, 1], 'globe')).toEqual([0, -1, 0]);
    expect(unprojectGlobePosition(point)[2]).toBeCloseTo(100, 6);
    const globe = getGeographicProjectionProcedure('globe');
    expect(globe.project([0, 0, 100])).toEqual(point);
    expect(globe.positionUnits).toBe('globe-common-units');
    expect(getGeographicProjectionProcedure('web-mercator').unproject([0, 0, 100])).toEqual([0, 0, 100]);
  });
  it('exports working CPU utilities from the built optional entry', () => {
    const candidate = {id: 'city', boxes: new Map([['map', [0, 0, 20, 20]]])};
    expect(resolveLabelPlacement([candidate], {viewports: new Map([['map', {width: 100, height: 100}]])}).get(candidate)).toBe(true);
    expect(new TileBuildQueue().getCounts()).toEqual({activeBuilds: 0, queuedBuilds: 0});
    expect(intersectsScreenBounds([0, 0, 20, 20], [20, 0, 40, 20])).toBe(false);
    expect(areGeographicLabelCopies).toBeTypeOf('function');
    const residency = new TileResidency();
    residency.updateConsumer('left', ['tile'], []);
    expect(new TileCachePolicy().selectEvictions([{key: 'tile', bytes: 10,
      protected: residency.isProtected('tile')}], {maxCachedTiles: 0})).toEqual([]);
    residency.detachConsumer('left');
    expect(new TileCachePolicy().selectEvictions([{key: 'tile', bytes: 10,
      protected: residency.isProtected('tile')}], {maxCachedTiles: 0})).toEqual(['tile']);
    expect(Tangram).not.toHaveProperty('TileCachePolicy');
    expect(Tangram).not.toHaveProperty('resolveLabelPlacement');
  });
  it('exposes a working host-only core while preserving the classic root', () => {
    const renderer = new CoreRenderer({});
    expect(renderer.scene.view.camera_mode).toBe('external');
    expect(CoreHostFrame).toBeTypeOf('function');
    expect(coreGroundBounds).toBeTypeOf('function');
    expect(calculatePlanarGroundBounds).toBeTypeOf('function');
    expect(coreConvertLumaLight).toBeTypeOf('function');
    expect(convertLumaLight).toBeTypeOf('function');
    expect(mapTangramLight).toBeTypeOf('function');
    expect(Tangram.Scene).toBe(Scene);
    expect(window.Tangram).toBe(Tangram);
  });
  it('exports the renderer compatibility surface', () => {
    expect(Tangram).toBeDefined();
    expect(Scene).toBeTypeOf('function');
    expect(ClassicWebGLRenderer).toBeTypeOf('function');
    expect(Renderer).toBe(ClassicWebGLRenderer);
    expect(HostFrame).toBeTypeOf('function');
    expect(LumaDeviceRenderer).toBeTypeOf('function');
    expect(WebMercatorGlobeVisibilityAdapter).toBeTypeOf('function');
    expect(WebMercatorVisibilityAdapter).toBeTypeOf('function');
  });

  it('exports the deck.gl adapter surface', () => {
    expect(TangramLayer).toBe(NamedTangramLayer);
    expect(createTangramLayerClass).toBeTypeOf('function');
    expect(getExternalCameraFrame).toBeTypeOf('function');
    expect(getFirstPersonViewFrame).toBeTypeOf('function');
    expect(WebMercatorViewAdapter.getFrame).toBeTypeOf('function');
    expect(FirstPersonViewAdapter.getFrame).toBeTypeOf('function');
    expect(GlobeViewAdapter.getFrame).toBeTypeOf('function');
  });

  it('exports WebXR only from the experimental subpath', () => {
    expect(WebXRMapView).toBeTypeOf('function');
    expect(WebXRPresentation).toBeTypeOf('function');
  });

  it('exports the Zod style schema and generated JSON Schema', () => {
    expect(TangramStyleSheetSchema.safeParse({styles: {roads: {base: 'lines'}}}).success).toBe(
      true
    );
    expect(tangramStyleJsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(tangramStyleJsonSchema.$id).toContain('tangram-style.schema.json');
  });
});
