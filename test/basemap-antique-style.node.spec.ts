// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {validateStyleMin} from '@maplibre/maplibre-gl-style-spec';
import {PNG} from 'pngjs';
import {describe, expect, test} from 'vitest';
import {
  ANTIQUE_STYLE_ASSETS,
  ASSET_PREFIX,
  ASSET_URLS,
  resolveAssetUrl
} from '../examples/layers/basemap-antique-style/antique-assets';
import {
  ANTIQUE_PALETTE,
  PATTERN_NAMES,
  getAntiquePalette,
  getAntiqueStyle,
  saturateColor
} from '../examples/layers/basemap-antique-style/antique-style';

type SpriteIndex = Record<string, {x: number; y: number; width: number; height: number; pixelRatio: number}>;

const ASSETS = new URL('../examples/layers/basemap-antique-style/assets/', import.meta.url);
const readSprite = (suffix: string) => ({
  index: JSON.parse(readFileSync(new URL(`sprite${suffix}.json`, ASSETS), 'utf8')) as SpriteIndex,
  png: PNG.sync.read(readFileSync(new URL(`sprite${suffix}.png`, ASSETS)))
});

const style = getAntiqueStyle(ANTIQUE_PALETTE, ANTIQUE_STYLE_ASSETS);

/** Every value of a paint or layout property in the style, by property name. */
function getPropertyValues(name: string): unknown[] {
  return style.layers.flatMap(layer => {
    const properties = {...('paint' in layer ? layer.paint : {}), ...('layout' in layer ? layer.layout : {})};
    return name in properties ? [(properties as Record<string, unknown>)[name]] : [];
  });
}

describe('antique style', () => {
  test.each([0, 0.5, 1, 1.5])('is a valid MapLibre style at saturation %s', saturation => {
    const errors = validateStyleMin(getAntiqueStyle(getAntiquePalette(saturation), ANTIQUE_STYLE_ASSETS));
    expect(errors.map(error => error.message)).toEqual([]);
  });

  test('uses only patterns that both sprites have', () => {
    const patterns = new Set(getPropertyValues('fill-pattern'));
    expect([...patterns].sort()).toEqual([...PATTERN_NAMES].sort());
    for (const suffix of ['', '@2x']) {
      const {index} = readSprite(suffix);
      expect(Object.keys(index).sort(), suffix).toEqual([...PATTERN_NAMES].sort());
    }
  });

  test('has glyphs for every font stack it uses', () => {
    const stacks = new Set(getPropertyValues('text-font').map(value => (value as string[]).join(',')));
    expect(stacks.size).toBeGreaterThan(0);
    for (const stack of stacks) {
      for (const range of ['0-255', '256-511']) {
        const url = ANTIQUE_STYLE_ASSETS.glyphs
          .replace('{fontstack}', encodeURIComponent(stack))
          .replace('{range}', range);
        const resolved = resolveAssetUrl(url);
        expect(resolved.startsWith('file:'), url).toBe(true);
        expect(existsSync(fileURLToPath(resolved)), url).toBe(true);
      }
    }
  });

  test('maps every asset to a file', () => {
    for (const url of Object.values(ASSET_URLS)) {
      expect(existsSync(fileURLToPath(url)), url).toBe(true);
    }
    expect(resolveAssetUrl(`${ASSET_PREFIX}sprite@2x.json`)).toBe(ASSET_URLS['sprite@2x.json']);
    expect(resolveAssetUrl(`${ASSET_PREFIX}glyphs/Antique%20Serif%20Roman/8192-8447.pbf`)).toMatch(
      /^data:/
    );
    expect(() => resolveAssetUrl(`${ASSET_PREFIX}sprite.svg`)).toThrow();
    const tiles = 'https://tiles.openfreemap.org/planet';
    expect(resolveAssetUrl(tiles)).toBe(tiles);
  });
});

describe('sprite patterns', () => {
  /** The mean color difference between two pixels of the sprite, over RGBA. */
  const difference = (png: PNG, a: [number, number], b: [number, number]) => {
    let sum = 0;
    for (let channel = 0; channel < 4; channel++) {
      sum += Math.abs(
        png.data[(a[1] * png.width + a[0]) * 4 + channel] -
          png.data[(b[1] * png.width + b[0]) * 4 + channel]
      );
    }
    return sum / 4;
  };

  test.each(['', '@2x'])('tile without seams (sprite%s)', suffix => {
    const {index, png} = readSprite(suffix);
    for (const [name, image] of Object.entries(index)) {
      const {x, y, width, height} = image;
      // Across the wrap, the last column meets the first. Compare with the mean step between
      // two neighboring columns (and rows) inside the image.
      let seam = 0;
      let inside = 0;
      for (let row = 0; row < height; row++) {
        seam += difference(png, [x + width - 1, y + row], [x, y + row]);
        for (let column = 0; column < width - 1; column++) {
          inside += difference(png, [x + column, y + row], [x + column + 1, y + row]) / (width - 1);
        }
      }
      for (let column = 0; column < width; column++) {
        seam += difference(png, [x + column, y + height - 1], [x + column, y]);
        for (let row = 0; row < height - 1; row++) {
          inside += difference(png, [x + column, y + row], [x + column, y + row + 1]) / (height - 1);
        }
      }
      expect(seam / (width + height), name).toBeLessThanOrEqual((inside / (width + height)) * 2 + 1);
    }
  });
});

describe('saturateColor', () => {
  test('keeps colors at saturation 1', () => {
    for (const color of Object.values(ANTIQUE_PALETTE)) {
      expect(saturateColor(color, 1)).toBe(color);
    }
  });

  test('gives a sepia tone at saturation 0', () => {
    const [r, g, b] = [1, 3, 5].map(index =>
      parseInt(saturateColor(ANTIQUE_PALETTE.waterFill, 0).slice(index, index + 2), 16)
    );
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
});
