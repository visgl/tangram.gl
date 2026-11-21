// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// The controls of the solar-system example, in plain DOM: an icon rail with four cards (one open
// at a time), a scenes menu, a key list, a time dock and a status readout. This file builds the
// elements and owns what is only user interface: which card is open, the menus, the keys, the
// marks on the time bar. scene/app.ts attaches the handlers that change the scene, by element id.
// index.html has the styles.

export type CardId = 'navigate' | 'layers' | 'space' | 'info';
type MenuId = 'scenes' | 'keys';
export const CARD_IDS: readonly CardId[] = ['navigate', 'layers', 'space', 'info'];

export type TimeMark = {
  /** Position on the time bar, 0 to 1. */
  fraction: number;
  kind: string;
  major: boolean;
  label: string;
};

export type PanelOptions = {
  speeds: readonly (readonly [number, string])[];
  /** Half-widths of the time bar, days. */
  spans: readonly (readonly [number, string])[];
  bodyGroups: readonly {label: string; bodies: readonly {id: string; label: string; color: readonly number[]}[]}[];
  scenes: readonly {id: string; label: string; hint: string}[];
  /** The card that is open at the start. */
  card: CardId | null;
  hud: boolean;
  onScene: (id: string) => void;
  onMark: (index: number) => void;
  onPlayPause: () => void;
  onSpeedStep: (direction: 1 | -1) => void;
  /** Esc: leaves the globe or the compare view; false if there is no view to leave. */
  onBack: () => boolean;
};

export type Panel = {
  openCard: (id: CardId | null) => void;
  card: () => CardId | null;
  setPlaying: (playing: boolean) => void;
  /** A control that does not apply now is disabled, with the reason. */
  setAvailable: (id: string, reason: string | null) => void;
  setMarks: (marks: readonly TimeMark[]) => void;
  setErrorCount: (count: number) => void;
  setHud: (text: string) => void;
};

const icon = (body: string, filled = false) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="${filled ? 'currentColor' : 'none'}" ` +
  `stroke="${filled ? 'none' : 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  navigate: icon('<circle cx="12" cy="12" r="3.5"/><ellipse cx="12" cy="12" rx="10" ry="4.2" transform="rotate(-24 12 12)"/>'),
  layers: icon('<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 17 9 5 9-5"/>'),
  space: icon('<path d="m11 3 1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9L11 3Z"/><path d="M18.5 15.5v5M16 18h5"/>'),
  info: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.4v.2"/>'),
  scenes: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3V9Z"/>'),
  play: icon('<path d="M8 5v14l11-7L8 5Z"/>', true),
  pause: icon('<rect x="6.5" y="5" width="4" height="14" rx="1"/><rect x="13.5" y="5" width="4" height="14" rx="1"/>', true),
  next: icon('<path d="M6 6v12l9-6-9-6Z"/><path d="M18 6v12"/>')
};
const CARD_TITLES: Record<CardId, string> = {navigate: 'Navigate', layers: 'Layers', space: 'Space', info: 'Info'};

const KEYS: [string, string][] = [
  ['Space', 'Play or pause'],
  ['[ and ]', 'Slower or faster'],
  ['1 to 4', 'Open or close a card'],
  ['Esc', 'Close a menu; go back to the system; close the card'],
  ['?', 'Show this list']
];

const toggle = (id: string, label: string) =>
  `<label class="row toggle" id="row-${id}"><input id="${id}" type="checkbox"><span>${label}</span><span class="why" id="why-${id}"></span></label>`;

