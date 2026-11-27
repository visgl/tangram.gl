// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Draws the pattern sprite of the antique style: `node make-sprite.mjs` writes
// assets/sprite.{json,png} and assets/sprite@2x.{json,png}. Every image is a function of a
// position in a periodic square, so each image tiles without seams, and the @2x image is the same
// drawing at twice the resolution. A seeded random generator makes the output repeatable.

import {mkdirSync, writeFileSync} from 'node:fs';
import {PNG} from 'pngjs';

const OUTPUT = new URL('./assets/', import.meta.url);

/** Mulberry32: a small seeded generator, so that the sprite is the same on each run. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise on a lattice of `cells` x `cells` that wraps at the edges of the unit square. */
function createPeriodicNoise(cells, seed) {
  const random = createRandom(seed);
  const values = Array.from({length: cells * cells}, random);
  const at = (i, j) => values[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
  const fade = t => t * t * (3 - 2 * t);
  return (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = fade(x - i);
    const fy = fade(y - j);
    const top = at(i, j) * (1 - fx) + at(i + 1, j) * fx;
    const bottom = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
}

/** The distance from `a` to `b` on a circle of length `size`. */
function wrapDelta(a, b, size) {
  const delta = (((a - b) % size) + size) % size;
  return delta > size / 2 ? delta - size : delta;
}

const clamp01 = value => Math.min(1, Math.max(0, value));

/** Coverage of a pixel by a shape edge `distance` pixels away (negative inside), 1 px soft. */
const coverage = distance => clamp01(0.5 - distance);

const hex = value => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16) / 255);
const INK = hex('#4e3b28');
const BROWN = hex('#6b4f2a');
const OLIVE = hex('#55562c');
const GREEN = hex('#3f5a32');
const WHITE = hex('#fff6dc');

/**
 * The images. `size` is the side in pixels at pixel ratio 1; `draw(x, y, scale)` returns the
 * layers of a pixel, bottom first, as `[rgb, alpha]` pairs. `x` and `y` are in pixels of
 * the pixel ratio 1 image, so a drawing has the same shapes at each pixel ratio.
 */
