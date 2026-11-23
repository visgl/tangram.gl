// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {
  AmbientLight,
  Deck,
  DirectionalLight,
  LightingEffect,
  MapView,
  type Layer,
  type MapViewState
} from '@deck.gl/core';
import {_TerrainExtension as TerrainExtension, type TerrainExtensionProps} from '@deck.gl/extensions';
import {TerrainLayer} from '@deck.gl/geo-layers';
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

import '@deck.gl/widgets/stylesheet.css';

import {
  DEPTH_TINT_TILES,
  TERRARIUM_MAX_ZOOM,
  TERRARIUM_TILES,
  fetchDepthTint,
  getTerrariumDecoder
} from './elevation-tiles';
import {CANYON_AXIS, LEVEL_LINE, interpolateLine, type LngLat} from './tracks';

type ExampleSettings = {
  terrain: {
    exaggeration: number;
    seaSurface: boolean;
  };
  data: {
    tracks: boolean;
  };
  camera: {
    orbit: boolean;
  };
};

/** A MapLibre style document, as far as this example changes it. */
type StyleDocument = {
  sources: Record<string, {type?: string; tiles?: string[]; [key: string]: unknown}>;
  layers: {id: string; type?: string; source?: string; [key: string]: unknown}[];
  [key: string]: unknown;
};

/** A position as `[longitude, latitude, height]`, with the height in meters. */
type Position3D = [number, number, number];

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const ATTRIBUTION_HTML = [
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Terrain Tiles: Mapzen, NOAA, USGS and others</a>'
].join(' ');

const INITIAL_VIEW_STATE: MapViewState = {
  longitude: -122.06,
  latitude: 36.72,
  zoom: 9.9,
  pitch: 58,
  bearing: 68,
  maxPitch: 80,
  minZoom: 7,
  maxZoom: 13
};

/** The height of the terrain-following track above the seabed, in meters. */
const TRACK_ALTITUDE = 60;

/** The height of the level line, in meters. It is below sea level. */
const LEVEL_LINE_HEIGHT = -800;

/** The height of the sea surface, in meters. It is below 0 m, the height of flat shores. */
const SEA_SURFACE_HEIGHT = -3;

/** The area of the sea surface, as `[west, south, east, north]`. */
const SEA_SURFACE_BOUNDS = [-126.5, 33.5, -119.5, 39.5];

/** The turn of the camera in one second of the orbit, in degrees. */
const ORBIT_SPEED = 4;

/**
 * deck.gl moves each layer toward the camera in the depth buffer, by an offset that increases with
 * the index of the layer. That keeps flat layers apart. `BasemapLayer` makes many layers, so the
 * offset of a layer after it is large: the layer shows through terrain that is in front of it.
 * The layers of this example are at their own heights, and they need no offset.
 */
const NO_POLYGON_OFFSET = (): [number, number] => [0, 0];

/** One object for all updates: `BasemapLayer` loads its tiles again for new load options. */
const BASEMAP_LOAD_OPTIONS = {fetch: fetchDepthTint};

/** Shared by the basemap and the track, so deck.gl does not see their extensions change. */
const TERRAIN_EXTENSION = new TerrainExtension();

const LIGHTING_EFFECT = new LightingEffect({
  ambient: new AmbientLight({color: [255, 255, 255], intensity: 1.1}),
  sun: new DirectionalLight({color: [255, 250, 240], intensity: 1.2, direction: [2, -3, -2.2]})
});

const SETTINGS_SCHEMA: SettingsSchema = {
  title: 'Settings',
  sections: [
    {
      id: 'settings',
      name: 'Settings',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'terrain.exaggeration',
          label: 'Vertical exaggeration',
          type: 'number',
          min: 1,
          max: 8,
          step: 0.5,
          sliderDebounceMs: 150,
          description: 'The factor on land and seabed heights. The data layers use the same factor.'
        },
        {
          name: 'terrain.seaSurface',
          label: 'Sea surface',
          type: 'boolean',
          description: 'A translucent deck.gl polygon at sea level. The terrain cuts it at the shore.'
        },
        {
          name: 'data.tracks',
          label: 'Data layers',
          type: 'boolean',
          description: 'A track that follows the seabed, and a level line that the terrain hides.'
        },
        {
          name: 'camera.orbit',
          label: 'Orbit the camera',
          type: 'boolean',
          description: 'Turns the camera around the view center.'
        }
      ]
    }
  ]
};

/**
 * A `BasemapLayer` that deck.gl's `TerrainExtension` drapes on the terrain. The extension goes to
 * each layer that `BasemapLayer` makes from the style. deck.gl draws fills, lines and rasters into
 * the texture of the terrain, and it moves each label up or down to the height of the terrain.
 */
class DrapedBasemapLayer extends BasemapLayer {
  static layerName = 'DrapedBasemapLayer';

  renderLayers() {
    return (super.renderLayers() as any[]).flat(Infinity).filter(Boolean).map(layer =>
      layer.clone({extensions: [...(layer.props.extensions || []), TERRAIN_EXTENSION]})
    );
  }
}

