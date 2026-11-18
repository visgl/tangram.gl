// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// A small seeded syllable name generator.

import {hashInts, mulberry32} from './noise';

const ONSETS = ['b', 'br', 'c', 'd', 'dr', 'f', 'g', 'gr', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 'st', 't', 'th', 'v', 'w', 'z', ''];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'o', 'ae', 'ia', 'ou', 'y'];
const CODAS = ['', '', '', 'n', 'r', 'l', 's', 'th', 'm', 'nd', 'rk', 'st'];
const ENDINGS = ['', '', 'a', 'or', 'en', 'is', 'ar', 'heim', 'mouth', 'ford', 'wick', 'port', 'grad', 'ia', 'um'];

/** Kinds of names; each kind draws from its own sequence of the seed. */
export const NAME_KIND = {town: 1, river: 2, sea: 3, peak: 4, lake: 5} as const;

/** A name for the `index`-th feature of a kind in the world of `seed`. ASCII only. */
export function makeName(seed: number, kind: number, index: number): string {
  const rng = mulberry32(hashInts(seed, kind, index));
  const pick = <T>(list: readonly T[]) => list[Math.floor(rng() * list.length)];
  const syllables = 1 + Math.floor(rng() * 2.2);
  let name = '';
  for (let i = 0; i < syllables; i++) {
    name += pick(ONSETS) + pick(VOWELS) + (i === syllables - 1 ? pick(CODAS) : '');
  }
  if (kind === NAME_KIND.town) name += pick(ENDINGS);
  if (name.length < 3) name += pick(['dor', 'vel', 'ran']);
  return name[0].toUpperCase() + name.slice(1);
}