const IMAGES = {
  // Paper: low-frequency blotches and fine fibres, as a light brown tint over the background color.
  paper: {
    size: 128,
    draw: (() => {
      const blotches = [createPeriodicNoise(3, 11), createPeriodicNoise(6, 12), createPeriodicNoise(12, 13)];
      const grain = createPeriodicNoise(64, 14);
      const fibres = createPeriodicNoise(32, 15);
      return (x, y) => {
        const u = x / 128;
        const v = y / 128;
        const blotch = 0.55 * blotches[0](u, v) + 0.3 * blotches[1](u, v) + 0.15 * blotches[2](u, v);
        const stain = 0.03 + 0.13 * clamp01((blotch - 0.45) / 0.3);
        const fibre = clamp01((fibres(u * 0.5 + v, v * 2) - 0.72) * 2.5) * 0.06;
        const speck = (grain(u, v) - 0.5) * 0.08;
        return [
          [BROWN, clamp01(stain + fibre + Math.max(0, speck))],
          [WHITE, clamp01(-speck)]
        ];
      };
    })()
  },
  // City blocks: a light cross-hatch in ink, darker on one diagonal than on the other.
  hatch: {
    size: 16,
    draw: (x, y, scale) => {
      const line = (offset, alpha) => {
        const distance = (Math.abs(wrapDelta(offset, 0, 8)) / Math.SQRT2) * scale;
        return [INK, alpha * coverage(distance - 0.35 * scale)];
      };
      return [line(x + y, 0.22), line(x - y, 0.12)];
    }
  },
  // Farmland: fine furrows that wobble a little, as if ruled by hand.
  furrows: {
    size: 16,
    draw: (x, y, scale) => {
      const wobble = 0.3 * Math.sin((2 * Math.PI * x) / 16);
      const distance = Math.abs(wrapDelta(y + wobble, 0, 4)) * scale;
      return [[OLIVE, 0.28 * coverage(distance - 0.3 * scale)]];
    }
  },
  // Orchards: a grid of small round trees.
  orchard: {
    size: 16,
    draw: (x, y, scale) => {
      const dx = wrapDelta(x, 4, 8);
      const dy = wrapDelta(y, 4, 8);
      const distance = Math.hypot(dx, dy) * scale;
      const radius = 1.7 * scale;
      return [
        [GREEN, 0.45 * coverage(distance - radius)],
        [INK, 0.6 * coverage(Math.abs(distance - radius) - 0.3 * scale)]
      ];
    }
  },
  // Woods: dense small crowns, each a green tint with an ink rim.
  wood: {
    size: 32,
    draw: (() => {
      const random = createRandom(21);
      // A jittered 4 x 4 grid spreads the crowns evenly; later rows overlap earlier ones.
      const crowns = Array.from({length: 16}, (_, index) => ({
        x: ((index % 4) + 0.2 + random() * 0.6) * 8,
        y: (Math.floor(index / 4) + 0.2 + random() * 0.6) * 8,
        radius: 2.6 + random() * 0.9
      }));
      return (x, y, scale) =>
        crowns.flatMap(crown => {
          const distance = Math.hypot(wrapDelta(x, crown.x, 32), wrapDelta(y, crown.y, 32)) * scale;
          const radius = crown.radius * scale;
          return [
            [GREEN, 0.6 * coverage(distance - radius)],
            [INK, 0.55 * coverage(Math.abs(distance - radius) - 0.3 * scale)]
          ];
        });
    })()
  },
  // Grass and meadows: sparse short strokes.
  meadow: {
    size: 24,
    draw: (() => {
      const random = createRandom(31);
      const tufts = Array.from({length: 5}, () => ({x: random() * 24, y: random() * 24}));
      return (x, y, scale) =>
        tufts.map(tuft => {
          const dx = Math.abs(wrapDelta(x, tuft.x, 24)) * scale;
          const dy = wrapDelta(y, tuft.y, 24);
          const along = Math.max(0, Math.abs(dy) - 1.2) * scale;
          return [OLIVE, 0.45 * coverage(Math.hypot(dx, along) - 0.3 * scale)];
        });
    })()
  }
};

/** Composites the layers of a pixel, each over the one before, into straight-alpha RGBA. */
function composite(layers) {
  let alpha = 0;
  const color = [0, 0, 0];
  for (const [rgb, layerAlpha] of layers) {
    const outAlpha = layerAlpha + alpha * (1 - layerAlpha);
    if (outAlpha <= 0) continue;
    for (let c = 0; c < 3; c++) {
      color[c] = (rgb[c] * layerAlpha + color[c] * alpha * (1 - layerAlpha)) / outAlpha;
    }
    alpha = outAlpha;
  }
  return [...color, alpha].map(value => Math.round(clamp01(value) * 255));
}

function writeSprite(pixelRatio) {
  const entries = Object.entries(IMAGES);
  const width = entries.reduce((sum, [, image]) => sum + image.size, 0) * pixelRatio;
  const height = Math.max(...entries.map(([, image]) => image.size)) * pixelRatio;
  const png = new PNG({width, height});
  png.data.fill(0);
  const index = {};
  let left = 0;
  for (const [name, image] of entries) {
    const side = image.size * pixelRatio;
    index[name] = {x: left, y: 0, width: side, height: side, pixelRatio};
    for (let row = 0; row < side; row++) {
      for (let column = 0; column < side; column++) {
        // Sample the pixel center, in pixels of the pixel ratio 1 image.
        const x = (column + 0.5) / pixelRatio;
        const y = (row + 0.5) / pixelRatio;
        const offset = (row * width + left + column) * 4;
        png.data.set(composite(image.draw(x, y, pixelRatio)), offset);
      }
    }
    left += side;
  }
  const suffix = pixelRatio === 1 ? '' : `@${pixelRatio}x`;
  writeFileSync(new URL(`sprite${suffix}.png`, OUTPUT), PNG.sync.write(png, {colorType: 6}));
  writeFileSync(new URL(`sprite${suffix}.json`, OUTPUT), `${JSON.stringify(index, null, 2)}\n`);
}

mkdirSync(OUTPUT, {recursive: true});
writeSprite(1);
writeSprite(2);
