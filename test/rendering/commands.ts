// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {defineBrowserCommand} from '@vitest/browser-playwright';
import type {Page} from 'playwright';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

/** Per-page diagnostics also include requests made by scene workers. */
const diagnostics = new WeakMap<Page, string[]>();

/** Reject public network access and collect asynchronous browser/GPU errors. */
export const startRenderingDiagnostics = defineBrowserCommand(async ({page, context}) => {
  let errors = diagnostics.get(page);
  if (errors) {
    errors.length = 0;
    return;
  }
  errors = [];
  diagnostics.set(page, errors);
  const captured = errors;
  page.on('pageerror', error => captured.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') captured.push(message.text());
  });
  const allowedOrigin = new URL(page.url()).origin;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === allowedOrigin || ['blob:', 'data:'].includes(url.protocol)) {
      await route.continue();
    } else {
      captured.push(`Unexpected network request: ${url}`);
      await route.abort('blockedbyclient');
    }
  });
});

/** Return captured errors without discarding them. */
export const renderingDiagnostics = defineBrowserCommand(async ({page}) => diagnostics.get(page) || []);

/** Save full-resolution pixels and errors; Vitest's UI screenshot may be scaled. */
export const saveRenderingArtifact = defineBrowserCommand(async ({page}, name: string, image: string) => {
  const directory = join(process.cwd(), 'screenshots/rendering', process.env.TANGRAM_TEST_DEVICE || 'webgl');
  await mkdir(directory, {recursive: true});
  const stem = name.replace(/[^a-zA-Z0-9.-]/g, '_');
  await writeFile(join(directory, `${stem}.png`), Buffer.from(image.split(',')[1], 'base64'));
  await writeFile(join(directory, `${stem}.json`), JSON.stringify({errors: diagnostics.get(page) || []}, null, 2));
});

/** Send trusted browser mouse input through the same DOM path as real users. */
export const dragRenderingCanvas = defineBrowserCommand(async ({page, frame}, side: 'left' | 'right') => {
  const canvas = (await frame()).locator('#rendering-fixture');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Rendering canvas is not visible');
  const x = bounds.x + bounds.width * (side === 'left' ? 0.25 : 0.75);
  const y = bounds.y + bounds.height * 0.6;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + bounds.width * 0.06, y, {steps: 8});
  await page.mouse.up();
});

/** Model a trackpad wheel stream, distinct from discrete mouse-wheel ticks. */
export const panRenderingCanvas = defineBrowserCommand(async ({frame}, side: 'left' | 'right') => {
  await (await frame()).locator('#rendering-fixture').evaluate((canvas, eye) => {
    const bounds = canvas.getBoundingClientRect();
    for (let index = 0; index < 8; index++) {
      const event = new WheelEvent('wheel', {bubbles: true, cancelable: true,
        clientX: bounds.x + bounds.width * (eye === 'left' ? 0.25 : 0.75),
        clientY: bounds.y + bounds.height * 0.5, deltaX: 2.5, deltaY: 1.5});
      // Playwright mouse.wheel emits legacy wheelDelta=120 (a mouse tick).
      // Real precision trackpads use fractional pixel deltas, not that signal.
      Object.defineProperty(event, 'wheelDelta', {value: -4.5});
      canvas.dispatchEvent(event);
    }
  }, side);
});

/** Send a two-touch pinch with rotation through Chromium's touch input stack. */
export const pinchRenderingCanvas = defineBrowserCommand(async ({page, context, frame}) => {
  const bounds = await (await frame()).locator('#rendering-fixture').boundingBox();
  if (!bounds) throw new Error('Rendering canvas is not visible');
  const session = await context.newCDPSession(page);
  const centerX = bounds.x + bounds.width * 0.75;
  const centerY = bounds.y + bounds.height * 0.5;
  try {
    for (let step = 0; step <= 8; step++) {
      const angle = step * 0.045;
      const radius = bounds.width * (0.04 + step * 0.004);
      const touchPoints = [-1, 1].map((direction, id) => ({id,
        x: centerX + direction * radius * Math.cos(angle),
        y: centerY + direction * radius * Math.sin(angle)}));
      await session.send('Input.dispatchTouchEvent', {type: step === 0 ? 'touchStart' : 'touchMove', touchPoints});
    }
    await session.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  } finally {
    await session.detach();
  }
});

declare module 'vitest/browser' {
  interface BrowserCommands {
    startRenderingDiagnostics(): Promise<void>;
    renderingDiagnostics(): Promise<string[]>;
    saveRenderingArtifact(name: string, image: string): Promise<void>;
    dragRenderingCanvas(side: 'left' | 'right'): Promise<void>;
    panRenderingCanvas(side: 'left' | 'right'): Promise<void>;
    pinchRenderingCanvas(): Promise<void>;
  }
}
