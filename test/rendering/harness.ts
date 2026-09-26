// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect} from 'vitest';
import {luma, type Device} from '@luma.gl/core';
import {webgl2Adapter} from '@luma.gl/webgl';
import {webgpuAdapter} from '@luma.gl/webgpu';
import {ClassicWebGLRenderer, type Scene} from '@vis.gl/tangram-renderer';
import {Timeline} from '@luma.gl/engine';
import {WebXRPresentation, WebXRMapView, WebXRGlobeView, WebXRFirstPersonView,
  WebXRMapController, WebXRGlobeController, WebXRFirstPersonController,
  type XRPresentationMode} from '@vis.gl/tangram-layers/experimental/webxr';
import {submitEyeRenderPass} from '../../examples/webxr/submit-eye.js';
import {createScene, createFixture} from './scene';

declare const __TEST_DEVICE__: 'webgl' | 'webgpu';

/** Backend selected by the CI matrix; unavailable devices fail the lane. */
export const DEVICE_TYPE = __TEST_DEVICE__;

/** View combinations covered by the GPU regression matrix. */
export type ViewKind = 'flat' | 'perspective' | 'globe' | 'first-person';

/** Match the examples' public view/controller configuration. */
export function createPresentation(kind: ViewKind, mode: XRPresentationMode = 'mono') {
  const controller = {dragPan: true, dragRotate: true, scrollZoom: true, touchZoom: true,
    touchRotate: true, keyboard: true, trackpadGesture: true, multiTouchDrag: 'rotate' as const};
  const view = kind === 'globe'
    ? new WebXRGlobeView({id: kind, controller: {...controller, type: WebXRGlobeController}})
    : kind === 'first-person'
      ? new WebXRFirstPersonView({id: kind, far: 20000,
        controller: {...controller, type: WebXRFirstPersonController}})
      : new WebXRMapView({id: kind, controller: {...controller, type: WebXRMapController}});
  return new WebXRPresentation({view, mode, viewState: {
    longitude: 0, latitude: kind === 'first-person' ? -0.0015 : 0,
    bearing: 0,
    pitch: kind === 'flat' || kind === 'globe' ? 0 : 45,
    ...(kind === 'first-person' ? {position: [0, 0, 200]} : {zoom: kind === 'globe' ? 4 : 15})
  }});
}

/** Narrow inspection surface for renderer readiness and deterministic shader time. */
type RuntimeScene = Scene & {
  view_complete: boolean;
  start_time: number;
  selection_feature_count: number;
  building: boolean;
  updating: number;
  tile_manager: {isLoadingVisibleTiles(): boolean; allVisibleTilesLabeled(): boolean};
  withWebGLContext(callback: () => void): void;
  getFeatureAt(pixel: {x: number; y: number}): Promise<{feature?: {properties?: {name?: string}}; error?: unknown} | undefined>;
};

/** Draws the real packaged renderer and worker, without a website or live tile service. */
export class RenderingHarness {
  readonly canvas = document.createElement('canvas');
  readonly errors: string[] = [];
  readonly sourceUrl: string;
  readonly presentation: WebXRPresentation;
  readonly timeline = new Timeline();
  readonly scale: number;
  interpupillaryDistance = 0.064;
  device!: Device;
  renderer!: ClassicWebGLRenderer;

  /** Create isolated scene data and logical state for each test. */
  constructor(kind: ViewKind = 'perspective', mode: XRPresentationMode = 'mono') {
    this.presentation = createPresentation(kind, mode);
    this.scale = kind === 'globe' ? 1000 : 1;
    this.sourceUrl = URL.createObjectURL(new Blob([JSON.stringify(createFixture(this.scale))],
      {type: 'application/json'}));
  }

  /** Create a real device and load the fixture through Tangram's scene worker. */
  async initialize() {
    await this.initializeDevice();
    this.presentation.attachController({element: this.canvas, timeline: this.timeline});
    const scene = createScene(this.sourceUrl, undefined, false, this.scale);
    this.renderer = ClassicWebGLRenderer.create(scene, {
      device: this.device, canvas: this.canvas, numWorkers: 1,
      continuousZoom: true, highDensityDisplay: false, logLevel: 'warn',
      ...(this.device.type === 'webgl' ? {webGLContext: this.device.handle} : {})
    });
    this.renderer.subscribe({error: message => this.errors.push(JSON.stringify(message))});
    await this.renderer.load(scene);
  }

  /** Create a real device, also reusable by the deck.gl integration cases. */
  async initializeDevice() {
    this.canvas.id = 'rendering-fixture';
    this.canvas.width = 512;
    this.canvas.height = 320;
    this.canvas.style.cssText = 'width:512px;height:320px;display:block;touch-action:none';
    document.body.append(this.canvas);
    this.device = await luma.createDevice({
      type: DEVICE_TYPE,
      adapters: [webgl2Adapter, webgpuAdapter],
      onError: error => { this.errors.push(error.message); },
      createCanvasContext: {canvas: this.canvas, useDevicePixels: false},
      webgl: {preserveDrawingBuffer: true, antialias: false, depth: true, stencil: true}
    });
    expect(this.device.type).toBe(DEVICE_TYPE);
    this.device.getDefaultCanvasContext().setDrawingBufferSize(512, 320);
  }

