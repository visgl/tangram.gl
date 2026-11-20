// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The time-line events of the solar-system example, against Astronomy Engine's eclipse searches.

import {NextGlobalSolarEclipse, NextLunarEclipse, SearchGlobalSolarEclipse, SearchLunarEclipse} from 'astronomy-engine';
import {expect, test} from 'vitest';
import {findEclipses, findSkyEvents} from '../examples/layers/basemap-solar-system/celestial/events';

const MINUTE = 60000;
const utc = (iso: string) => new Date(iso);

test('findEclipses finds the 2024-04-08 total solar eclipse', () => {
  const events = findEclipses(utc('2024-04-01T00:00:00Z'), utc('2024-04-15T00:00:00Z'));
  expect(events.map(e => e.label)).toEqual(['Total solar eclipse']);
  expect(events[0].major).toBe(true);
  // Greatest eclipse 18:17 UTC.
  expect(Math.abs(events[0].date.getTime() - utc('2024-04-08T18:17:00Z').getTime())).toBeLessThan(10 * MINUTE);
});

test('findEclipses finds the 2025-03-14 total lunar eclipse', () => {
  const events = findEclipses(utc('2025-03-10T00:00:00Z'), utc('2025-03-20T00:00:00Z'));
  expect(events.map(e => e.label)).toEqual(['Total lunar eclipse']);
  // Greatest eclipse 06:59 UTC.
  expect(Math.abs(events[0].date.getTime() - utc('2025-03-14T06:59:00Z').getTime())).toBeLessThan(10 * MINUTE);
});

test('findEclipses agrees with the Astronomy Engine searches over ten years', () => {
  const from = utc('2020-01-01T00:00:00Z');
  const to = utc('2030-01-01T00:00:00Z');
  const started = performance.now();
  const events = findEclipses(from, to);
  const elapsed = performance.now() - started;
  const solar: {date: Date; kind: string}[] = [];
  for (let e = SearchGlobalSolarEclipse(from); e.peak.date < to; e = NextGlobalSolarEclipse(e.peak)) {
    solar.push({date: e.peak.date, kind: e.kind});
  }
  const lunar: {date: Date; kind: string}[] = [];
  for (let e = SearchLunarEclipse(from); e.peak.date < to; e = NextLunarEclipse(e.peak)) {
    lunar.push({date: e.peak.date, kind: e.kind});
  }
  const mine = (kind: string) => events.filter(e => e.kind === kind);
  expect(mine('solar-eclipse').length).toBe(solar.length);
  expect(mine('lunar-eclipse').length).toBe(lunar.length);
  mine('solar-eclipse').forEach((event, k) => {
    expect(Math.abs(event.date.getTime() - solar[k].date.getTime())).toBeLessThan(15 * MINUTE);
    // Astronomy Engine: 'partial', 'annular', 'total' (a hybrid eclipse is total at its peak).
    expect(event.label.toLowerCase()).toContain(solar[k].kind);
  });
  mine('lunar-eclipse').forEach((event, k) => {
    expect(Math.abs(event.date.getTime() - lunar[k].date.getTime())).toBeLessThan(15 * MINUTE);
    expect(event.label.toLowerCase()).toContain(lunar[k].kind);
  });
  expect(events.map(e => e.date.getTime())).toEqual([...events.map(e => e.date.getTime())].sort((a, b) => a - b));
  // The panel runs a search of this size between frames.
  console.log(`findEclipses, 10 years: ${elapsed.toFixed(0)} ms, ${events.length} events`);
});

test('findSkyEvents adds the perihelion of the comet inside the range only', () => {
  const inside = findSkyEvents(utc('2020-07-01T00:00:00Z'), utc('2020-07-04T00:00:00Z'));
  expect(inside.filter(e => e.kind === 'comet-perihelion').length).toBe(1);
  const outside = findSkyEvents(utc('2021-07-01T00:00:00Z'), utc('2021-07-04T00:00:00Z'));
  expect(outside.filter(e => e.kind === 'comet-perihelion').length).toBe(0);
});
