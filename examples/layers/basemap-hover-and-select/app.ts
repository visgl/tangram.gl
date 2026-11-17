// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Deck, MapView, type PickingInfo} from '@deck.gl/core';
import {
  BasemapLayer,
  type BasemapFeatureState,
  type BasemapPickedFeature
} from '@tangram.gl/basemap-layers';

import {
  fetchStyle,
  getFeatureState,
  getHighlightLayerIds,
  isSameFeature,
  withHoverAndSelect,
  type StyleDocument
} from './feature-highlight';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** The style layers of the Liberty style whose features take the highlight. */
const HIGHLIGHT_LAYERS = [
  'building',
  'building-3d',
  'park',
  'landcover_wood',
  'landcover_grass',
  'landuse_pitch',
  'landuse_track',
  'landuse_cemetery',
  'landuse_hospital',
  'landuse_school'
];
const COLORS = {
  hover: '#ff8a00',
  selected: '#d6246e',
  hoverOutline: '#8a4100',
  selectedOutline: '#6e0c35'
};

const INITIAL_VIEW_STATE = {
  longitude: 2.3365,
  latitude: 48.8474,
  zoom: 16,
  pitch: 45,
  bearing: -20,
  maxPitch: 70
};

const ATTRIBUTION_HTML = [
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
].join(' ');

const MUTED_COLOR = '#667085';
const MONOSPACE_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
/** The card shows this many properties, and the count of the others. */
const MAX_PROPERTIES = 8;

const CARD_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  boxSizing: 'border-box',
  padding: '12px 14px',
  borderRadius: '10px',
  font: '12px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif',
  color: '#1f2430',
  background: 'rgba(255, 255, 255, 0.95)',
  border: '1px solid rgba(15, 23, 42, 0.08)',
  boxShadow: '0 6px 24px rgba(15, 23, 42, 0.18)'
};

/**
 * A basemap in which the cursor highlights a building, a park or a landuse area with the feature
 * state `hover`, and a click keeps it with the feature state `selected`. A card names the feature.
 */
export function mountBasemapHoverAndSelectExample(container: HTMLElement): () => void {
  const document = container.ownerDocument;
  const root = createElement(document, 'div', {
    position: 'relative',
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
  });
  container.replaceChildren(root);

  /** The style with the highlight paint, or null while it loads. */
  let style: StyleDocument | null = null;
  /** The ids of the style layers whose features take the highlight. */
  let highlightLayerIds = new Set<string>();
  let hovered: BasemapPickedFeature | null = null;
  let selected: BasemapPickedFeature | null = null;
  let featureState: BasemapFeatureState | null = null;
  let finalized = false;

  const deck = new Deck<MapView>({
    parent: root,
    views: new MapView({repeat: true}),
    controller: true,
    initialViewState: INITIAL_VIEW_STATE,
    pickingRadius: 2,
    layers: [],
    getCursor: ({isDragging}) => (isDragging ? 'grabbing' : hovered ? 'pointer' : 'grab'),
    onHover: info => {
      const feature = getHighlightFeature(info);
      if (!isSameFeature(feature, hovered)) {
        hovered = feature;
        update();
      }
    },
    onClick: info => {
      const feature = getHighlightFeature(info);
      // A click on the selected feature, or on no feature, clears the selection.
      selected = feature && !isSameFeature(feature, selected) ? feature : null;
      update();
    }
  });

  const panel = createPanel(document);
  const card = createElement(document, 'div', {
    ...CARD_STYLE,
    top: '12px',
    right: '12px',
    width: '300px',
    maxWidth: 'calc(100% - 24px)',
    pointerEvents: 'none'
  });
  card.className = 'basemap-hover-and-select-card';
  root.append(panel.element, card, createAttribution(document));
  update();

  fetchStyle(STYLE_URL)
    .then(document => {
      if (finalized) {
        return;
      }
      style = withHoverAndSelect(document, HIGHLIGHT_LAYERS, COLORS);
      highlightLayerIds = getHighlightLayerIds(style, HIGHLIGHT_LAYERS);
      update();
    })
    .catch((error: unknown) => {
      if (!finalized) {
        panel.setError(`The basemap style did not load: ${getMessage(error)}`);
      }
    });

  return () => {
    finalized = true;
    deck.finalize();
    container.replaceChildren();
  };

  /** The picked feature, when a highlight layer drew it. Other picks are no feature. */
  function getHighlightFeature(info: PickingInfo): BasemapPickedFeature | null {
    const {basemapFeature} = info as PickingInfo & {basemapFeature?: BasemapPickedFeature};
    return basemapFeature && highlightLayerIds.has(basemapFeature.styleLayerId)
      ? basemapFeature
      : null;
  }

  function update() {
    featureState = getFeatureState(hovered, selected, featureState);
    deck.setProps({
      layers: style
        ? [new BasemapLayer({id: 'basemap', style, pickable: true, featureState})]
        : []
    });
    const shown = hovered ?? selected;
    renderCard(card, shown, shown !== null && isSameFeature(shown, selected));
  }
}

