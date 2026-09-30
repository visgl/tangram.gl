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
} from '@vis.gl/tangram-layers';
import Tangram, {
  ClassicWebGLRenderer,
  HostFrame,
  LumaDeviceRenderer,
  Renderer,
  Scene,
  WebMercatorGlobeVisibilityAdapter,
  WebMercatorVisibilityAdapter
} from '@vis.gl/tangram-renderer';
import {TangramStyleSheetSchema} from '@vis.gl/tangram-renderer/style-schema';
import tangramStyleJsonSchema from '@vis.gl/tangram-renderer/tangram-style.schema.json';
import {Renderer as CoreRenderer, HostFrame as CoreHostFrame} from '@vis.gl/tangram-renderer/core';
import {
  WebXRMapView,
  WebXRPresentation
} from '@vis.gl/tangram-layers/experimental/webxr';

describe('published package entrypoints', () => {
  it('exposes a working host-only core while preserving the classic root', () => {
    const renderer = new CoreRenderer({});
    expect(renderer.scene.view.camera_mode).toBe('external');
    expect(CoreHostFrame).toBeTypeOf('function');
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
