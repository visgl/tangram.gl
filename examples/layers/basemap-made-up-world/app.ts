// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {CustomPanel, applyPanelTheme} from '@deck.gl-community/panels';
import {BoxPanelWidget} from '@deck.gl-community/widgets';
import {
  Deck,
  MapView,
  PostProcessEffect,
  type MapViewState,
  type Widget,
  type WidgetProps
} from '@deck.gl/core';
import {
  BasemapLayer,
  registerBasemapProtocol,
  unregisterBasemapProtocol
} from '@tangram.gl/basemap-layers';
import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {DEFAULT_PAPER_PROPS, antiquePaper} from './antique-effect';
import {ANTIQUE_STYLE_ASSETS, ASSET_SCHEME, antiqueAssetHandler} from './style-assets';
import {getAntiquePalette, getWorldStyle} from './world-style';
import {WORLD_SCHEME, createWorldProtocol, worldSourceUrl} from './world/protocol';

type BasemapLayerStyle = ConstructorParameters<typeof BasemapLayer>[0]['style'];

type Settings = {seed: number; sea: number; saturation: number; effect: boolean};

/** Reads the start settings from the page URL, so that each world can be linked to. */
function getStartSettings(): Settings & {longitude: number; latitude: number; zoom: number} {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const number = (name: string, fallback: number) => {
    const value = Number(params.get(name));
    return params.has(name) && Number.isFinite(value) ? value : fallback;
  };
  return {
    seed: number('seed', 42) >>> 0,
    sea: number('sea', 0),
    saturation: number('saturation', 1),
    effect: params.get('effect') !== 'off',
    longitude: number('lon', 0),
    latitude: number('lat', 10),
    zoom: number('zoom', 1.2)
  };
}

/**
 * Mounts the made-up world example: a world generated in the browser from a seed, served to
 * BasemapLayer through the `world://` protocol and drawn in the antique style.
 */
