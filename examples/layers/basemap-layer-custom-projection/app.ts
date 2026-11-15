// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {Deck, _CustomProjectionView as CustomProjectionView} from '@deck.gl/core';
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

type ProjectionOption = {
  id: 'utm-32n' | 'conus-albers' | 'south-polar-stereographic';
  label: string;
  /** A CRS that math.gl resolves: an EPSG code it knows, or a PROJ string. */
  crs: string;
  center: [number, number];
  zoom: number;
  /**
   * The area of use of the CRS, `[west, south, east, north]`. The camera stays in it: math.gl
   * draws no map outside the area of use of an EPSG code, and the controller of
   * `_CustomProjectionView` moves the view center out of the projection when it zooms out
   * around a point outside it.
   */
  areaOfUse: [number, number, number, number];
};

type ExampleSettings = {
  view: {
    projection: ProjectionOption['id'];
  };
};

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const ATTRIBUTION_HTML = [
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>'
].join(' ');

const PROJECTION_OPTIONS: ProjectionOption[] = [
  {
    id: 'utm-32n',
    label: 'UTM zone 32N (EPSG:32632)',
    crs: 'EPSG:32632',
    center: [11.576, 48.137],
    zoom: 11,
    areaOfUse: [6, 0, 12, 84]
  },
  {
    id: 'conus-albers',
    label: 'Conus Albers (EPSG:5070)',
    crs: '+proj=aea +lat_0=23 +lon_0=-96 +lat_1=29.5 +lat_2=45.5 +x_0=0 +y_0=0 +datum=NAD83 +units=m +no_defs',
    center: [-77.036, 38.907],
    zoom: 10.5,
    areaOfUse: [-124.79, 24.41, -66.91, 49.38]
  },
  {
    id: 'south-polar-stereographic',
    label: 'South polar stereographic (EPSG:3031)',
    crs: '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    center: [0, -82],
    zoom: 2.4,
    areaOfUse: [-180, -90, 180, -60]
  }
];

const SETTINGS_SCHEMA: SettingsSchema = {
  title: 'Settings',
  sections: [
    {
      id: 'settings',
      name: 'Settings',
      settings: [
        {
          name: 'view.projection',
          label: 'Projection',
          type: 'select',
          options: PROJECTION_OPTIONS.map(option => ({label: option.label, value: option.id})),
          description: 'The coordinate reference system of the `_CustomProjectionView`.'
        }
      ]
    }
  ]
};

/** Draws `BasemapLayer` in a deck.gl `_CustomProjectionView` with a choice of projections. */
export function mountBasemapCustomProjectionExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  const settings: ExampleSettings = {view: {projection: PROJECTION_OPTIONS[0].id}};
  const infoWidget = new BoxPanelWidget({
    style: EXAMPLE_PANEL_STYLE,
    id: 'basemap-custom-projection-info',
    placement: 'top-left',
    widthPx: 360,
    title: 'BasemapLayer',
    collapsible: true
  });

  const deck = new Deck({
    parent: rootElement,
    ...getViewProps(getProjection(settings)),
    layers: [new BasemapLayer({id: 'basemap', style: STYLE_URL})],
    widgets: [infoWidget]
  });
  rootElement.append(createAttribution(rootElement.ownerDocument));
  syncInfoWidget();

  return () => {
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  function syncInfoWidget() {
    const projection = getProjection(settings);
    infoWidget.setProps({
      panel: new ColumnPanel({
        id: 'basemap-custom-projection-panel',
        title: 'BasemapLayer',
        panels: [
          new MarkdownPanel({
            id: 'summary',
            title: '',
            markdown: [
              'A `BasemapLayer` in a `_CustomProjectionView`. The tiles are Web Mercator tiles;',
              'deck.gl draws their geometry in the coordinate reference system of the view.',
              '',
              `- CRS: \`${projection.crs}\``
            ].join('\n')
          }),
          new SettingsPanel({
            id: 'settings',
            label: 'Settings',
            schema: SETTINGS_SCHEMA,
            settings: settings as unknown as SettingsState,
            onSettingsChange: nextSettings => {
              const nextProjection = PROJECTION_OPTIONS.find(
                option => option.id === getValueAtPath(nextSettings, 'view.projection')
              );
              if (nextProjection && nextProjection.id !== settings.view.projection) {
                settings.view.projection = nextProjection.id;
                deck.setProps(getViewProps(nextProjection));
                syncInfoWidget();
              }
            }
          })
        ]
      })
    });
  }
}

function getProjection(settings: ExampleSettings): ProjectionOption {
  return (
    PROJECTION_OPTIONS.find(option => option.id === settings.view.projection) ||
    PROJECTION_OPTIONS[0]
  );
}

function getViewProps(projection: ProjectionOption) {
  const [west, south, east, north] = projection.areaOfUse;
  return {
    views: new CustomProjectionView({id: projection.id, crs: projection.crs}),
    // Deck's `controller` replaces the controller of the first view.
    controller: {
      maxBounds: [
        [west, south],
        [east, north]
      ] as [[number, number], [number, number]]
    },
    initialViewState: {
      center: [projection.center[0], projection.center[1], 0] as [number, number, number],
      zoom: projection.zoom
    }
  };
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
