// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, type Color, type PickingInfo} from '@deck.gl/core';
import {GeoJsonLayer} from '@deck.gl/layers';
import {
  BasemapLayer,
  type BasemapFeatureState,
  type BasemapPickedFeature
} from '@tangram.gl/basemap-layers';

import {createInfoCard, type InfoCardContent} from './info-card';
import {createControlPanel, type LayerPosition} from './panel';
import {
  isSamePicked,
  type Picked,
  type TractFeature,
  type TractProperties
} from './picked';
import {
  fetchStyle,
  getStylePositions,
  splitStyleAt,
  withFeatureStateHighlight,
  type StyleDocument,
  type StyleLayer
} from './style-layers';

/** The basemap styles: the first one is the initial style. */
const STYLES = [
  {label: 'OpenFreeMap Positron', value: 'https://tiles.openfreemap.org/styles/positron'},
  {label: 'OpenFreeMap Liberty', value: 'https://tiles.openfreemap.org/styles/liberty'}
];
const TRACTS_URL = new URL('./manhattan-census-tracts.geojson', import.meta.url).href;

const DATA_LAYER_ID = 'census-tracts';
/** The position that draws the data layer after every basemap layer. */
const TOP = '(top)';
const HIGHLIGHT_COLORS = {hover: '#00b4ff', selected: '#2536e8'};
const DATA_HOVER_COLOR: number[] = [0, 180, 255, 140];
const DATA_SELECTED_COLOR: Color = [37, 54, 232, 255];

/** Residents per square kilometer: the lower limit and the color of each class. */
const DENSITY_CLASSES: {from: number; color: [number, number, number]}[] = [
  {from: 0, color: [254, 235, 226]},
  {from: 15000, color: [251, 180, 185]},
  {from: 30000, color: [247, 104, 161]},
  {from: 45000, color: [197, 27, 138]},
  {from: 60000, color: [122, 1, 119]}
];
const DATA_OPACITY = 215;

const ATTRIBUTION_HTML = [
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  '<a href="https://www.census.gov/" target="_blank" rel="noopener">U.S. Census Bureau</a>'
].join(' ');

const INITIAL_VIEW_STATE = {
  longitude: -73.9855,
  latitude: 40.7484,
  zoom: 12.6,
  pitch: 0,
  bearing: 28.9,
  maxPitch: 70
};

/**
 * Draws a deck.gl data layer between two layers of a basemap style, and picks the features of the
 * basemap and of the data layer with the same deck.gl picking.
 */
export function mountBasemapInterleavedPickingExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  /** The style layer that draws next above the data layer, or `TOP`. */
  let position = TOP;
  /** Counts the style documents requested: only the last one is shown. */
  let styleRequest = 0;
  const tracts = fetch(TRACTS_URL).then(response => response.json());

  /** The style with the highlight paint, or null while the style document loads. */
  let style: StyleDocument | null = null;
  /** The two parts of `style`. They change only with the setting, so the tiles are kept. */
  let styleParts: ReturnType<typeof splitStyleAt> | null = null;
  /** The URL of `style`. */
  let styleUrl: string | null = null;
  let hovered: Picked | null = null;
  let selected: Picked | null = null;
  let featureState: BasemapFeatureState | null = null;
  let finalized = false;

  const deck = new Deck<MapView>({
    parent: rootElement,
    views: new MapView({repeat: true}),
    controller: true,
    initialViewState: INITIAL_VIEW_STATE,
    pickingRadius: 3,
    layers: [],
    getCursor: ({isDragging}) => (isDragging ? 'grabbing' : hovered ? 'pointer' : 'grab'),
    onHover: info => {
      const picked = getPicked(info);
      if (!isSamePicked(picked, hovered)) {
        hovered = picked;
        update();
      }
    },
    onClick: info => {
      const picked = getPicked(info);
      selected = isSamePicked(picked, selected) ? null : picked;
      update();
    }
  });

  const infoCard = createInfoCard(rootElement.ownerDocument);
  const controlPanel = createControlPanel(rootElement.ownerDocument, {
    title: 'One layer list, one picking',
    summary:
      'BasemapLayer draws the map style as deck.gl layers. The census tracts are a deck.gl layer between two of them, and deck.gl picks the features of both.',
    styleLabel: 'Basemap style',
    styles: STYLES,
    positionLabel: 'Draw the census tracts below',
    legend: {
      title: 'Residents per km²',
      source: '2020 Census, by census tract',
      classes: DENSITY_CLASSES.map(({from, color}) => ({
        color: `rgb(${color.join(',')})`,
        label: from === 0 ? '0' : `${from / 1000}k`
      }))
    },
    onStyleChange: loadStyle,
    onPositionChange: value => {
      position = value;
      if (style) {
        styleParts = splitStyleAt(style, getBeforeId());
        update();
      }
    }
  });
  rootElement.append(
    controlPanel.element,
    infoCard.element,
    createAttribution(rootElement.ownerDocument)
  );
  update();

  loadStyle(STYLES[0].value);

  return () => {
    finalized = true;
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  /**
   * Loads a style document, and puts the data layer at the lowest of the style's positions. When
   * the style does not load, the panel shows the error, and the map keeps the style it has.
   */
  function loadStyle(url: string) {
    const request = ++styleRequest;
    controlPanel.setError(null);
    fetchStyle(url)
      .then(document => {
        if (finalized || request !== styleRequest) {
          return;
        }
        style = withFeatureStateHighlight(document, HIGHLIGHT_COLORS);
        styleUrl = url;
        const presets = [
          ...getStylePositions(style).map(({label, beforeId}) => ({label, value: beforeId})),
          {label: 'On top', value: TOP}
        ];
        position = presets[0].value;
        styleParts = splitStyleAt(style, getBeforeId());
        hovered = null;
        selected = null;
        controlPanel.setPositions(getPositions(style), presets, position);
        update();
      })
      .catch((error: unknown) => {
        if (finalized || request !== styleRequest) {
          return;
        }
        controlPanel.setError(`The basemap style did not load: ${getMessage(error)}`);
        if (styleUrl) {
          controlPanel.setStyle(styleUrl);
        }
      });
  }

  function getBeforeId(): string | null {
    return position === TOP ? null : position;
  }

  /** Draws the layers and the info card for the hovered and the selected feature. */
  function update() {
    featureState = getFeatureState(hovered, selected, featureState);
    deck.setProps({layers: getLayers()});
    const shown = hovered ?? selected;
    infoCard.setContent(
      shown ? getInfoCardContent(shown, isSamePicked(shown, selected), style) : null
    );
  }

  function getLayers() {
    if (!styleParts) {
      return [];
    }
    const selectedTract = selected?.kind === 'data' ? selected.feature.id : null;
    // The picking of deck.gl reads the basemap features and the data features in one pass.
    const basemapProps = {pickable: true, featureState};
    return [
      new BasemapLayer({id: 'basemap-below', style: styleParts.below, ...basemapProps}),
      new GeoJsonLayer<TractProperties>({
        id: DATA_LAYER_ID,
        data: tracts,
        pickable: true,
        autoHighlight: true,
        highlightColor: DATA_HOVER_COLOR,
        filled: true,
        stroked: true,
        getFillColor: feature => getDensityColor(feature.properties.populationPerKm2),
        getLineColor: feature =>
          feature.id === selectedTract ? DATA_SELECTED_COLOR : [255, 255, 255, 190],
        getLineWidth: feature => (feature.id === selectedTract ? 3 : 0.75),
        lineWidthUnits: 'pixels',
        // The layer order alone gives the draw order, as for the layers of the basemap.
        parameters: {depthCompare: 'always', depthWriteEnabled: false},
        updateTriggers: {getLineColor: selectedTract, getLineWidth: selectedTract}
      }),
      styleParts.above &&
        new BasemapLayer({id: 'basemap-above', style: styleParts.above, ...basemapProps})
    ];
  }
}

/**
 * The positions of the data layer, from the top of the map to the bottom, as a layer list shows
 * them. The style has its layers in draw order, so the last style layer is the first position.
 */
function getPositions(style: StyleDocument): LayerPosition[] {
  return [
    {label: 'nothing: on top of the basemap', value: TOP},
    ...style.layers
      .map((layer, index) => ({label: `${index + 1}. ${layer.id} (${layer.type})`, value: layer.id}))
      .reverse()
  ];
}

