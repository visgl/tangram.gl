// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {commands} from 'vitest/browser';
import {VIEWPORT} from './scenes';

const OUTPUT_DIRECTORY = 'modules/basemap-layers/test/reference-render/__output__';

/**
 * Writes renders side by side, MapLibre GL JS's first, to `__output__/<name>.png`, and the
 * measured values to `__output__/<name>.json`.
 */
export async function writeComparison(
  name: string,
  renders: Uint8ClampedArray[],
  measured: unknown
): Promise<void> {
  const {width, height} = VIEWPORT;
  const canvas = document.createElement('canvas');
  canvas.width = width * renders.length;
  canvas.height = height;
  const context = canvas.getContext('2d')!;
  renders.forEach((pixels, index) => {
    const image = new ImageData(new Uint8ClampedArray(pixels), width, height);
    context.putImageData(image, width * index, 0);
  });
  const file = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  await commands.writeFile(
    `${OUTPUT_DIRECTORY}/${file}.png`,
    canvas.toDataURL('image/png').split(',')[1],
    'base64'
  );
  await commands.writeFile(`${OUTPUT_DIRECTORY}/${file}.json`, JSON.stringify(measured, null, 2));
}
