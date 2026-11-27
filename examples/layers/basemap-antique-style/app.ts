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
import {BasemapLayer} from '@tangram.gl/basemap-layers';
import {Map as MapLibreMap, getWorkerUrl, setWorkerUrl} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {ANTIQUE_STYLE_ASSETS, createAssetFetch, resolveAssetUrl} from './antique-assets';
import {DEFAULT_PAPER_PROPS, antiquePaper} from './antique-effect';
import {getAntiquePalette, getAntiqueStyle} from './antique-style';

type BasemapLayerStyle = ConstructorParameters<typeof BasemapLayer>[0]['style'];

/** Three old harbour cities. */
export const CITIES = [
  {id: 'charleston', label: 'Charleston, South Carolina', longitude: -79.9335, latitude: 32.7795},
  {id: 'annapolis', label: 'Annapolis, Maryland', longitude: -76.4875, latitude: 38.9765},
  {id: 'valletta', label: 'Valletta, Malta', longitude: 14.5115, latitude: 35.8975}
] as const;

const CITY_ZOOM = 14.5;

type Settings = {
  city: (typeof CITIES)[number]['id'];
  effect: boolean;
  saturation: number;
  grain: number;
  compare: boolean;
};

/** Reads the start settings from the page URL, so that each state can be linked to. */
function getStartSettings(): Settings & {zoom: number} {
  const params = new URLSearchParams(globalThis.location?.search ?? '');
  const number = (name: string, fallback: number) => {
    const value = Number(params.get(name));
    return params.has(name) && Number.isFinite(value) ? value : fallback;
  };
  const city = CITIES.find(entry => entry.id === params.get('city'))?.id ?? 'charleston';
  return {
    city,
    effect: params.get('effect') !== 'off',
    saturation: number('saturation', 1),
    grain: number('grain', DEFAULT_PAPER_PROPS.grain),
    compare: params.get('compare') === 'on',
    zoom: number('zoom', CITY_ZOOM)
  };
}