/**
 * Draws a vector basemap on a 3D terrain of land and seabed, with deck.gl data layers in the same
 * scene and the same depth buffer.
 */
export function mountBasemapDrapedTerrainExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  const settings: ExampleSettings = {
    terrain: {exaggeration: 4, seaSurface: true},
    data: {tracks: true},
    camera: {orbit: false}
  };
  // Kept until the exaggeration changes: `TerrainLayer` makes its meshes again for a new object.
  let terrainProps = getTerrainProps(settings.terrain.exaggeration);
  let viewState = INITIAL_VIEW_STATE;
  let style: StyleDocument | null = null;
  /** Why the style did not load, or null. */
  let styleError: string | null = null;
  let isMounted = true;
  let orbitFrame = 0;
  let orbitTime = 0;

  const infoWidget = new BoxPanelWidget({
    style: EXAMPLE_PANEL_STYLE,
    id: 'basemap-draped-terrain-info',
    placement: 'top-left',
    widthPx: 360,
    title: 'BasemapLayer on terrain',
    collapsible: true
  });

  const deck = new Deck({
    parent: rootElement,
    views: new MapView({id: 'map', farZMultiplier: 3}),
    controller: {touchRotate: true},
    viewState,
    onViewStateChange: ({viewState: nextViewState}) => {
      viewState = nextViewState as MapViewState;
      deck.setProps({viewState});
    },
    effects: [LIGHTING_EFFECT],
    layers: getLayers(),
    widgets: [infoWidget]
  });
  rootElement.append(createAttribution(rootElement.ownerDocument));
  syncInfoWidget();

  loadStyle().then(
    loadedStyle => {
      if (isMounted) {
        style = loadedStyle;
        deck.setProps({layers: getLayers()});
      }
    },
    (error: unknown) => {
      if (isMounted) {
        styleError = `The basemap style did not load: ${getMessage(error)}`;
        syncInfoWidget();
      }
    }
  );

  return () => {
    isMounted = false;
    cancelAnimationFrame(orbitFrame);
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  function getLayers(): Layer[] {
    const {exaggeration, seaSurface} = settings.terrain;
    const [west, south, east, north] = SEA_SURFACE_BOUNDS;
    const seaSurfaceHeight = SEA_SURFACE_HEIGHT * exaggeration;
    return [
      new TerrainLayer({
        id: 'terrain',
        // The layer draws the terrain, and it is the surface that `TerrainExtension` layers use.
        operation: 'terrain+draw',
        elevationData: TERRARIUM_TILES,
        maxZoom: TERRARIUM_MAX_ZOOM,
        ...terrainProps,
        color: [226, 222, 212],
        material: {ambient: 0.5, diffuse: 0.55, shininess: 8, specularColor: [20, 20, 20]}
      }),
      style &&
        new DrapedBasemapLayer({id: 'basemap', style, loadOptions: BASEMAP_LOAD_OPTIONS}),
      ...(settings.data.tracks ? getDataLayers(exaggeration) : []),
      seaSurface &&
        new SolidPolygonLayer<LngLat[]>({
          id: 'sea-surface',
          data: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north]
            ]
          ],
          getPolygon: polygon => atHeight(polygon, seaSurfaceHeight),
          getFillColor: [128, 196, 232, 52],
          // The sea surface is not a light surface of the terrain.
          material: false,
          getPolygonOffset: NO_POLYGON_OFFSET,
          updateTriggers: {getPolygon: seaSurfaceHeight}
        })
    ].filter(Boolean) as Layer[];
  }

  function syncInfoWidget() {
    infoWidget.setProps({
      panel: new ColumnPanel({
        id: 'basemap-draped-terrain-panel',
        title: 'BasemapLayer on terrain',
        panels: [
          new MarkdownPanel({
            id: 'summary',
            title: '',
            markdown: [
              'The OpenFreeMap Liberty style, drawn by `BasemapLayer` and draped on the land and the',
              'seabed of Monterey Bay by deck.gl’s `TerrainExtension`. The basemap, the terrain and',
              'the data layers share one depth buffer.',
              '',
              '- **Orange**: a track 60 m above the axis of Monterey Canyon. It follows the terrain.',
              '- **Yellow**: a level line at a depth of 800 m. The terrain hides it where the seabed is higher.',
              '- **Depth tint and isobaths**: a raster layer of the style, made from the same heights.'
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
              const exaggeration = Number(getValueAtPath(nextSettings, 'terrain.exaggeration'));
              if (Number.isFinite(exaggeration) && exaggeration !== settings.terrain.exaggeration) {
                settings.terrain.exaggeration = Math.min(Math.max(exaggeration, 1), 8);
                terrainProps = getTerrainProps(settings.terrain.exaggeration);
              }
              settings.terrain.seaSurface = Boolean(
                getValueAtPath(nextSettings, 'terrain.seaSurface')
              );
              settings.data.tracks = Boolean(getValueAtPath(nextSettings, 'data.tracks'));
              settings.camera.orbit = Boolean(getValueAtPath(nextSettings, 'camera.orbit'));
              deck.setProps({layers: getLayers()});
              syncOrbit();
            }
          })
        ]
      })
    });
  }

  /** Starts or stops the turn of the camera. */
  function syncOrbit() {
    cancelAnimationFrame(orbitFrame);
    if (!settings.camera.orbit) {
      return;
    }
    orbitTime = performance.now();
    const turn = (time: number) => {
      const bearing = (viewState.bearing || 0) + ((time - orbitTime) / 1000) * ORBIT_SPEED;
      orbitTime = time;
      viewState = {...viewState, bearing: ((bearing + 540) % 360) - 180};
      deck.setProps({viewState});
      orbitFrame = requestAnimationFrame(turn);
    };
    orbitFrame = requestAnimationFrame(turn);
  }
}