/** Writes the card for a feature, or the hint when there is no feature. */
function renderCard(
  card: HTMLElement,
  feature: BasemapPickedFeature | null,
  isSelected: boolean
): void {
  const document = card.ownerDocument;
  if (!feature) {
    card.replaceChildren(
      createElement(document, 'div', {fontWeight: '600', fontSize: '13px'}, 'No feature'),
      createElement(
        document,
        'div',
        {color: MUTED_COLOR, marginTop: '4px'},
        'Point at a building, a lawn, a park or a sports pitch. Click to select it.'
      )
    );
    return;
  }
  const {id, source, sourceLayer, styleLayerId, properties} = feature;
  // The tiles have a name in many languages: the card shows the local one.
  const shownProperties = Object.entries(properties)
    .filter(([key]) => !/^name[:_]/.test(key))
    .map(([key, value]): [string, string] => [key, String(value)]);
  const hiddenCount = Math.max(0, shownProperties.length - MAX_PROPERTIES);
  card.replaceChildren(
    createElement(
      document,
      'div',
      {color: MUTED_COLOR, fontSize: '11px', letterSpacing: '0.06em', textTransform: 'uppercase'},
      isSelected ? 'Selected feature' : 'Hovered feature'
    ),
    createElement(
      document,
      'div',
      {
        fontWeight: '600',
        fontSize: '15px',
        margin: '2px 0 8px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      getFeatureTitle(properties, sourceLayer)
    ),
    createTable(document, [
      ['source layer', sourceLayer ?? ''],
      ['style layer', styleLayerId],
      ['source', source],
      ['feature id', id === undefined ? 'none' : String(id)]
    ]),
    createElement(document, 'div', {
      height: '1px',
      margin: '9px 0 8px',
      background: 'rgba(15, 23, 42, 0.1)'
    }),
    shownProperties.length > 0
      ? createTable(document, shownProperties.slice(0, MAX_PROPERTIES))
      : createElement(document, 'div', {color: MUTED_COLOR}, 'No properties'),
    ...(hiddenCount > 0
      ? [createElement(document, 'div', {color: MUTED_COLOR, marginTop: '4px'}, `and ${hiddenCount} more`)]
      : [])
  );
}

function getFeatureTitle(properties: Record<string, unknown>, sourceLayer?: string): string {
  for (const key of ['name', 'class']) {
    const value = properties[key];
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return sourceLayer ?? 'Feature';
}

function createPanel(document: Document): {
  element: HTMLDivElement;
  setError: (message: string | null) => void;
} {
  const element = createElement(document, 'div', {
    ...CARD_STYLE,
    top: '12px',
    left: '12px',
    width: '280px',
    maxWidth: 'calc(100% - 24px)'
  });
  const swatch = (color: string, outline: string, label: string) =>
    createElement(document, 'span', {display: 'inline-flex', alignItems: 'center', gap: '6px'}, [
      createElement(document, 'span', {
        width: '12px',
        height: '12px',
        boxSizing: 'border-box',
        borderRadius: '3px',
        border: `2px solid ${outline}`,
        background: color
      }),
      label
    ]);
  const error = createElement(document, 'div', {
    display: 'none',
    marginTop: '8px',
    color: '#b42318',
    fontWeight: '600'
  });
  error.setAttribute('role', 'alert');
  element.append(
    createElement(document, 'div', {fontWeight: '600', fontSize: '14px'}, 'Hover and select'),
    createElement(
      document,
      'div',
      {color: MUTED_COLOR, margin: '4px 0 8px'},
      'BasemapLayer reads ["feature-state", "hover"] and ["feature-state", "selected"] in the paint of the style. The tiles do not load again when a state changes.'
    ),
    createElement(document, 'div', {display: 'flex', gap: '16px'}, [
      swatch(COLORS.hover, COLORS.hoverOutline, 'hover'),
      swatch(COLORS.selected, COLORS.selectedOutline, 'selected')
    ]),
    error
  );
  return {
    element,
    setError: message => {
      error.textContent = message ?? '';
      error.style.display = message ? 'block' : 'none';
    }
  };
}

function createTable(document: Document, rows: [string, string][]): HTMLDivElement {
  const table = createElement(document, 'div', {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    columnGap: '12px',
    rowGap: '2px'
  });
  for (const [label, value] of rows) {
    table.append(
      createElement(document, 'span', {color: MUTED_COLOR}, label),
      createElement(
        document,
        'span',
        {fontFamily: MONOSPACE_FONT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'},
        value
      )
    );
  }
  return table;
}

function createAttribution(document: Document): HTMLDivElement {
  const attribution = createElement(document, 'div', {
    position: 'absolute',
    right: '0',
    bottom: '0',
    padding: '2px 6px',
    font: '12px/1.4 sans-serif',
    color: '#333',
    background: 'rgba(255, 255, 255, 0.8)'
  });
  attribution.className = 'basemap-attribution';
  attribution.innerHTML = ATTRIBUTION_HTML;
  return attribution;
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  style: Partial<CSSStyleDeclaration>,
  children?: string | (string | Node)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  Object.assign(element.style, style);
  if (typeof children === 'string') {
    element.textContent = children;
  } else if (children) {
    element.append(...children);
  }
  return element;
}

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