export function mountBasemapMadeUpWorldExample(container: HTMLElement): () => void {
  const settings = getStartSettings();
  let viewState: MapViewState = {
    longitude: settings.longitude,
    latitude: settings.latitude,
    zoom: settings.zoom,
    pitch: 0,
    bearing: 0,
    minZoom: 0,
    maxZoom: 13
  };

  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden;background:#d9c9a0;';
  container.appendChild(root);
  applyPanelTheme(root, EXAMPLE_PANEL_STYLE);

  // The protocols: the generated world and the style's assets.
  const errors = new Set<string>();
  const status = document.createElement('div');
  const showError = (message: string) => {
    errors.add(message);
    renderStatus();
  };
  const world = createWorldProtocol();
  registerBasemapProtocol(WORLD_SCHEME, async (request, abortController) => {
    try {
      return await world.handler(request, abortController);
    } catch (error) {
      if (!abortController.signal.aborted) showError(String(error));
      throw error;
    }
  });
  registerBasemapProtocol(ASSET_SCHEME, antiqueAssetHandler);

  // Controls.
  const controls = document.createElement('div');
  controls.style.cssText = 'display:grid;gap:8px;font:inherit;';
  const field = (label: string, input: HTMLElement) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:grid;gap:4px;';
    row.append(label, input);
    controls.append(row);
    return input;
  };
  const slider = (min: number, max: number, step: number, value: number) => {
    const input = document.createElement('input');
    Object.assign(input, {type: 'range', min: String(min), max: String(max), step: String(step)});
    input.value = String(value);
    return input;
  };
  const seedRow = document.createElement('div');
  seedRow.style.cssText = 'display:flex;gap:6px;';
  const seedInput = document.createElement('input');
  Object.assign(seedInput, {type: 'number', min: '0', step: '1', value: String(settings.seed)});
  seedInput.style.cssText = 'flex:1;min-width:0;font:inherit;color:#222;background:white;';
  const randomButton = document.createElement('button');
  randomButton.type = 'button';
  randomButton.textContent = 'Random';
  randomButton.style.cssText = 'font:inherit;';
  seedRow.append(seedInput, randomButton);
  field('Seed', seedRow);
  const seaInput = field('Sea level', slider(-0.4, 0.4, 0.02, settings.sea)) as HTMLInputElement;
  const saturationInput = field(
    'Saturation: muted ← → vivid',
    slider(0, 1.5, 0.05, settings.saturation)
  ) as HTMLInputElement;
  const effectRow = document.createElement('label');
  effectRow.style.cssText = 'display:flex;gap:6px;align-items:center;';
  const effectInput = document.createElement('input');
  effectInput.type = 'checkbox';
  effectInput.checked = settings.effect;
  effectRow.append(effectInput, 'Paper effect');
  controls.append(effectRow);
  status.setAttribute('role', 'status');
  status.style.cssText = 'font-size:12px;white-space:pre-wrap;';
  controls.append(status);

  function renderStatus() {
    const times = [...world.stats.tileMs].sort((a, b) => a - b);
    const quantile = (q: number) =>
      times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1) : '-';
    const worldMs = world.stats.worldMs.at(-1);
    const lines = [
      `Tiles generated: ${world.stats.generated}, median ${quantile(0.5)} ms, p95 ${quantile(0.95)} ms`,
      `World build: ${worldMs === undefined ? '-' : Math.round(worldMs)} ms per worker`,
      ...[...errors].slice(-3)
    ];
    status.textContent = lines.join('\n');
  }
  renderStatus();
  const statusTimer = setInterval(renderStatus, 500);

  const panelWidget = new BoxPanelWidget({
    id: 'made-up-world-controls',
    title: 'A made-up world',
    placement: 'top-left',
    widthPx: 260,
    offsetPx: 12,
    collapsible: true,
    style: EXAMPLE_PANEL_STYLE,
    panel: new CustomPanel({
      id: 'made-up-world-settings',
      title: '',
      onRenderHTML(element) {
        element.append(controls);
        return () => controls.remove();
      }
    })
  });

  // A new seed or sea level is a new source URL, so a new source. A new saturation changes only
  // paint properties.
  const getBasemapLayer = () =>
    new BasemapLayer({
      id: 'made-up-world',
      // MapLibre's style type and BasemapLayer's style type describe the same JSON in two ways.
      style: getWorldStyle(
        getAntiquePalette(Number(saturationInput.value)),
        ANTIQUE_STYLE_ASSETS,
        worldSourceUrl(Number(seedInput.value) >>> 0, Number(seaInput.value))
      ) as unknown as BasemapLayerStyle
    });
  const getEffects = () =>
    effectInput.checked ? [new PostProcessEffect(antiquePaper, DEFAULT_PAPER_PROPS)] : [];

  const deck = new Deck<MapView>({
    parent: root,
    widgets: [panelWidget as unknown as Widget<WidgetProps, MapView>],
    views: new MapView({repeat: true}),
    viewState,
    controller: true,
    layers: [getBasemapLayer()],
    effects: getEffects(),
    onViewStateChange: ({viewState: next}) => {
      viewState = next as MapViewState;
      deck.setProps({viewState});
    },
    onError: error => showError(String(error))
  });

  const updateLayer = () => deck.setProps({layers: [getBasemapLayer()]});
  const onRandom = () => {
    seedInput.value = String(Math.floor(Math.random() * 2 ** 31));
    updateLayer();
  };
  const onEffect = () => deck.setProps({effects: getEffects()});
  seedInput.addEventListener('change', updateLayer);
  randomButton.addEventListener('click', onRandom);
  seaInput.addEventListener('change', updateLayer);
  saturationInput.addEventListener('change', updateLayer);
  effectInput.addEventListener('change', onEffect);

  return () => {
    clearInterval(statusTimer);
    seedInput.removeEventListener('change', updateLayer);
    randomButton.removeEventListener('click', onRandom);
    seaInput.removeEventListener('change', updateLayer);
    saturationInput.removeEventListener('change', updateLayer);
    effectInput.removeEventListener('change', onEffect);
    deck.finalize();
    unregisterBasemapProtocol(WORLD_SCHEME);
    unregisterBasemapProtocol(ASSET_SCHEME);
    world.destroy();
    root.remove();
  };
}
