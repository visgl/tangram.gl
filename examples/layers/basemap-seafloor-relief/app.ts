// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {Deck, MapView, type MapViewState} from '@deck.gl/core';
import {webgpuAdapter} from '@luma.gl/core/webgpu';
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

import '@deck.gl/widgets/stylesheet.css';

import {RAMP_OPTIONS, TERRARIUM_TILES, createSeafloorStyle, type RampKey} from './style';

type DeviceType = 'webgl' | 'webgpu';

type ExampleSettings = {
  device: DeviceType;
  hillshade: boolean;
  ramp: RampKey;
};

const ATTRIBUTION_HTML = [
  '<a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles</a>:',
  '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen; ETOPO1 terrain data NOAA; 3DEP, SRTM and GMTED2010 terrain data USGS; and others</a>'
].join(' ');

/** Monterey Bay, California: the shelf, Monterey Canyon and the continental slope. */
const INITIAL_VIEW_STATE: MapViewState = {
  longitude: -122.05,
  latitude: 36.72,
  zoom: 9,
  pitch: 0,
  bearing: 0,
  minZoom: 3,
  maxZoom: 13
};

const SETTINGS_SCHEMA: SettingsSchema = {
  title: 'Settings',
  sections: [
    {
      id: 'settings',
      name: 'Settings',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'device',
          label: 'Device',
          type: 'select',
          options: [
            {value: 'webgl', label: 'WebGL'},
            {value: 'webgpu', label: 'WebGPU'}
          ],
          description: 'The example makes a new deck.gl device of this type.'
        },
        {
          name: 'hillshade',
          label: 'Hillshade',
          type: 'boolean',
          description: 'A `hillshade` layer above the color relief, from the same DEM tiles.'
        },
        {
          name: 'ramp',
          label: 'Color ramp',
          type: 'select',
          options: RAMP_OPTIONS,
          description: 'The `color-relief-color` ramp. Each ramp changes color at 0 m, the coast.'
        }
      ]
    }
  ]
};

/**
 * Draws seafloor and land relief from a `raster-dem` source with a `color-relief` layer and a
 * `hillshade` layer of a MapLibre style. The device can be WebGL or WebGPU.
 */
export function mountBasemapSeafloorReliefExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  const settings: ExampleSettings = {device: 'webgl', hillshade: true, ramp: 'ocean-land'};
  let viewState = INITIAL_VIEW_STATE;
  let isMounted = true;
  /** Why the device of the selected type is not in use, or null. */
  let deviceError: string | null = null;
  /** The number of DEM tiles that did not load, and the last reason. */
  let tileErrors = 0;
  let lastTileError = '';
  /** The type of the device that deck.gl made, when it is known. */
  let activeDevice: string | null = null;

  /** One object for all updates: `BasemapLayer` loads its tiles again for new load options. */
  const loadOptions = {fetch: fetchTile};
  /** One style object for each set of settings, so that an unchanged style keeps its tiles. */
  const styles = new Map<string, ReturnType<typeof createSeafloorStyle>>();

  const infoWidget = new BoxPanelWidget({
    style: EXAMPLE_PANEL_STYLE,
    id: 'basemap-seafloor-relief-info',
    placement: 'top-left',
    widthPx: 340,
    title: 'Seafloor relief',
    collapsible: true
  });

  let deck = createDeck();
  rootElement.append(createAttribution(rootElement.ownerDocument));
  syncInfoWidget();

  return () => {
    isMounted = false;
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  function createDeck() {
    activeDevice = null;
    let type = settings.device;
    if (type === 'webgpu' && !('gpu' in navigator)) {
      deviceError = 'This browser has no WebGPU. The example uses WebGL.';
      type = 'webgl';
    } else {
      deviceError = null;
    }
    const next = new Deck({
      parent: rootElement,
      views: new MapView({id: 'map'}),
      controller: {touchRotate: true},
      deviceProps: type === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'},
      viewState,
      onViewStateChange: ({viewState: nextViewState}) => {
        viewState = nextViewState as MapViewState;
        next.setProps({viewState});
      },
      onDeviceInitialized: device => {
        if (isMounted && next === deck) {
          activeDevice = device.type;
          syncInfoWidget();
        }
      },
      onError: error => {
        if (isMounted && next === deck) {
          deviceError = `Rendering error: ${getMessage(error)}`;
          syncInfoWidget();
        }
      },
      layers: getLayers(),
      widgets: [infoWidget]
    });
    return next;
  }

  function getLayers() {
    const key = `${settings.ramp}:${settings.hillshade}`;
    let style = styles.get(key);
    if (!style) {
      style = createSeafloorStyle(settings.ramp, settings.hillshade);
      styles.set(key, style);
    }
    return [new BasemapLayer({id: 'basemap', style, loadOptions})];
  }

  /** Fetches a DEM tile, and counts a tile that does not load. */
  async function fetchTile(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        noteTileError(`${response.status} ${response.statusText}`.trim());
      }
      return response;
    } catch (error) {
      if (!init?.signal?.aborted) {
        noteTileError(getMessage(error));
      }
      throw error;
    }
  }

  function noteTileError(reason: string) {
    tileErrors++;
    lastTileError = reason;
    if (isMounted) {
      syncInfoWidget();
    }
  }

  function getStatusMarkdown(): string {
    const lines: string[] = [];
    if (activeDevice) {
      lines.push(`Device: **${activeDevice === 'webgpu' ? 'WebGPU' : 'WebGL'}**.`);
    }
    if (activeDevice === 'webgpu') {
      lines.push(
        '',
        '`color-relief` layers are WebGL only: on WebGPU, only the hillshade and the gray background draw.'
      );
    }
    if (deviceError) {
      lines.push('', `**${escapeMarkdown(deviceError)}**`);
    }
    if (tileErrors) {
      lines.push(
        '',
        `**${tileErrors} DEM tile(s) did not load (${escapeMarkdown(lastTileError)}).** ` +
          `The tiles come from ${TERRARIUM_TILES.split('/{z}')[0]}.`
      );
    }
    return lines.join('\n');
  }

  function syncInfoWidget() {
    const status = getStatusMarkdown();
    infoWidget.setProps({
      panel: new ColumnPanel({
        id: 'basemap-seafloor-relief-panel',
        title: 'Seafloor relief',
        panels: [
          new MarkdownPanel({
            id: 'summary',
            title: '',
            markdown: [
              'Monterey Canyon, California, from one `raster-dem` source of land and seabed',
              'heights. A `color-relief` layer colors each pixel by its height, and a `hillshade`',
              'layer shades the slopes. Both layers read the same decoded tiles.'
            ].join('\n')
          }),
          ...(status ? [new MarkdownPanel({id: 'status', title: '', markdown: status})] : []),
          new SettingsPanel({
            id: 'settings',
            label: 'Settings',
            schema: SETTINGS_SCHEMA,
            settings: settings as unknown as SettingsState,
            onSettingsChange: nextSettings => {
              const device = getValueAtPath(nextSettings, 'device') === 'webgpu' ? 'webgpu' : 'webgl';
              const ramp = getValueAtPath(nextSettings, 'ramp') as RampKey;
              settings.hillshade = Boolean(getValueAtPath(nextSettings, 'hillshade'));
              if (RAMP_OPTIONS.some(option => option.value === ramp)) {
                settings.ramp = ramp;
              }
              if (device !== settings.device) {
                settings.device = device;
                // A deck.gl device cannot change its type: the example makes a new deck.
                deck.finalize();
                deck = createDeck();
                syncInfoWidget();
              } else {
                deck.setProps({layers: getLayers()});
              }
            }
          })
        ]
      })
    });
  }
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
  root.style.fontFamily = 'system-ui, sans-serif';
  root.style.background = '#8c9196';
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
    zIndex: '1',
    padding: '2px 6px',
    font: '12px/1.4 sans-serif',
    color: '#333',
    background: 'rgba(255, 255, 255, 0.8)'
  });
  return attribution;
}
