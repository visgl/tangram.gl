// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {Deck, MapView, type Layer, type MapViewState, type PickingInfo} from '@deck.gl/core';
import {
  DataFilterExtension,
  MaskExtension,
  type DataFilterExtensionProps,
  type MaskExtensionProps
} from '@deck.gl/extensions';
import {PathLayer, SolidPolygonLayer} from '@deck.gl/layers';
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

import {getBuildingFilterValue, getCircle, NOT_A_BUILDING, type Position} from './extension-props';

import '@deck.gl/widgets/stylesheet.css';

type DemoId = 'mask' | 'filter';

type ExampleSettings = {
  demo: DemoId;
  enabled: boolean;
  mask: {radius: number};
  filter: {minHeight: number};
};

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const ATTRIBUTION_HTML = [
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>'
].join(' ');

/** Midtown Manhattan. The mask demo looks down, the filter demo looks at the buildings from the side. */
const CENTER: [number, number] = [-73.9855, 40.7545];

const VIEW_STATES: Record<DemoId, MapViewState> = {
  mask: {longitude: CENTER[0], latitude: CENTER[1], zoom: 13.4, pitch: 0, bearing: 0},
  filter: {longitude: CENTER[0], latitude: CENTER[1], zoom: 15.2, pitch: 55, bearing: 29}
};

// The markdown panel ends a list item at a line break, so each item is one line.
const SUMMARY = [
  'The layers that draw a `BasemapLayer` are deck.gl layers. The `BasemapLayer` gives them its',
  '`extensions` and the props of those extensions.',
  '',
  "- **MaskExtension** draws the basemap inside a circle only: the background, the fills, the lines and the labels. The circle is a deck.gl layer with `operation: 'mask'`. Click the map to move it.",
  '- **DataFilterExtension** hides the buildings below a minimum height. `getFilterValue` gets each feature of the basemap. A new height changes only `filterRange`: no tile loads again.'
].join('\n');

const SETTINGS_SCHEMA: SettingsSchema = {
  title: 'Settings',
  sections: [
    {
      id: 'extension',
      name: 'Extension',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'demo',
          label: 'Extension',
          type: 'select',
          options: [
            {label: 'MaskExtension', value: 'mask'},
            {label: 'DataFilterExtension', value: 'filter'}
          ],
          description: 'The deck.gl extension that the BasemapLayer gives to its sublayers.'
        },
        {
          name: 'enabled',
          label: 'Apply',
          type: 'boolean',
          description: 'Draw the basemap with the extension, or without it.'
        },
        {
          name: 'mask.radius',
          label: 'Mask radius (km)',
          type: 'number',
          min: 0.25,
          max: 3,
          step: 0.25,
          description: 'The radius of the mask circle. MaskExtension only.'
        },
        {
          name: 'filter.minHeight',
          label: 'Minimum height (m)',
          type: 'number',
          min: 0,
          max: 300,
          step: 10,
          description: 'Buildings lower than this height are not drawn. DataFilterExtension only.'
        }
      ]
    }
  ]
};

