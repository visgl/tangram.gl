// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {Deck, MapView} from '@deck.gl/core';
import {ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {BasemapLayer} from '@tangram.gl/basemap-layers';
import {
  ColumnPanel,
  MarkdownPanel,
  SettingsPanel,
  getValueAtPath,
  type SettingsSchema,
  type SettingsState
} from '@deck.gl-community/panels';
import {BoxPanelWidget} from '@deck.gl-community/widgets';
import {CHART_PAGE_URL, CHART_URL, getChartCorners, getChartStyle, type Corner} from './chart';

import '@deck.gl/widgets/stylesheet.css';

type BasemapStyle = Exclude<BasemapLayer['props']['style'], string | null>;
type BasemapStyleLayer = NonNullable<BasemapStyle['layers']>[number];

type ExampleSettings = {
  chart: {
    opacity: number;
    skew: boolean;
  };
};

type CornerLabel = {position: Corner; text: string};

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const ATTRIBUTION_HTML = [
  `Chart: <a href="${CHART_PAGE_URL}" target="_blank" rel="noopener">U.S. Coast Survey, 1859</a> (public domain)`,
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
].join(' ');

const INITIAL_VIEW_STATE = {longitude: -122.407, latitude: 37.786, zoom: 12.2};

const CORNER_NAMES = ['top left', 'top right', 'bottom right', 'bottom left'];

const SETTINGS_SCHEMA: SettingsSchema = {
  title: 'Settings',
  sections: [
    {
      id: 'chart',
      name: 'Chart',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'chart.opacity',
          label: 'Opacity',
          type: 'number',
          min: 0,
          max: 1,
          step: 0.05,
          description: 'The `raster-opacity` of the raster layer.'
        },
        {
          name: 'chart.skew',
          label: 'Skew',
          type: 'boolean',
          description: 'Moves the bottom right corner to the north-east.'
        }
      ]
    }
  ]
};

/**
 * Draws a scanned chart over a basemap: a style `image` source at four corners, drawn by a
 * `raster` style layer, between the fills and the labels of a vector basemap.
 */
export function mountBasemapImageOverlayExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  const settings: ExampleSettings = {chart: {opacity: 0.8, skew: false}};
  /** The basemap style, divided into the layers below the chart and the labels above it. */
  let basemap: {under: BasemapStyle; over: BasemapStyle} | null = null;
  const errors: {style: string | null; chart: string | null} = {style: null, chart: null};
  let disposed = false;

  const infoWidget = new BoxPanelWidget({
    style: EXAMPLE_PANEL_STYLE,
    id: 'basemap-image-overlay-info',
    placement: 'top-left',
    widthPx: 340,
    title: 'Image source',
    collapsible: true
  });

  const deck = new Deck({
    parent: rootElement,
    views: new MapView({repeat: true}),
    initialViewState: INITIAL_VIEW_STATE,
    controller: true,
    layers: [],
    widgets: [infoWidget]
  });
  rootElement.append(createAttribution(rootElement.ownerDocument));
  syncInfoWidget();
  render();
  void loadBasemap();
  void checkChart();

  return () => {
    disposed = true;
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  async function loadBasemap() {
    try {
      const style = await fetchJson<BasemapStyle>(STYLE_URL);
      if (disposed) {
        return;
      }
      const layers = style.layers ?? [];
      const isLabel = (layer: BasemapStyleLayer) => layer.type === 'symbol';
      basemap = {
        under: {...style, layers: layers.filter(layer => !isLabel(layer))},
        over: {...style, layers: layers.filter(isLabel)}
      };
      render();
    } catch (error) {
      if (!disposed) {
        errors.style = `The basemap style did not load: ${getMessage(error)}`;
        syncInfoWidget();
      }
    }
  }

  /** `BasemapLayer` logs an image that does not load. The example also shows it in the panel. */
  async function checkChart() {
    try {
      const response = await fetch(CHART_URL);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`.trim());
      }
    } catch (error) {
      if (!disposed) {
        errors.chart = `The chart image did not load: ${getMessage(error)}`;
        syncInfoWidget();
      }
    }
  }

  function render() {
    const corners = getChartCorners(settings.chart.skew);
    const cornerLabels: CornerLabel[] = corners.map((position, index) => ({
      position,
      text: CORNER_NAMES[index]
    }));
    deck.setProps({
      layers: [
        new BasemapLayer({id: 'basemap-under', style: basemap?.under ?? null}),
        // A style of its own: a change of opacity or corners resolves only this small style.
        new BasemapLayer({id: 'chart', style: getChartStyle(settings.chart)}),
        new BasemapLayer({id: 'basemap-over', style: basemap?.over ?? null}),
        new ScatterplotLayer<CornerLabel>({
          id: 'corners',
          data: cornerLabels,
          getPosition: label => label.position,
          getRadius: 6,
          radiusUnits: 'pixels',
          getFillColor: [200, 30, 40, 255],
          getLineColor: [255, 255, 255, 255],
          lineWidthMinPixels: 2,
          stroked: true
        }),
        new TextLayer<CornerLabel>({
          id: 'corner-labels',
          data: cornerLabels,
          getPosition: label => label.position,
          getText: label => label.text,
          getSize: 13,
          getColor: [255, 255, 255, 255],
          getPixelOffset: [0, -16],
          background: true,
          getBackgroundColor: [40, 40, 40, 220],
          backgroundPadding: [4, 2],
          fontFamily: 'sans-serif'
        })
      ]
    });
  }

  function syncInfoWidget() {
    const errorLines = [errors.style, errors.chart]
      .filter(Boolean)
      .flatMap(error => [`**${error}**`, '']);
    infoWidget.setProps({
      panel: new ColumnPanel({
        id: 'basemap-image-overlay-panel',
        title: 'Image source',
        panels: [
          new MarkdownPanel({
            id: 'summary',
            title: '',
            markdown: [
              ...errorLines,
              'An 1859 U.S. Coast Survey chart of San Francisco, drawn by a `raster` layer over a',
              'style `image` source. The source places the scan at four `coordinates`. West is at',
              'the top of the chart, so the top left corner is in the south-west.',
              '',
              'The corners are approximate. **Skew** moves one corner: the image then warps as a',
              'perspective view, as in MapLibre GL JS.'
            ].join('\n')
          }),
          new SettingsPanel({
            id: 'settings',
            label: 'Settings',
            schema: SETTINGS_SCHEMA,
            settings: settings as unknown as SettingsState,
            onSettingsChange: nextSettings => {
              const opacity = Number(getValueAtPath(nextSettings, 'chart.opacity'));
              settings.chart = {
                opacity: Number.isFinite(opacity) ? opacity : settings.chart.opacity,
                skew: Boolean(getValueAtPath(nextSettings, 'chart.skew'))
              };
              render();
            }
          })
        ]
      })
    });
  }
}

/** Fetches a JSON document. Rejects with the URL and the HTTP status when the response is not OK. */
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${response.statusText}`.trim());
  }
  return (await response.json()) as T;
}

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : `${error}`;
}

function createRoot(container: HTMLElement): HTMLDivElement {
  const root = container.ownerDocument.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
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