  /** Render both eyes before reading pixels, using the same submission path as the examples. */
  draw() {
    this.timeline.setTime(performance.now());
    this.presentation.updateTransitions();
    const frame = this.presentation.createFrame({width: this.canvas.width, height: this.canvas.height,
      interpupillaryDistance: this.interpupillaryDistance});
    for (const [index, view] of frame.renderViews.entries()) {
      this.renderer.setFrame(frame.hostFrame, {renderViewId: view.id});
      const renderPass = this.device.beginRenderPass({
        clearColor: index === 0 ? [0, 0, 0, 1] : false,
        clearDepth: index === 0 ? 1 : false,
        clearStencil: index === 0 ? 0 : false
      });
      const viewport = view.viewport!;
      renderPass.setParameters({
        viewport: [viewport.x || 0, viewport.y || 0, viewport.width, viewport.height],
        scissorRect: [viewport.x || 0, viewport.y || 0, viewport.width, viewport.height]
      });
      const render = () => {
        this.renderer.render({frame: frame.hostFrame, renderPass, renderViewId: view.id, force: true});
      };
      if (this.device.type === 'webgl') {
        (this.renderer.scene as RuntimeScene).withWebGLContext(render);
      } else {
        render();
      }
      submitEyeRenderPass(this.device, renderPass);
    }
  }

  /** Wait for real tile and shader work to finish; never substitute a mocked draw. */
  async settle() {
    await expect.poll(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      this.draw();
      expect(this.errors).toEqual([]);
      const scene = this.renderer.scene as RuntimeScene;
      return scene.view_complete && !scene.building && scene.updating === 0 &&
        !scene.tile_manager.isLoadingVisibleTiles() && scene.tile_manager.allVisibleTilesLabeled();
    }, {timeout: 15000, interval: 50}).toBe(true);
  }

  /** Exercise scene reload through the same public API used by the editor. */
  async reload(color: string, animated = false) {
    await this.renderer.load(createScene(this.sourceUrl, color, animated, this.scale));
    await this.settle();
  }

  /** Drive the asynchronous selection pass and worker response without a render loop. */
  async pick(x: number, y: number) {
    if (DEVICE_TYPE === 'webgl') {
      await expect.poll(() => (this.renderer.scene as RuntimeScene).selection_feature_count,
        {timeout: 5000}).toBeGreaterThan(0);
    }
    let complete = false;
    const pending = (this.renderer.scene as RuntimeScene).getFeatureAt({x, y}).then(result => {
      complete = true;
      return result;
    });
    await expect.poll(async () => {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      this.draw();
      return complete;
    }, {timeout: 5000}).toBe(true);
    return pending;
  }

  /** Exercise host-owned canvas resizing without recreating the renderer. */
  resize(width: number, height: number) {
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.device.getDefaultCanvasContext().setDrawingBufferSize(width, height);
  }

  /** Read the displayed GPU result through Chromium, on either rendering backend. */
  async pixels() {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    this.draw();
    return readCanvasPixels(this.canvas);
  }

  /** Dispose workers, GPU objects, and DOM after each case, including failed cases. */
  destroy() {
    this.presentation.finalize();
    this.renderer?.destroy();
    this.device?.destroy();
    this.canvas.remove();
    URL.revokeObjectURL(this.sourceUrl);
  }
}

/** Read native-resolution GPU output, independently of Vitest's scaled iframe. */
export async function readCanvasPixels(canvas: HTMLCanvasElement) {
  const screenshot = canvas.toDataURL('image/png');
  const bitmap = await createImageBitmap(await (await fetch(screenshot)).blob());
  const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = copy.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, copy.width, copy.height);
}

/** Compare eye images in their local pixel coordinates. */
export function eyeDifference(image: ImageData) {
  let count = 0;
  const half = image.width / 2;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < half; x++) {
      const left = (y * image.width + x) * 4;
      const right = left + half * 4;
      if ([0, 1, 2].some(channel => Math.abs(image.data[left + channel] - image.data[right + channel]) > 30)) count++;
    }
  }
  return count;
}

/** Count colorful pixels within a horizontal range to reject blank or missing eyes. */
export function coloredPixels(image: ImageData, start = 0, end = image.width) {
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = start; x < end; x++) {
      const offset = (y * image.width + x) * 4;
      const channels = image.data.subarray(offset, offset + 3);
      if (Math.max(...channels) - Math.min(...channels) > 40) count++;
    }
  }
  return count;
}

/** Count significant pixel changes, tolerating small rasterization noise. */
export function changedPixels(before: ImageData, after: ImageData, start = 0, end = before.width) {
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  let count = 0;
  for (let y = 0; y < before.height; y++) {
    for (let x = start; x < end; x++) {
      const offset = (y * before.width + x) * 4;
      if ([0, 1, 2].some(channel => Math.abs(before.data[offset + channel] - after.data[offset + channel]) > 30)) count++;
    }
  }
  return count;
}
