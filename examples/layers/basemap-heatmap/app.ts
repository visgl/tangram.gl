// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {HeatmapLayer} from '@deck.gl/aggregation-layers';
import {Deck, MapView, type Layer, type PickingInfo} from '@deck.gl/core';
import {ScatterplotLayer} from '@deck.gl/layers';
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

import {
  COLOR_STOPS,
  FULL_WEIGHT_MAGNITUDE,
  getLngLat,
  getStyle,
  getWeight,
  wrapLongitude,
  type Earthquake,
  type EarthquakeCollection,
  type KernelSettings,
  type RendererId,
  type Style,
  type WeightId
} from './heatmap-data';

import '@deck.gl/widgets/stylesheet.css';


type ExampleSettings = {
  heatmap: {renderer: RendererId; weight: WeightId; points: boolean};
  /** `heatmap-radius` and `heatmap-intensity` of the style heatmap layer. */
  style: KernelSettings;
  /** `radiusPixels` and `intensity` of the deck.gl `HeatmapLayer`. */
  deck: KernelSettings;
};

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

/** The earthquakes of magnitude 2.5 or more in the last 30 days. Public domain (USGS). */
const EARTHQUAKES_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_month.geojson';

const BASEMAP_VIEW_ID = 'basemap-view';
const DATA_VIEW_ID = 'data-view';
const BASEMAP_LAYER_ID = 'basemap';

const ATTRIBUTION_HTML = [
  'Earthquakes: <a href="https://earthquake.usgs.gov/earthquakes/feed/" target="_blank" rel="noopener">USGS</a>',
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
].join(' ');

const INITIAL_VIEW_STATE = {
  longitude: 175,
  latitude: 20,
  zoom: 1.6,
  pitch: 0,
  bearing: 0,
  // Below this zoom, the view is wider than one copy of the world.
  minZoom: 1.5,
  maxZoom: 12
};

/** The step of the longitude that the deck.gl `HeatmapLayer` wraps its points around, in degrees. */
const WRAP_STEP = 10;

const RENDERERS: Record<RendererId, string> = {
  style: 'Style heatmap layer',
  deck: 'deck.gl HeatmapLayer'
};

const WEIGHTS: Record<WeightId, string> = {
  count: 'None (count)',
  magnitude: 'Magnitude'
};

const SETTINGS_SCHEMA: SettingsSchema = {
  title: 'Settings',
  sections: [
    {
      id: 'heatmap',
      name: 'Heatmap',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'heatmap.renderer',
          label: 'Draw with',
          type: 'select',
          options: Object.entries(RENDERERS).map(([value, label]) => ({label, value})),
          description: 'A heatmap layer in the basemap style, or a deck.gl layer above the basemap.'
        },
        {
          name: 'heatmap.weight',
          label: 'Weight by',
          type: 'select',
          options: Object.entries(WEIGHTS).map(([value, label]) => ({label, value})),
          description: `Each earthquake counts as 1, or by its magnitude (1 at magnitude ${FULL_WEIGHT_MAGNITUDE}).`
        },
        {
          name: 'heatmap.points',
          label: 'Points',
          type: 'boolean',
          description: 'Draw the earthquakes as a pickable deck.gl layer. Hover a point for its data.'
        }
      ]
    },
    getKernelSection('style', 'Style heatmap layer', 'heatmap-radius', 'heatmap-intensity', 4),
    getKernelSection('deck', 'deck.gl HeatmapLayer', 'radiusPixels', 'intensity', 20)
  ]
};

/** The radius and intensity settings of one heatmap. */
function getKernelSection(
  id: 'style' | 'deck',
  name: string,
  radiusProp: string,
  intensityProp: string,
  maxIntensity: number
): SettingsSchema['sections'][number] {
  return {
    id,
    name,
    initiallyCollapsed: false,
    settings: [
      {
        name: `${id}.radius`,
        label: 'Radius (px)',
        type: 'number',
        min: 4,
        max: 80,
        step: 2,
        description: `${radiusProp}: the radius of the kernel of each earthquake, in pixels.`
      },
      {
        name: `${id}.intensity`,
        label: 'Intensity',
        type: 'number',
        min: 0.1,
        max: maxIntensity,
        step: 0.1,
        description: `${intensityProp}: the factor for the weights of all earthquakes.`
      }
    ]
  };
}