/** Draws a `BasemapLayer` with a deck.gl `MaskExtension` or `DataFilterExtension`. */
export function mountBasemapLayerExtensionsExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  const settings: ExampleSettings = {
    demo: 'mask',
    enabled: true,
    mask: {radius: 1.25},
    filter: {minHeight: 120}
  };
  let maskCenter: Position = CENTER;
  let style: unknown = null;
  /** Why the style did not load, or null. */
  let styleError: string | null = null;
  let isMounted = true;

  // Make each extension one time: a new extension instance on each render makes deck.gl compile
  // the shaders of the sublayers again.
  const maskExtension = new MaskExtension();
  const filterExtension = new DataFilterExtension({filterSize: 1});

  const infoWidget = new BoxPanelWidget({
    style: EXAMPLE_PANEL_STYLE,
    id: 'basemap-layer-extensions-info',
    placement: 'top-left',
    widthPx: 360,
    title: 'Extensions on the basemap',
    collapsible: true
  });

  const deck = new Deck({
    parent: rootElement,
    views: new MapView({repeat: true}),
    controller: true,
    initialViewState: VIEW_STATES[settings.demo],
    layers: getLayers(),
    widgets: [infoWidget],
    onClick: onMapClick
  });
  rootElement.append(createAttribution(rootElement.ownerDocument));
  syncInfoWidget();

  fetchStyle(STYLE_URL)
    .then(loadedStyle => {
      if (isMounted) {
        style = loadedStyle;
        deck.setProps({layers: getLayers()});
      }
    })
    .catch((error: unknown) => {
      if (isMounted) {
        styleError = `The basemap style did not load: ${getMessage(error)}`;
        syncInfoWidget();
      }
    });

  return () => {
    isMounted = false;
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  function onMapClick(info: PickingInfo) {
    if (settings.demo === 'mask' && info.coordinate) {
      maskCenter = [info.coordinate[0], info.coordinate[1]];
      deck.setProps({layers: getLayers()});
    }
  }

  function syncInfoWidget() {
    infoWidget.setProps({
      panel: new ColumnPanel({
        id: 'basemap-layer-extensions-panel',
        title: 'Extensions on the basemap',
        panels: [
          new MarkdownPanel({
            id: 'summary',
            title: '',
            markdown: SUMMARY
          }),
          ...(styleError
            ? [new MarkdownPanel({id: 'error', title: '', markdown: `**${escapeMarkdown(styleError)}**`})]
            : []),
          new SettingsPanel({
            id: 'settings',
            label: 'Settings',
            schema: SETTINGS_SCHEMA,
            settings: settings as unknown as SettingsState,
            onSettingsChange: nextSettings => {
              const demo = getValueAtPath(nextSettings, 'demo') as DemoId;
              const demoChanged = demo !== settings.demo;
              settings.demo = demo;
              settings.enabled = Boolean(getValueAtPath(nextSettings, 'enabled'));
              settings.mask = {radius: Number(getValueAtPath(nextSettings, 'mask.radius'))};
              settings.filter = {minHeight: Number(getValueAtPath(nextSettings, 'filter.minHeight'))};
              if (demoChanged) {
                deck.setProps({initialViewState: {...VIEW_STATES[demo]}});
              }
              deck.setProps({layers: getLayers()});
            }
          })
        ]
      })
    });
  }

  function getLayers(): Layer[] {
    if (!style) {
      return [];
    }
    const {demo, enabled} = settings;
    if (demo === 'mask') {
      const circle = getCircle(maskCenter, settings.mask.radius * 1000);
      return [
        // Draws the circle into the mask of deck.gl, not on the screen.
        new SolidPolygonLayer<Position[]>({
          id: 'mask-circle',
          data: [circle],
          getPolygon: polygon => polygon,
          operation: 'mask'
        }),
        enabled
          ? new BasemapLayer<MaskExtensionProps>({
              id: 'basemap-mask',
              style: style as any,
              extensions: [maskExtension],
              maskId: 'mask-circle'
            })
          : new BasemapLayer({id: 'basemap', style: style as any}),
        new PathLayer<Position[]>({
          id: 'mask-outline',
          data: [circle],
          getPath: polygon => polygon,
          getColor: [226, 61, 98],
          getWidth: 2,
          widthUnits: 'pixels'
        })
      ];
    }
    return [
      enabled
        ? new BasemapLayer<DataFilterExtensionProps>({
            id: 'basemap-filter',
            style: style as any,
            extensions: [filterExtension],
            // The accessor is the same function on each render. Inside a vector tile, the
            // `updateTriggers` of an accessor are not passed on, so a new function would not
            // reach the features. Change `filterRange` instead.
            getFilterValue: getBuildingFilterValue,
            filterRange: [settings.filter.minHeight, NOT_A_BUILDING]
          })
        : new BasemapLayer({id: 'basemap', style: style as any})
    ];
  }
}

/** Fetches a style document. Rejects with the URL and the HTTP status when the response is not OK. */
async function fetchStyle(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${response.statusText}`.trim());
  }
  return response.json();
}

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll('_', '\\_');
}

function createRoot(container: HTMLElement): HTMLDivElement {
  const root = container.ownerDocument.createElement('div');
  root.style.position = 'relative';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.overflow = 'hidden';
  root.style.background = '#e8e6e1';
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
