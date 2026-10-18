// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import {createBasemapBackground} from '../../examples/deck/basemap-background';
import {RenderingHarness, DEVICE_TYPE} from './harness';

let harness: RenderingHarness | undefined;
beforeEach(() => commands.startRenderingDiagnostics());
afterEach(async () => {
  try {
    expect(harness?.errors ?? []).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
    if (harness) await commands.saveRenderingArtifact(expect.getState().currentTestName ?? 'background', harness.canvas.toDataURL());
  } finally {harness?.destroy(); harness = undefined;}
});

test.each(['flat', 'globe'] as const)(`${DEVICE_TYPE}: %s courtyard holes reveal land, not the host clear color`, async kind => {
  harness = new RenderingHarness(kind);
  const span = 0.003 * harness.scale, hole = 0.001 * harness.scale;
  const geometry = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
    type: 'Polygon', coordinates: [
      [[-span, -span], [span, -span], [span, span], [-span, span], [-span, -span]],
      [[-hole, -hole], [-hole, hole], [hole, hole], [hole, -hole], [-hole, -hole]]
    ]
  }}]};
  const courtyard = {
    scene: {background: {color: '#f5f3ef'}},
    sources: {courtyard: {type: 'GeoJSON', url: `data:application/json,${encodeURIComponent(JSON.stringify(geometry))}`}},
    styles: {courtyard: {base: 'polygons', lighting: false}},
    layers: {courtyard: {data: {source: 'courtyard'}, draw: {courtyard: {order: 1, color: '#20d0b0'}}}}
  };
  await harness.initialize(courtyard); await harness.settle();
  const withoutBackground = await harness.pixels();
  const center = (160 * 512 + 256) * 4;
  expect(Array.from(withoutBackground.data.slice(center, center + 3))).toEqual([0, 0, 0]);

  const background = createBasemapBackground('#f5f3ef');
  await harness.renderer.load({...courtyard, sources: {...background.sources, ...courtyard.sources},
    styles: {...background.styles, ...courtyard.styles}, layers: {...background.layers, ...courtyard.layers}}, {blocking: false});
  await harness.settle();
  const withBackground = await harness.pixels();
  expect(Array.from(withBackground.data.slice(center, center + 3))).toEqual([245, 243, 239]);
  // Keep the actual polygon roof, including its hole; do not fill or retessellate it to hide black pixels.
  let roofPixels = 0;
  for (let offset = 0; offset < withBackground.data.length; offset += 4) {
    if (Math.abs(withBackground.data[offset] - 32) < 3 && Math.abs(withBackground.data[offset + 1] - 208) < 3 &&
      Math.abs(withBackground.data[offset + 2] - 176) < 3) roofPixels++;
  }
  expect(roofPixels).toBeGreaterThan(100);
});