function template(options: PanelOptions) {
  const railButton = (id: CardId, k: number) =>
    `<button class="rail-btn" id="rail-${id}" data-card="${id}" aria-label="${CARD_TITLES[id]}" aria-expanded="false" ` +
    `aria-controls="card-${id}" title="${CARD_TITLES[id]} (${k + 1})">${ICONS[id]}` +
    `${id === 'info' ? '<span class="badge" id="info-badge" hidden></span>' : ''}</button>`;
  const bodies = options.bodyGroups
    .map(
      group =>
        `<div class="group-label">${group.label}</div><div class="row wrap">${group.bodies
          .map(b => `<button class="body-btn" data-body="${b.id}"><i class="dot" style="background: rgb(${b.color.join(',')})"></i>${b.label}</button>`)
          .join('')}</div>`
    )
    .join('');
  return `
  <nav id="rail" aria-label="Controls">
    ${CARD_IDS.map(railButton).join('')}
    <span class="rail-sep" aria-hidden="true"></span>
    <button class="rail-btn" id="scenes-btn" aria-label="Scenes" aria-haspopup="menu" aria-expanded="false" aria-controls="scenes-menu" title="Scenes">${ICONS.scenes}</button>
    <button class="rail-btn" id="keys-btn" aria-label="Keyboard shortcuts" aria-expanded="false" aria-controls="keys-card" title="Keyboard shortcuts (?)"><b aria-hidden="true">?</b></button>
  </nav>
  <div id="cards">
    <section class="card" id="card-navigate" aria-label="Navigate" hidden>
      <h2>Navigate</h2>
      <div class="row">
        <button id="to-system" aria-pressed="false">System</button>
        <button id="to-compare" aria-pressed="false" title="Compare the Earth, the Moon and Mars">Compare</button>
      </div>
      <div id="globe-controls">
        <div class="row"><button id="back" aria-label="Back to the system">← Back</button><b id="globe-title"></b></div>
        <label class="row" id="link-row"><input id="linked" type="checkbox"><span>Linked rotation</span></label>
      </div>
      <div id="fly">${bodies}</div>
    </section>
    <section class="card" id="card-layers" aria-label="Layers" hidden>
      <h2>Layers</h2>
      <label class="row" id="row-surface"><span>Surface</span>
        <select id="surface"><option value="vector">Vector map</option><option value="imagery">Imagery</option></select>
        <span class="why" id="why-surface"></span></label>
      ${toggle('night', 'Night side')}
      ${toggle('shadows', 'Eclipse shadows')}
      ${toggle('corotate', 'Rotate with body')}
      ${toggle('clouds', 'Clouds')}
      ${toggle('atmosphere', 'Atmosphere')}
      <div id="overview-controls">
        <label class="row toggle" title="Log distances and enlarged bodies"><input id="readable" type="checkbox"><span>Readable scale</span></label>
      </div>
      <label class="row sep" title="Cloud ray-march steps and space-volume resolution"><span>Quality</span>
        <select id="quality"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
    </section>
    <section class="card" id="card-space" aria-label="Space" hidden>
      <h2>Space</h2>
      <label class="row toggle"><input id="sp-looks" type="checkbox"><span>Look volumes</span></label>
      <label class="row toggle"><input id="sp-corona" type="checkbox"><span>Corona</span></label>
      <label class="row toggle"><input id="sp-comet" type="checkbox"><span>Comet</span></label>
      <label class="row toggle"><input id="sp-gas" type="checkbox"><span>Gas clouds</span></label>
      <label class="row toggle"><input id="sp-dust" type="checkbox"><span>Dust</span></label>
      <label class="row sep"><span>Gas cloud</span>
        <select id="sp-cloud"><option value="baked">Baked 96³</option><option value="procedural">Procedural noise</option></select></label>
      <div class="note dim">Artistic: the three coloured gas clouds and the corona streamers. Measured models: corona density (Baumbach 1937), zodiacal dust profile (Kelsall et al. 1998, brightness scaled), comet orbit (JPL SBDB, two-body).</div>
      <div class="note" id="space-look"></div>
    </section>
    <section class="card" id="card-info" aria-label="Info" hidden>
      <h2>Info</h2>
      <div id="gravity" class="note"></div>
      <div id="sky" class="note"></div>
      <details id="notes-box"><summary>Notes</summary><div class="note" id="notes"></div></details>
      <div class="note" id="stats"></div>
      <div class="error" id="errors" role="status"></div>
    </section>
    <div class="card" id="scenes-menu" role="menu" aria-label="Scenes" hidden>
      <h2>Scenes</h2>
      ${options.scenes
        .map(s => `<button class="scene" role="menuitem" data-scene="${s.id}"><span>${s.label}</span><small>${s.hint}</small></button>`)
        .join('')}
    </div>
    <div class="card" id="keys-card" aria-label="Keyboard shortcuts" hidden>
      <h2>Keys</h2>
      <dl class="keys">${KEYS.map(([key, text]) => `<dt><kbd>${key}</kbd></dt><dd>${text}</dd>`).join('')}</dl>
      <div class="note dim">Marks on the time bar: <i class="mark solar-eclipse major"></i> solar eclipse,
        <i class="mark lunar-eclipse major"></i> lunar eclipse, <i class="mark comet-perihelion major"></i> comet perihelion. A small mark is a partial or penumbral eclipse.</div>
    </div>
  </div>
  <div id="hud">
    <span id="hud-text"></span>
    <button id="hud-toggle" aria-pressed="true" aria-label="Status readout" title="Show or hide the status readout"><i aria-hidden="true"></i></button>
  </div>
  <div id="dock" role="group" aria-label="Time">
    <div id="date-pop" hidden>
      <label>Date, UTC <input id="date" type="date"></label>
      <label>Time, UTC <input id="time" type="time"></label>
    </div>
    <div class="dock-group">
      <button id="play" class="icon-btn" aria-label="Play" aria-pressed="false" title="Play or pause (Space)">${ICONS.play}</button>
      <select id="speed" aria-label="Playback speed" title="Playback speed ([ and ])">${options.speeds
        .map(([value, label]) => `<option value="${value}">${label}</option>`)
        .join('')}</select>
      <button id="date-button" aria-expanded="false" aria-controls="date-pop" title="Set the date and time"><span id="date-label"></span></button>
      <button id="now" title="Go to the current time">Now</button>
    </div>
    <div class="dock-group scrub-group">
      <div id="scrub">
        <div id="marks"></div>
        <input id="offset" type="range" step="any" aria-label="Time, on a window around the base date">
      </div>
      <button id="next-event" class="icon-btn" aria-label="Go to the next event" title="Go to the next event">${ICONS.next}</button>
      <select id="span" aria-label="Width of the time bar" title="Width of the time bar">${options.spans
        .map(([value, label]) => `<option value="${value}">${label}</option>`)
        .join('')}</select>
    </div>
  </div>`;
}

