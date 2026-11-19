// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {Deck, MapView, type Layer} from '@deck.gl/core';
import {PathLayer, ScatterplotLayer, SolidPolygonLayer} from '@deck.gl/layers';
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
  BasemapMaskExtension,
  type BasemapMaskExtensionProps,
  type BasemapMaskOutside
} from './basemap-mask-extension';
import {createSurveyTrack, getCorridorPolygons, getTrackStart, type Position} from './survey-track';

import '@deck.gl/widgets/stylesheet.css';

type FootprintId = 'track' | 'area';
type OutsideStyleId = 'gray' | 'dark' | 'color';
type OutsideFeaturesId = 'all' | 'roads-water' | 'roads' | 'none';

type ExampleSettings = {
  footprint: {
    shape: FootprintId;
    swath: number;
    animate: boolean;
    inverted: boolean;
  };
  outside: {
    style: OutsideStyleId;
    features: OutsideFeaturesId;
  };
};

/** The part of a style layer that selects the features it draws. */
type StyleLayer = {id: string; type: string; 'source-layer'?: string};

type OutsideStyle = {
  label: string;
  saturation: number;
  inverted: boolean;
  tint: BasemapMaskOutside['tint'];
  /** The color behind the basemap, where no basemap layer is drawn. */
  background: string;
};

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const ATTRIBUTION_HTML = [
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>'
].join(' ');

const INITIAL_VIEW_STATE = {
  longitude: 4.8945,
  latitude: 52.3715,
  zoom: 13.1,
  pitch: 0,
  bearing: 0,
  minZoom: 10,
  maxZoom: 17
};

/** A survey of the center of Amsterdam: six lines, 520 meters apart. */
const TRACK = createSurveyTrack({
  center: [4.8945, 52.3725],
  bearing: 24,
  lineCount: 6,
  lineLength: 3100,
  lineSpacing: 520
});

/** An area of interest around the canal ring. */
const AREA: Position[] = [
  [4.868, 52.368],
  [4.876, 52.384],
  [4.898, 52.389],
  [4.921, 52.38],
  [4.924, 52.365],
  [4.905, 52.356],
  [4.88, 52.357]
];

const MASK_IDS: Record<FootprintId, string> = {track: 'footprint-track', area: 'footprint-area'};

/** The time the vehicle takes for the track, and the time it waits at the end, in seconds. */
const TRACK_SECONDS = 40;
const TRACK_END_SECONDS = 4;

const OUTSIDE_STYLES: Record<OutsideStyleId, OutsideStyle> = {
  dark: {
    label: 'Dark',
    saturation: 0.12,
    inverted: true,
    tint: [0.07, 0.09, 0.13, 0.25],
    background: '#0f1218'
  },
  gray: {
    label: 'Gray',
    saturation: 0,
    inverted: false,
    tint: [0.62, 0.64, 0.67, 0.3],
    background: '#dcdee2'
  },
  color: {
    label: 'Full color',
    saturation: 1,
    inverted: false,
    tint: [0, 0, 0, 0],
    background: '#dcdee2'
  }
};

const ROAD_SOURCE_LAYERS = new Set(['transportation']);
const ROAD_AND_WATER_SOURCE_LAYERS = new Set(['transportation', 'water', 'waterway']);

/** Whether a style layer is drawn outside the footprint. */
const OUTSIDE_FEATURES: Record<
  OutsideFeaturesId,
  {label: string; filter: (layer: StyleLayer) => boolean}
> = {
  all: {label: 'All layers', filter: () => true},
  'roads-water': {
    label: 'Roads and water',
    filter: layer =>
      layer.type !== 'symbol' && ROAD_AND_WATER_SOURCE_LAYERS.has(layer['source-layer'] || '')
  },
  roads: {
    label: 'Roads',
    filter: layer => layer.type !== 'symbol' && ROAD_SOURCE_LAYERS.has(layer['source-layer'] || '')
  },
  none: {label: 'No layers', filter: () => false}
};