/** The props of the `TerrainLayer` that change with the exaggeration. */
function getTerrainProps(exaggeration: number) {
  return {
    elevationDecoder: getTerrariumDecoder(exaggeration),
    // The error of the mesh is 1.5 m of true height: the smooth seabed has no flat facets.
    meshMaxError: 1.5 * exaggeration,
    // Skirts close the steps between the edges of adjacent tiles.
    loadOptions: {terrain: {skirtHeight: 60 * exaggeration}}
  };
}

/** The data layers. Their heights are in meters, multiplied by the exaggeration of the terrain. */
function getDataLayers(exaggeration: number): Layer[] {
  const trackHeight = TRACK_ALTITUDE * exaggeration;
  const lineHeight = LEVEL_LINE_HEIGHT * exaggeration;
  const levelLine = interpolateLine(LEVEL_LINE[0], LEVEL_LINE[1], 64);
  return [
    new PathLayer<LngLat[]>({
      id: 'level-line',
      data: [levelLine],
      getPath: path => atHeight(path, lineHeight),
      getColor: [255, 214, 48],
      getWidth: 5,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      getPolygonOffset: NO_POLYGON_OFFSET,
      updateTriggers: {getPath: lineHeight}
    }),
    new PathLayer<LngLat[], TerrainExtensionProps>({
      id: 'canyon-track',
      data: [CANYON_AXIS],
      // `TerrainExtension` adds the height of the terrain to each position. Without
      // `terrainDrawMode`, it drapes a path flat on the terrain.
      extensions: [TERRAIN_EXTENSION],
      terrainDrawMode: 'offset',
      getPath: path => atHeight(path, trackHeight),
      getColor: [255, 122, 40],
      getWidth: 5,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      getPolygonOffset: NO_POLYGON_OFFSET,
      updateTriggers: {getPath: trackHeight}
    }),
    new ScatterplotLayer<LngLat>({
      id: 'canyon-track-ends',
      data: [CANYON_AXIS[0], CANYON_AXIS[CANYON_AXIS.length - 1]],
      extensions: [TERRAIN_EXTENSION],
      getPosition: ([longitude, latitude]) => [longitude, latitude, trackHeight],
      getFillColor: [255, 255, 255],
      getLineColor: [255, 122, 40],
      stroked: true,
      getRadius: 7,
      radiusUnits: 'pixels',
      getLineWidth: 3,
      lineWidthUnits: 'pixels',
      billboard: true,
      getPolygonOffset: NO_POLYGON_OFFSET,
      updateTriggers: {getPosition: trackHeight}
    })
  ];
}

/** The positions at `height` meters. */
function atHeight(positions: LngLat[], height: number): Position3D[] {
  return positions.map(([longitude, latitude]) => [longitude, latitude, height]);
}

/** Fetches a style document. Rejects with the URL and the HTTP status when the response is not OK. */
async function fetchStyle(url: string): Promise<StyleDocument> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} failed: ${response.status} ${response.statusText}`.trim());
  }
  return (await response.json()) as StyleDocument;
}

/**
 * The Liberty style with a raster layer of the depth tint above its water. The layer is a part of
 * the style: it is below the roads, the boundaries and the labels.
 */
async function loadStyle(): Promise<StyleDocument> {
  const style = await fetchStyle(STYLE_URL);
  const waterIndex = style.layers.findIndex(layer => layer.id === 'water');
  const layers = [...style.layers];
  layers.splice(waterIndex + 1, 0, {
    id: 'depth-tint',
    type: 'raster',
    source: 'depth-tint',
    paint: {'raster-fade-duration': 0}
  });
  return {
    ...style,
    sources: {
      ...style.sources,
      'depth-tint': {
        type: 'raster',
        tiles: [DEPTH_TINT_TILES],
        tileSize: 256,
        maxzoom: TERRARIUM_MAX_ZOOM
      }
    },
    layers
  };
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
  // The sky above the horizon of the pitched view. Below it, the color is the color of deep water.
  root.style.background = 'linear-gradient(#a9cdea, #4b82b4 32%, #3f76ac)';
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
