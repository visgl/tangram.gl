// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {processBidirectionalText} from '@tangram.gl/map-utils/text/explicit';

const lookup = vi.hoisted(() => ({paragraphReads: 0}));

vi.mock('bidi-js', async importOriginal => {
  const {default: createBidi} = await importOriginal<typeof import('bidi-js')>();
  return {
    default: () => {
      const bidi = createBidi();
      return {
        ...bidi,
        getEmbeddingLevels: (...args: Parameters<typeof bidi.getEmbeddingLevels>) => {
          const result = bidi.getEmbeddingLevels(...args);
          // Count indexed reads, including native array searches, without changing the data.
          const paragraphs = new Proxy(result.paragraphs, {
            get(target, key, receiver) {
              if (typeof key === 'string' && /^\d+$/.test(key)) lookup.paragraphReads++;
              return Reflect.get(target, key, receiver);
            }
          });
          return {...result, paragraphs};
        }
      };
    }
  };
});

test('looks up paragraph levels in one pass, without rescanning for every line', () => {
  const count = 2048;
  const paragraphs = Array.from({length: count}, (_, index) => index % 2 ? 'تشاد' : 'Chad');
  lookup.paragraphReads = 0;
  const lines = processBidirectionalText(paragraphs.join('\n'), []);
  expect(lines.map(line => line.trim())).toEqual(
    paragraphs.map(paragraph => paragraph === 'Chad' ? paragraph : 'داشت')
  );
  expect(lookup.paragraphReads).toBeGreaterThanOrEqual(count);
  // A forward cursor needs only a few reads per paragraph; a per-line find needs ~count²/2.
  expect(lookup.paragraphReads).toBeLessThanOrEqual(6 * count);
});
