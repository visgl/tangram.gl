// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, beforeAll, expect, test} from 'vitest';
import {userEvent} from 'vitest/browser';
import {createCollapsibleInfoCard} from '../examples/deck/info-card.js';

let stylesheet: string;
const cleanups: (() => void)[] = [];

beforeAll(async () => {
  stylesheet = await (await fetch('/examples/deck/info-card.css?direct')).text();
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Use real styling and controls, without loading maps or external services. */
function createCard() {
  const root = document.createElement('div');
  root.innerHTML = `<style>${stylesheet}</style><aside id="controls" style="position:relative">
    <h1>Projected basemaps</h1><div class="info-tabs"><button>About</button></div>
    <section><input value="preserved"><select><option>Equal Earth</option><option>Albers</option></select></section>
    <section data-example-tab-panel="about" hidden>About this map</section></aside>`;
  document.body.append(root);
  const panel = root.querySelector('aside');
  if (!panel) throw new Error('Missing panel');
  cleanups.push(() => root.remove(), createCollapsibleInfoCard(panel));
  const button = panel.querySelector<HTMLButtonElement>('.info-card-toggle');
  if (!button) throw new Error('Missing disclosure');
  return {panel, button};
}

test('disclosure hides content but retains the title, control values and selected tab', async () => {
  const {panel, button} = createCard();
  const input = panel.querySelector('input');
  const select = panel.querySelector('select');
  const section = panel.querySelector('section');
  const about = panel.querySelector<HTMLElement>('[data-example-tab-panel="about"]');
  if (!input || !select || !section || !about) throw new Error('Missing controls');
  input.value = 'edited';
  select.value = 'Albers';
  expect(button.getAttribute('aria-expanded')).toBe('true');
  await userEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(button.getAttribute('aria-label')).toBe('Expand information panel');
  expect(getComputedStyle(section).display).toBe('none');
  const heading = panel.querySelector('h1');
  if (!heading) throw new Error('Missing title');
  expect(getComputedStyle(heading).display).not.toBe('none');
  expect(getComputedStyle(button).display).not.toBe('none');
  // A native button supports both keyboard activation keys.
  await userEvent.keyboard('{Enter}');
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(getComputedStyle(section).display).not.toBe('none');
  expect(input.value).toBe('edited');
  expect(select.value).toBe('Albers');
  expect(about.hidden).toBe(true);
  await userEvent.keyboard(' ');
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

test('cards are independent, initialize once, and release their DOM and listener on teardown', () => {
  const first = createCard(), second = createCard();
  const destroy = createCollapsibleInfoCard(first.panel);
  expect(first.panel.querySelectorAll('.info-card-toggle')).toHaveLength(1);
  first.button.click();
  expect(first.button.getAttribute('aria-expanded')).toBe('false');
  expect(second.button.getAttribute('aria-expanded')).toBe('true');
  destroy();
  destroy();
  first.button.click();
  expect(first.panel.hasAttribute('data-info-card')).toBe(false);
  expect(first.panel.classList.contains('info-card-collapsed')).toBe(false);
  expect(first.panel.querySelector('.info-card-toggle')).toBeNull();
  expect(first.panel.querySelectorAll('section')).toHaveLength(2);
  const destroyReplacement = createCollapsibleInfoCard(first.panel);
  cleanups.push(destroyReplacement);
  destroy();
  expect(first.panel.hasAttribute('data-info-card')).toBe(true);
  expect(first.panel.querySelectorAll('.info-card-toggle')).toHaveLength(1);
});

test('missing cards are harmless for canvas-only hero rendering', () => {
  expect(() => createCollapsibleInfoCard(null)()).not.toThrow();
  expect(() => createCollapsibleInfoCard(document.createElement('aside'))()).not.toThrow();
});
