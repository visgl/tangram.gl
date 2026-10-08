// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, expect, test} from 'vitest';

let stylesheet: string;
beforeAll(async () => {stylesheet = await (await fetch('/website/src/css/custom.css?direct')).text();});

test.each(['projected', 'deck', 'webxr', 'classic'])('%s layout fills the content column as the viewport resizes', async kind => {
  for (const [width, height] of [[360, 420], [900, 700], [1400, 1200]]) {
    const frame = document.createElement('iframe');
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    const example = kind === 'projected' ? '<iframe class="projected-example-frame" title="Map"></iframe>' :
      kind === 'deck' ? '<div class="deck-example-embed"><div id="deck-container"></div></div>' :
      kind === 'webxr' ? '<div class="webxr-example-embed"><div id="webxr-container"></div></div>' :
      '<div class="classic-playground-embed"><div id="classic-playground-frame"></div></div>';
    frame.srcdoc = `<html class="plugin-id-examples"><style>
    :root {--ifm-navbar-height:60px;--ifm-color-emphasis-300:#ccc;font-size:16px} body {margin:0}
    .container {max-width:1140px} .col {max-width:75%}
    ${stylesheet}
  </style><main><div class="container"><div class="col">
    ${example}
  </div></div></main></html>`;
    const loaded = new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), {once: true}));
    document.body.append(frame);
    try {
      await loaded;
      const document = frame.contentDocument;
      if (!document) throw new Error('Missing layout frame');
      const canvas = document.querySelector<HTMLElement>('.projected-example-frame, #deck-container, #webxr-container, #classic-playground-frame');
      if (!canvas) throw new Error('Missing canvas frame');
      expect(canvas.getBoundingClientRect().width).toBe(kind === 'projected' ? width : width - 2);
      expect(canvas.getBoundingClientRect().height).toBe(Math.max(280, height - 60 - 64));
      // Taller viewports must not stop growing at the former 800px cap.
      if (height > 1000) expect(canvas.getBoundingClientRect().height).toBeGreaterThan(800);
    } finally {
      frame.remove();
    }
  }
});