const SETTINGS_SCHEMA: SettingsSchema = {
  title: 'Settings',
  sections: [
    {
      id: 'footprint',
      name: 'Data footprint',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'footprint.shape',
          label: 'Footprint',
          type: 'select',
          options: [
            {label: 'Survey track', value: 'track'},
            {label: 'Area of interest', value: 'area'}
          ],
          description: 'The deck.gl layer that masks the basemap.'
        },
        {
          name: 'footprint.swath',
          label: 'Swath (m)',
          type: 'number',
          min: 80,
          max: 600,
          step: 20,
          description: 'The width of the survey track, in meters.'
        },
        {
          name: 'footprint.animate',
          label: 'Animate',
          type: 'boolean',
          description: 'Move the vehicle along the survey track.'
        },
        {
          name: 'footprint.inverted',
          label: 'Invert',
          type: 'boolean',
          description: 'Exchange the inside and the outside of the footprint.'
        }
      ]
    },
    {
      id: 'outside',
      name: 'Basemap outside the footprint',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'outside.style',
          label: 'Style',
          type: 'select',
          options: Object.entries(OUTSIDE_STYLES).map(([value, {label}]) => ({label, value})),
          description: 'The colors of the basemap outside the footprint.'
        },
        {
          name: 'outside.features',
          label: 'Layers',
          type: 'select',
          options: Object.entries(OUTSIDE_FEATURES).map(([value, {label}]) => ({label, value})),
          description: 'The style layers that are drawn outside the footprint.'
        }
      ]
    }
  ]
};

