// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {Deck, type Layer, type LayerProps, MapView, FirstPersonView, _GlobeView as GlobeView} from '@deck.gl/core';
import {TangramLayer} from '@vis.gl/tangram-layers';
import {RenderingHarness, coloredPixels, readCanvasPixels, DEVICE_TYPE} from './harness';
import {createScene} from './scene';

let harness: RenderingHarness | undefined;
let deck: Deck<MapView | FirstPersonView | GlobeView> | undefined;
/** The generated layer bundle does not yet emit its dynamic subclass declaration. */
type FixtureLayerProps = {scene: ReturnType<typeof createScene>; onSceneError: (error: Error) => void};
const FixtureLayer = TangramLayer as unknown as new (properties: FixtureLayerProps & LayerProps) => Layer;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors || []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
  } finally {
    try {
      if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName || 'deck',
        harness.canvas.toDataURL('image/png'));
    } finally {
      deck?.finalize();
      deck = undefined;
      harness?.destroy();
      harness = undefined;
    }
  }
});

test.each(['flat', 'perspective', 'globe', 'first-person'] as const)(
  `${DEVICE_TYPE}: TangramLayer renders through deck.gl %s`, async kind => {
    harness = new RenderingHarness(kind);
    await harness.initializeDevice();
    const errors = harness.errors;
    const canvas = harness.canvas;
    const view = kind === 'globe' ? new GlobeView({id: kind})
      : kind === 'first-person' ? new FirstPersonView({id: kind, far: 20000}) : new MapView({id: kind});
    deck = new Deck({
      canvas, device: harness.device, width: 512, height: 320, useDevicePixels: false,
      views: view, initialViewState: harness.presentation.getViewState(),
      _animate: true,
      onError: error => {errors.push(error.message);},
      layers: [new FixtureLayer({
        id: 'fixture', scene: createScene(harness.sourceUrl, undefined, false, harness.scale),
        onSceneError: (error: Error) => errors.push(error.message)
      })]
    });
    await expect.poll(async () => {
      expect(errors).toEqual([]);
      return coloredPixels(await readCanvasPixels(canvas));
    }, {timeout: 15000, interval: 100}).toBeGreaterThan(100);
  }
);
