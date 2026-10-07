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
    [rendererPackage, './style-schema', './dist/style-schema.js'],
    [rendererPackage, './tangram-style.schema.json', './dist/tangram-style.schema.json']
  ].map(([manifest, subpath, artifactPath]) => ({packageName: manifest.name, manifest, subpath, artifactPath})))
  ('tests the built artifact exported by $packageName $subpath', ({manifest, subpath, artifactPath}) => {
    const entry = manifest.exports[subpath];
    expect(typeof entry === 'string' ? entry : entry.import).toBe(artifactPath);
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