/** Draws the same earthquakes as a style heatmap layer or as a deck.gl `HeatmapLayer`. */
export function mountBasemapHeatmapExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  const settings: ExampleSettings = {
    heatmap: {renderer: 'style', weight: 'magnitude', points: false},
    style: {radius: 14, intensity: 0.4},
    deck: {radius: 30, intensity: 4}
  };
  let baseStyle: Style | null = null;
  let earthquakes: EarthquakeCollection | null = null;
  /** The style that `BasemapLayer` draws. A new object makes `BasemapLayer` resolve it again. */
  let style: Style | null = null;
  /** Why the style or the earthquakes did not load. Each error stays until the example unmounts. */
  const errors: string[] = [];
  /**
   * The data view draws one copy of the world. The data layers place each earthquake within 180
   * degrees of this longitude, near the center of the view.
   */
  let wrapCenter = getWrapCenter(INITIAL_VIEW_STATE.longitude);
  let isMounted = true;

  const infoWidget = new BoxPanelWidget({
    style: EXAMPLE_PANEL_STYLE,
    id: 'basemap-heatmap-info',
    placement: 'top-left',
    widthPx: 380,
    title: 'Style heatmap and deck.gl heatmap',
    collapsible: true
  });

  const deck = new Deck({
    parent: rootElement,
    // The basemap repeats across the antimeridian. In deck.gl 10.0.0-alpha.1, a `HeatmapLayer` in a
    // repeated view clears the canvas under its kernels in the copies of the world, so the data
    // layers draw in a second view of the same view state, without copies.
    views: [
      new MapView({id: BASEMAP_VIEW_ID, repeat: true, controller: true}),
      new MapView({id: DATA_VIEW_ID, repeat: false})
    ],
    layerFilter: ({layer, viewport}) =>
      (viewport.id === BASEMAP_VIEW_ID) === layer.id.startsWith(BASEMAP_LAYER_ID),
    // One view state for both views.
    viewState: INITIAL_VIEW_STATE,
    layers: [],
    widgets: [infoWidget],
    getTooltip,
    onViewStateChange: ({viewState}) => {
      const nextWrapCenter = getWrapCenter(viewState.longitude);
      if (nextWrapCenter !== wrapCenter) {
        wrapCenter = nextWrapCenter;
        deck.setProps({viewState, layers: getLayers()});
      } else {
        deck.setProps({viewState});
      }
    }
  });
  rootElement.append(createAttribution(rootElement.ownerDocument));
  syncInfoWidget();

  fetchJson<Style>(STYLE_URL)
    .then(loadedStyle => {
      if (isMounted) {
        baseStyle = loadedStyle;
        update();
      }
    })
    .catch((error: unknown) => showError(`The basemap style did not load: ${getMessage(error)}`));
  fetchJson<EarthquakeCollection>(EARTHQUAKES_URL)
    .then(collection => {
      if (isMounted) {
        earthquakes = collection;
        update();
      }
    })
    .catch((error: unknown) => showError(`The earthquakes did not load: ${getMessage(error)}`));

  return () => {
    isMounted = false;
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  function showError(message: string) {
    if (isMounted) {
      errors.push(message);
      syncInfoWidget();
    }
  }

  /** Makes the style and the layers for the current settings. */
  function update() {
    // The style heatmap is part of the style: a change of its paint makes a new style object.
    style =
      baseStyle &&
      (settings.heatmap.renderer === 'style'
        ? getStyle(baseStyle, earthquakes, settings.heatmap.weight, settings.style)
        : baseStyle);
    deck.setProps({layers: getLayers()});
    syncInfoWidget();
  }

  function syncInfoWidget() {
    const {renderer} = settings.heatmap;
    const status = earthquakes
      ? `${earthquakes.features.length} earthquakes of magnitude 2.5 or more in the last 30 days.`
      : 'Loading the earthquakes.';
    infoWidget.setProps({
      panel: new ColumnPanel({
        id: 'basemap-heatmap-panel',
        title: 'Style heatmap and deck.gl heatmap',
        panels: [
          new MarkdownPanel({
            id: 'summary',
            title: '',
            markdown: [
              renderer === 'style'
                ? 'A `heatmap` layer of the style draws the earthquakes. `BasemapLayer` draws it in style order, below the labels.'
                : 'A deck.gl `HeatmapLayer` draws the earthquakes above the basemap and its labels. Its colors scale to the highest density in the view.',
              '',
              status
            ].join('\n')
          }),
          ...errors.map(
            (error, index) =>
              new MarkdownPanel({id: `error-${index}`, title: '', markdown: `**${escapeMarkdown(error)}**`})
          ),
          new SettingsPanel({
            id: 'settings',
            label: 'Settings',
            schema: SETTINGS_SCHEMA,
            settings: settings as unknown as SettingsState,
            onSettingsChange: nextSettings => {
              settings.heatmap = {
                renderer: getValueAtPath(nextSettings, 'heatmap.renderer') as RendererId,
                weight: getValueAtPath(nextSettings, 'heatmap.weight') as WeightId,
                points: Boolean(getValueAtPath(nextSettings, 'heatmap.points'))
              };
              for (const id of ['style', 'deck'] as const) {
                settings[id] = {
                  radius: Number(getValueAtPath(nextSettings, `${id}.radius`)),
                  intensity: Number(getValueAtPath(nextSettings, `${id}.intensity`))
                };
              }
              update();
            }
          })
        ]
      })
    });
  }

  /** The position of an earthquake in the copy of the world that the data view draws. */
  function getWrappedPosition(feature: Earthquake): [number, number] {
    const [longitude, latitude] = getLngLat(feature);
    return [wrapLongitude(longitude, wrapCenter), latitude];
  }

  function getLayers(): Layer[] {
    const {renderer, weight, points} = settings.heatmap;
    const features = earthquakes?.features ?? [];
    return [
      ...(style ? [new BasemapLayer({id: BASEMAP_LAYER_ID, style: style as any})] : []),
      ...(renderer === 'deck'
        ? [
            // A data layer: it sums the weights on the GPU, and updates without a new style.
            new HeatmapLayer<Earthquake>({
              id: 'deck-heatmap',
              data: features,
              getPosition: getWrappedPosition,
              getWeight: feature => getWeight(feature, weight),
              updateTriggers: {getPosition: wrapCenter, getWeight: weight},
              radiusPixels: settings.deck.radius,
              intensity: settings.deck.intensity,
              colorRange: COLOR_STOPS.slice(1).map(([, color]) => color)
            })
          ]
        : []),
      ...(points
        ? [
            new ScatterplotLayer<Earthquake>({
              id: 'earthquake-points',
              data: features,
              getPosition: getWrappedPosition,
              updateTriggers: {getPosition: wrapCenter},
              getRadius: 2.5,
              radiusUnits: 'pixels',
              getFillColor: [255, 255, 255, 200],
              getLineColor: [20, 24, 32, 255],
              stroked: true,
              getLineWidth: 1,
              lineWidthUnits: 'pixels',
              pickable: true
            })
          ]
        : [])
    ];
  }
}

/** The longitude near the center of the view, rounded to `WRAP_STEP`. */
function getWrapCenter(longitude: number): number {
  return Math.round(longitude / WRAP_STEP) * WRAP_STEP;
}

function getTooltip({layer, object}: PickingInfo<Earthquake>) {
  if (layer?.id !== 'earthquake-points' || !object) {
    return null;
  }
  const {mag, place, time} = object.properties;
  return `M ${mag ?? '?'} · ${place ?? 'Unknown place'}\n${new Date(time).toISOString().slice(0, 16)} UTC`;
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
  root.style.background = '#1b1d22';
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
