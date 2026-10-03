// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import Tangram, {type Scene, type SceneDefinition} from '@vis.gl/tangram-renderer';
import {changedPixels, DEVICE_TYPE, readCanvasPixels} from './harness';

/** Classic scene inspection needed to drive its render loop without Leaflet or public services. */
type ClassicScene = Scene & {
  canvas: HTMLCanvasElement;
  view_complete: boolean;
  view: {setView(state: {lng: number; lat: number; zoom: number}): void};
  styles: Record<string, {program: {compiled: boolean}}>;
  update(options: {force: boolean}): void;
  processTasks(): void;
};

let scene: ClassicScene | undefined;
let container: HTMLDivElement | undefined;
const errors: string[] = [];
beforeEach(async () => {
  errors.length = 0;
  await commands.startRenderingDiagnostics();
});
afterEach(async () => {
  try {
    expect(errors).toEqual([]);
    expect(await commands.renderingDiagnostics()).toEqual([]);
  } finally {
    scene?.destroy();
    container?.remove();
    scene = undefined;
    container = undefined;
  }
});

/** Wait for the packaged worker, shader compiler and actual classic draw to finish. */
async function settleScene() {
  await expect.poll(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    scene!.update({force: true});
    scene!.processTasks();
    expect(errors).toEqual([]);
    return scene!.view_complete;
  }, {timeout: 15000}).toBe(true);
}

/** Build each endpoint independently, keeping the comparison at one fixed classic camera. */
async function loadEndpoint(definition: SceneDefinition) {
  scene?.destroy();
  scene = Tangram.Scene.create(definition, {container, disableRenderLoop: true, numWorkers: 1,
    highDensityDisplay: false, webGLContextOptions: {preserveDrawingBuffer: true}}) as ClassicScene;
  scene.subscribe({error: event => errors.push(JSON.stringify(event))});
  scene.view.setView({lng: -96, lat: 39, zoom: 4});
  await scene.load();
  await settleScene();
  return readCanvasPixels(scene.canvas);
}

test.runIf(DEVICE_TYPE === 'webgl')('Albers compiles both morphing styles and visibly changes the national map', async () => {
  container = document.createElement('div');
  container.style.cssText = 'position:relative;width:800px;height:500px';
  document.body.append(container);
  const sceneUrl = new URL('/examples/classic/styles/projection-morph.yaml', window.location.href).href;
  const albers = await loadEndpoint(sceneUrl);
  // The national outline must be visible, not just a blank street-level crop.
  let bluePixels = 0;
  for (let offset = 0; offset < albers.data.length; offset += 4) {
    if (albers.data[offset + 2] > albers.data[offset] + 40) bluePixels++;
  }
  expect(bluePixels).toBeGreaterThan(10000);
  for (const name of ['projection-morph', 'state-borders']) {
    expect(scene!.styles[name].program.compiled).toBe(true);
  }
  // Force the other morph endpoint at the same camera to isolate projection from zoom scaling.
  const mercator = await loadEndpoint({import: sceneUrl,
    styles: {'albers-projection': {shaders: {defines: {ZOOM_START: -2, ZOOM_END: -1}}}}});
  expect(changedPixels(albers, mercator)).toBeGreaterThan(1000);
});