export function createPanel(root: HTMLElement, options: PanelOptions): Panel {
  root.innerHTML = template(options);
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  let card: CardId | null = options.card;
  let menu: MenuId | null = null;
  let datePop = false;
  const menuElements: Record<MenuId, [button: string, element: string]> = {scenes: ['scenes-btn', 'scenes-menu'], keys: ['keys-btn', 'keys-card']};

  /** A menu shows in place of the card; the card comes back when the menu closes. */
  function sync() {
    for (const id of CARD_IDS) {
      $(`card-${id}`).hidden = menu !== null || card !== id;
      $(`rail-${id}`).setAttribute('aria-expanded', String(menu === null && card === id));
    }
    for (const id of Object.keys(menuElements) as MenuId[]) {
      $(menuElements[id][1]).hidden = menu !== id;
      $(menuElements[id][0]).setAttribute('aria-expanded', String(menu === id));
    }
    $('date-pop').hidden = !datePop;
    $('date-button').setAttribute('aria-expanded', String(datePop));
  }
  function openCard(id: CardId | null) {
    card = id;
    menu = null;
    sync();
  }
  function toggleMenu(id: MenuId) {
    menu = menu === id ? null : id;
    sync();
  }
  for (const id of CARD_IDS) $(`rail-${id}`).onclick = () => openCard(card === id && menu === null ? null : id);
  $('scenes-btn').onclick = () => toggleMenu('scenes');
  $('keys-btn').onclick = () => toggleMenu('keys');
  $('scenes-menu').addEventListener('click', event => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-scene]')?.dataset.scene;
    if (!id) return;
    menu = null;
    sync();
    options.onScene(id);
  });
  $('date-button').onclick = () => {
    datePop = !datePop;
    sync();
    if (datePop) $('date').focus();
  };
  $('marks').addEventListener('click', event => {
    const index = (event.target as HTMLElement).closest<HTMLElement>('[data-mark]')?.dataset.mark;
    if (index !== undefined) options.onMark(Number(index));
  });

  // The status readout.
  let hud = options.hud;
  const syncHud = () => {
    $('hud').classList.toggle('off', !hud);
    $('hud-toggle').setAttribute('aria-pressed', String(hud));
  };
  $('hud-toggle').onclick = () => {
    hud = !hud;
    syncHud();
  };
  syncHud();

  // The credit is one line; a click (or Enter) shows all of it. The dock stays above it.
  const credit = $('credit');
  credit.tabIndex = 0;
  credit.setAttribute('role', 'button');
  credit.setAttribute('aria-expanded', 'false');
  credit.title = 'Show or hide the full credits';
  const toggleCredit = () => credit.setAttribute('aria-expanded', String(credit.getAttribute('aria-expanded') !== 'true'));
  credit.onclick = toggleCredit;
  credit.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleCredit();
  };
  const sizes = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--credit-h', `${credit.offsetHeight}px`);
    document.documentElement.style.setProperty('--dock-h', `${$('dock').offsetHeight}px`);
  });
  sizes.observe(credit);
  sizes.observe($('dock'));

  // Keys. No key acts while a field has the focus; Space is left to a focused button.
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName ?? '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
    const k = CARD_IDS.findIndex((_, index) => event.key === String(index + 1));
    if (k >= 0) {
      openCard(card === CARD_IDS[k] && menu === null ? null : CARD_IDS[k]);
    } else if (event.key === ' ') {
      if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A' || target === credit) return;
      options.onPlayPause();
    } else if (event.key === '[' || event.key === ']') {
      options.onSpeedStep(event.key === ']' ? 1 : -1);
    } else if (event.key === '?') {
      toggleMenu('keys');
    } else if (event.key === 'Escape') {
      if (menu !== null || datePop) {
        menu = null;
        datePop = false;
        sync();
      } else if (!options.onBack()) {
        openCard(null);
      }
    } else {
      return;
    }
    event.preventDefault();
  });

  sync();
  return {
    openCard,
    card: () => card,
    setPlaying(playing) {
      const button = $('play');
      button.innerHTML = playing ? ICONS.pause : ICONS.play;
      button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      button.setAttribute('aria-pressed', String(playing));
    },
    setAvailable(id, reason) {
      const control = $<HTMLInputElement | HTMLSelectElement>(id);
      if (control.disabled === (reason !== null) && $(`why-${id}`).textContent === (reason ?? '')) return;
      control.disabled = reason !== null;
      $(`why-${id}`).textContent = reason ?? '';
      const row = $(`row-${id}`);
      row.classList.toggle('disabled', reason !== null);
      if (reason === null) row.removeAttribute('title');
      else row.title = reason;
    },
    setMarks(marks) {
      $('marks').innerHTML = marks
        .map(
          (mark, index) =>
            `<button class="mark ${mark.kind}${mark.major ? ' major' : ''}" data-mark="${index}" style="--f: ${mark.fraction.toFixed(5)}" ` +
            `title="${mark.label}" aria-label="Go to: ${mark.label}"></button>`
        )
        .join('');
    },
    setErrorCount(count) {
      const badge = $('info-badge');
      if (badge.hidden === (count === 0) && badge.textContent === String(count)) return;
      badge.hidden = count === 0;
      badge.textContent = String(count);
      $('rail-info').setAttribute('aria-label', count ? `Info, ${count} ${count === 1 ? 'error' : 'errors'}` : 'Info');
    },
    setHud(text) {
      if ($('hud-text').textContent !== text) $('hud-text').textContent = text;
    }
  };
}