/** Draws a `BasemapLayer` that a deck.gl data layer masks and styles. */
export function mountBasemapMaskedByDataExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  const settings: ExampleSettings = {
    footprint: {shape: 'track', swath: 360, animate: true, inverted: false},
    outside: {style: 'dark', features: 'all'}
  };
  const styleLayers = new Map<string, StyleLayer>();
  let style: {layers: StyleLayer[]} | null = null;
  /** Why the style did not load, or null. */
  let styleError: string | null = null;
  /** The distance of the vehicle along the track, in meters. */
  let trackDistance = TRACK.length * 0.4;
  let lastFrameTime: number | null = null;
  let animationFrame = 0;
  let isMounted = true;

  const maskExtension = new BasemapMaskExtension();
  let maskOutside = getMaskOutside();
  rootElement.style.background = OUTSIDE_STYLES[settings.outside.style].background;

  const infoWidget = new BoxPanelWidget({
    style: EXAMPLE_PANEL_STYLE,
    id: 'basemap-masked-by-data-info',
    placement: 'top-left',
    widthPx: 360,
    title: 'Basemap masked by data',
    collapsible: true
  });

  const deck = new Deck({
    parent: rootElement,
    views: new MapView({repeat: true}),
    controller: true,
    initialViewState: INITIAL_VIEW_STATE,
    layers: getLayers(),
    widgets: [infoWidget]
  });
  rootElement.append(createAttribution(rootElement.ownerDocument));
  syncInfoWidget();

  fetchStyle(STYLE_URL)
    .then(loadedStyle => {
      if (!isMounted) {
        return;
      }
      style = loadedStyle;
      for (const layer of loadedStyle.layers) {
        styleLayers.set(layer.id, layer);
      }
      maskOutside = getMaskOutside();
      deck.setProps({layers: getLayers()});
    })
    .catch((error: unknown) => {
      if (isMounted) {
        styleError = `The basemap style did not load: ${getMessage(error)}`;
        syncInfoWidget();
      }
    });
  animationFrame = requestAnimationFrame(animate);

  return () => {
    isMounted = false;
    cancelAnimationFrame(animationFrame);
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  function animate(time: number) {
    const seconds = lastFrameTime === null ? 0 : Math.min((time - lastFrameTime) / 1000, 0.1);
    lastFrameTime = time;
    if (settings.footprint.animate && settings.footprint.shape === 'track') {
      const speed = TRACK.length / TRACK_SECONDS;
      trackDistance += seconds * speed;
      if (trackDistance > TRACK.length + TRACK_END_SECONDS * speed) {
        trackDistance = 0;
      }
      deck.setProps({layers: getLayers()});
    }
    animationFrame = requestAnimationFrame(animate);
  }

  /** The style of the basemap outside the footprint. The object changes only with the settings. */
  function getMaskOutside(): BasemapMaskOutside {
    const {saturation, inverted, tint} = OUTSIDE_STYLES[settings.outside.style];
    const {filter} = OUTSIDE_FEATURES[settings.outside.features];
    return {
      saturation,
      inverted,
      tint,
      // A sublayer can draw several style layers. It is drawn outside when one of them is.
      drawLayer: ids =>
        ids.some(id => {
          const layer = styleLayers.get(id);
          return layer !== undefined && filter(layer);
        })
    };
  }

  function syncInfoWidget() {
    infoWidget.setProps({
      panel: new ColumnPanel({
        id: 'basemap-masked-by-data-panel',
        title: 'Basemap masked by data',
        panels: [
          new MarkdownPanel({
            id: 'summary',
            title: '',
            markdown: [
              'A deck.gl data layer masks the basemap. The layers of a `BasemapLayer` are deck.gl',
              'layers: one layer extension draws them in color inside the footprint of the data,',
              'and filters and restyles them outside it.'
            ].join('\n')
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
              settings.footprint = {
                shape: getValueAtPath(nextSettings, 'footprint.shape') as FootprintId,
                swath: Number(getValueAtPath(nextSettings, 'footprint.swath')),
                animate: Boolean(getValueAtPath(nextSettings, 'footprint.animate')),
                inverted: Boolean(getValueAtPath(nextSettings, 'footprint.inverted'))
              };
              settings.outside = {
                style: getValueAtPath(nextSettings, 'outside.style') as OutsideStyleId,
                features: getValueAtPath(nextSettings, 'outside.features') as OutsideFeaturesId
              };
              maskOutside = getMaskOutside();
              rootElement.style.background = OUTSIDE_STYLES[settings.outside.style].background;
              deck.setProps({layers: getLayers()});
            }
          })
        ]
      })
    });
  }

  function getLayers(): Layer[] {
    const isDark = settings.outside.style === 'dark';
    const trackColor: [number, number, number] = isDark ? [255, 214, 92] : [226, 61, 98];
    const travelled = getTrackStart(TRACK, trackDistance);
    // `operation: 'mask'` draws these layers into the mask texture, not on the screen. deck.gl
    // draws a path of a width in meters too narrow there, so the track is a set of polygons.
    const footprintLayers = [
      new SolidPolygonLayer<Position[]>({
        id: MASK_IDS.track,
        data: getCorridorPolygons(travelled, settings.footprint.swath),
        getPolygon: polygon => polygon,
        operation: 'mask'
      }),
      new SolidPolygonLayer<Position[]>({
        id: MASK_IDS.area,
        data: [AREA],
        getPolygon: polygon => polygon,
        operation: 'mask'
      })
    ];

    const dataLayers =
      settings.footprint.shape === 'track'
        ? [
            new PathLayer<Position[]>({
              id: 'track-planned',
              data: [TRACK.positions],
              getPath: path => path,
              getColor: isDark ? [255, 255, 255, 80] : [30, 36, 48, 80],
              getWidth: 1.5,
              widthUnits: 'pixels'
            }),
            new PathLayer<Position[]>({
              id: 'track-travelled',
              data: [travelled],
              getPath: path => path,
              getColor: trackColor,
              getWidth: 2.5,
              widthUnits: 'pixels',
              capRounded: true,
              jointRounded: true
            }),
            new ScatterplotLayer<Position>({
              id: 'vehicle',
              data: [travelled[travelled.length - 1]],
              getPosition: position => position,
              getFillColor: trackColor,
              getLineColor: [255, 255, 255],
              getRadius: 7,
              radiusUnits: 'pixels',
              stroked: true,
              getLineWidth: 2.5,
              lineWidthUnits: 'pixels'
            })
          ]
        : [
            new PathLayer<Position[]>({
              id: 'area-outline',
              data: [[...AREA, AREA[0]]],
              getPath: path => path,
              getColor: trackColor,
              getWidth: 2.5,
              widthUnits: 'pixels',
              jointRounded: true
            })
          ];

    return [
      ...footprintLayers,
      ...(style
        ? [
            // The layers of the basemap are deck.gl layers: they take the extension and its props.
            new BasemapLayer<BasemapMaskExtensionProps>({
              id: 'basemap',
              style: style as any,
              extensions: [maskExtension],
              maskId: MASK_IDS[settings.footprint.shape],
              maskInverted: settings.footprint.inverted,
              maskOutside
            })
          ]
        : []),
      ...dataLayers
    ];
  }
}

/** Fetches a style document. Rejects with the URL and the HTTP status when the response is not OK. */
async function fetchStyle(url: string): Promise<{layers: StyleLayer[]}> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${response.statusText}`.trim());
  }
  return (await response.json()) as {layers: StyleLayer[]};
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