/** The picked feature of a picking info: a basemap feature, a census tract, or nothing. */
function getPicked(info: PickingInfo): Picked | null {
  const {basemapFeature} = info as PickingInfo & {basemapFeature?: BasemapPickedFeature};
  if (basemapFeature) {
    return {kind: 'basemap', feature: basemapFeature};
  }
  if (info.layer?.id === DATA_LAYER_ID && info.object) {
    return {kind: 'data', feature: info.object as TractFeature};
  }
  return null;
}

/**
 * The feature states of the hovered and the selected basemap feature, as `BasemapLayer` reads
 * them: by source, then by source layer, then by feature id. Returns `previous` when it already
 * holds these states, because `BasemapLayer` compares the object by identity.
 */
function getFeatureState(
  hovered: Picked | null,
  selected: Picked | null,
  previous: BasemapFeatureState | null
): BasemapFeatureState | null {
  const states: Record<string, Record<string, Record<string, Record<string, boolean>>>> = {};
  const add = (picked: Picked | null, key: 'hover' | 'selected') => {
    if (picked?.kind !== 'basemap') {
      return;
    }
    const {source, sourceLayer, id} = picked.feature;
    if (id === undefined || sourceLayer === undefined) {
      return;
    }
    const sourceStates = (states[source] ??= {});
    const layerStates = (sourceStates[sourceLayer] ??= {});
    (layerStates[id] ??= {})[key] = true;
  };
  add(hovered, 'hover');
  add(selected, 'selected');
  if (Object.keys(states).length === 0) {
    return null;
  }
  return JSON.stringify(states) === JSON.stringify(previous) ? previous : states;
}

function getInfoCardContent(
  picked: Picked,
  isSelected: boolean,
  style: StyleDocument | null
): InfoCardContent {
  if (picked.kind === 'data') {
    const {name, population, housingUnits, landAreaKm2, populationPerKm2} =
      picked.feature.properties;
    return {
      eyebrow: 'Data feature',
      title: name,
      isSelected,
      rows: [
        ['deck.gl layer', DATA_LAYER_ID],
        ['feature id', picked.feature.id]
      ],
      properties: [
        ['population', formatNumber(population)],
        ['housingUnits', formatNumber(housingUnits)],
        ['landAreaKm2', String(landAreaKm2)],
        ['populationPerKm2', formatNumber(populationPerKm2)]
      ]
    };
  }
  const {id, source, sourceLayer, styleLayerId, properties} = picked.feature;
  const styleLayer = style?.layers.find(layer => layer.id === styleLayerId);
  return {
    eyebrow: 'Basemap feature',
    title: getFeatureTitle(properties, styleLayer),
    isSelected,
    rows: [
      ['style layer', styleLayerId],
      ['layer type', styleLayer?.type ?? ''],
      ['source', source],
      ['source layer', sourceLayer ?? ''],
      ['feature id', id === undefined ? 'none' : String(id)]
    ],
    // The tiles have a name in many languages: the card shows the local one.
    properties: Object.entries(properties)
      .filter(([key]) => !/^name[:_]/.test(key))
      .map(([key, value]) => [key, String(value)])
  };
}

function getFeatureTitle(properties: Record<string, unknown>, styleLayer?: StyleLayer): string {
  for (const key of ['name', 'ref', 'subclass', 'class']) {
    const value = properties[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return styleLayer?.['source-layer'] ?? 'Feature';
}

function getDensityColor(density: number): Color {
  // A tract without residents, such as a park, shows the basemap.
  if (!(density > 0)) {
    return [0, 0, 0, 0];
  }
  let color = DENSITY_CLASSES[0].color;
  for (const densityClass of DENSITY_CLASSES) {
    if (density >= densityClass.from) {
      color = densityClass.color;
    }
  }
  return [color[0], color[1], color[2], DATA_OPACITY];
}

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function createRoot(container: HTMLElement): HTMLDivElement {
  const root = container.ownerDocument.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  container.replaceChildren(root);
  return root;
}

function createAttribution(document: Document): HTMLDivElement {
  const attribution = document.createElement('div');
  attribution.className = 'basemap-attribution';
  attribution.innerHTML = ATTRIBUTION_HTML;
  Object.assign(attribution.style, {
    position: 'absolute',
    right: '0',
    bottom: '0',
    padding: '2px 6px',
    font: '12px/1.4 sans-serif',
    color: '#333',
    background: 'rgba(255, 255, 255, 0.8)'
  });
  return attribution;
}