/** Mounts the antique style example: BasemapLayer with a paper effect, and MapLibre beside it. */
export function mountBasemapAntiqueStyleExample(container: HTMLElement): () => void {
  const settings = getStartSettings();
  const startCity = CITIES.find(city => city.id === settings.city)!;
  let viewState: MapViewState = {
    longitude: startCity.longitude,
    latitude: startCity.latitude,
    zoom: settings.zoom,
    pitch: 0,
    bearing: 0,
    minZoom: 2,
    maxZoom: 19
  };

  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;display:flex;background:#d9c9a0;';
  container.appendChild(root);
  const deckPane = document.createElement('div');
  deckPane.style.cssText = 'position:relative;flex:1;min-width:0;overflow:hidden;';
  const mapPane = document.createElement('div');
  mapPane.style.cssText =
    'position:relative;flex:1;min-width:0;overflow:hidden;box-shadow:inset 2px 0 #4e3b28;';
  root.append(deckPane, mapPane);
  applyPanelTheme(deckPane, EXAMPLE_PANEL_STYLE);
  applyPanelTheme(mapPane, EXAMPLE_PANEL_STYLE);
  const mapLabel = document.createElement('div');
  mapLabel.textContent = 'MapLibre GL JS · same style, no effect';
  mapLabel.style.cssText =
    'position:absolute;top:12px;left:12px;z-index:2;background:var(--menu-background);color:var(--menu-text);padding:6px 10px;border-radius:4px;pointer-events:none;';
  const mapHost = document.createElement('div');
  mapHost.style.cssText = 'position:absolute;inset:0;';
  mapPane.append(mapHost, mapLabel);

  const attribution = document.createElement('div');
  attribution.style.cssText =
    'position:absolute;bottom:0;right:0;z-index:2;background:var(--menu-background);color:var(--menu-text);padding:2px 5px;font-size:11px;';
  attribution.innerHTML =
    '<a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a> · © <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> · © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>';
  for (const link of attribution.querySelectorAll('a')) link.style.color = 'inherit';
  deckPane.appendChild(attribution);

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
  const checkbox = (label: string, checked: boolean) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = checked;
    row.append(input, label);
    controls.append(row);
    return input;
  };
  const slider = (min: number, max: number, step: number, value: number) => {
    const input = document.createElement('input');
    Object.assign(input, {type: 'range', min: String(min), max: String(max), step: String(step)});
    input.value = String(value);
    return input;
  };
  const citySelect = document.createElement('select');
  citySelect.style.cssText = 'font:inherit;color:#222;background:white;padding:4px;';
  for (const city of CITIES) {
    citySelect.append(new Option(city.label, city.id, false, city.id === settings.city));
  }
  field('City', citySelect);
  const effectInput = checkbox('Paper effect (deck.gl only)', settings.effect);
  const saturationInput = field(
    'Saturation: muted ← → vivid',
    slider(0, 1.5, 0.05, settings.saturation)
  ) as HTMLInputElement;
  const grainInput = field('Paper grain', slider(0, 0.1, 0.005, settings.grain)) as HTMLInputElement;
  const compareInput = checkbox('Compare with MapLibre GL JS', settings.compare);
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.style.cssText = 'font-size:12px;color:#ffb4a0;white-space:pre-wrap;';
  controls.append(status);
  const errors = new Set<string>();
  const showError = (message: string) => {
    errors.add(message);
    status.textContent = [...errors].slice(-3).join('\n');
  };

  const panelWidget = new BoxPanelWidget({
    id: 'antique-style-controls',
    title: 'Antique map style',
    placement: 'top-left',
    widthPx: 250,
    offsetPx: 12,
    collapsible: true,
    style: EXAMPLE_PANEL_STYLE,
    panel: new CustomPanel({
      id: 'antique-style-settings',
      title: '',
      onRenderHTML(element) {
        element.append(controls);
        return () => controls.remove();
      }
    })
  });

  // The style, generated from the color roles at the chosen saturation.
  const getStyle = () =>
    getAntiqueStyle(getAntiquePalette(Number(saturationInput.value)), ANTIQUE_STYLE_ASSETS);
  let style = getStyle();
  const loadOptions = {fetch: createAssetFetch(showError)};
  const getBasemapLayer = () =>
    new BasemapLayer({
      id: 'antique-basemap',
      // MapLibre's style type and BasemapLayer's style type describe the same JSON in two ways.
      style: style as unknown as BasemapLayerStyle,
      loadOptions
    });
  const getEffects = () =>
    effectInput.checked
      ? [
          new PostProcessEffect(antiquePaper, {
            ...DEFAULT_PAPER_PROPS,
            grain: Number(grainInput.value)
          })
        ]
      : [];

  // MapLibre 6's module worker needs an explicit URL after Vite/website bundling.
  const previousWorkerUrl = getWorkerUrl();
  const workerUrl = URL.createObjectURL(
    new Blob(['import "https://unpkg.com/maplibre-gl@6.4.1/dist/maplibre-gl-worker.mjs";'], {
      type: 'text/javascript'
    })
  );
  setWorkerUrl(workerUrl);
  let map: MapLibreMap | null = null;
  let syncingMap = false;
  const syncMapCamera = () => {
    if (!map) return;
    syncingMap = true;
    try {
      map.jumpTo({
        center: [viewState.longitude, viewState.latitude],
        zoom: viewState.zoom,
        bearing: viewState.bearing,
        pitch: viewState.pitch
      });
    } finally {
      syncingMap = false;
    }
  };

  let deck!: Deck<MapView>;
  const setViewState = (next: MapViewState) => {
    viewState = next;
    deck.setProps({viewState});
    syncMapCamera();
  };
  const updateCompare = () => {
    mapPane.style.display = compareInput.checked ? 'block' : 'none';
    if (compareInput.checked && !map) {
      map = new MapLibreMap({
        container: mapHost,
        style,
        center: [viewState.longitude, viewState.latitude],
        zoom: viewState.zoom,
        attributionControl: {compact: true},
        transformRequest: url => ({url: resolveAssetUrl(url)})
      });
      map.on('error', event => showError(`MapLibre: ${event.error?.message ?? 'error'}`));
      map.on('move', () => {
        if (syncingMap || !map) return;
        const center = map.getCenter();
        viewState = {
          ...viewState,
          longitude: center.lng,
          latitude: center.lat,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch()
        };
        deck.setProps({viewState});
      });
    } else if (!compareInput.checked && map) {
      map.remove();
      map = null;
    }
    map?.resize();
  };

  deck = new Deck<MapView>({
    parent: deckPane,
    widgets: [panelWidget as unknown as Widget<WidgetProps, MapView>],
    views: new MapView({repeat: true}),
    viewState,
    controller: true,
    layers: [getBasemapLayer()],
    effects: getEffects(),
    onViewStateChange: ({viewState: next}) => setViewState(next as MapViewState)
  });

  const onCity = () => {
    const city = CITIES.find(entry => entry.id === citySelect.value)!;
    setViewState({
      ...viewState,
      longitude: city.longitude,
      latitude: city.latitude,
      zoom: CITY_ZOOM,
      bearing: 0,
      pitch: 0
    });
  };
  const onEffect = () => deck.setProps({effects: getEffects()});
  const onSaturation = () => {
    style = getStyle();
    deck.setProps({layers: [getBasemapLayer()]});
    map?.setStyle(style);
  };
  citySelect.addEventListener('change', onCity);
  effectInput.addEventListener('change', onEffect);
  grainInput.addEventListener('input', onEffect);
  saturationInput.addEventListener('change', onSaturation);
  compareInput.addEventListener('change', updateCompare);
  const observer = new ResizeObserver(() => map?.resize());
  observer.observe(mapPane);
  updateCompare();

  return () => {
    observer.disconnect();
    citySelect.removeEventListener('change', onCity);
    effectInput.removeEventListener('change', onEffect);
    grainInput.removeEventListener('input', onEffect);
    saturationInput.removeEventListener('change', onSaturation);
    compareInput.removeEventListener('change', updateCompare);
    deck.finalize();
    map?.remove();
    if (getWorkerUrl() === workerUrl) setWorkerUrl(previousWorkerUrl);
    URL.revokeObjectURL(workerUrl);
    root.remove();
  };
}
