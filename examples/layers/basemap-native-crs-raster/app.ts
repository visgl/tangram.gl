// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {EXAMPLE_PANEL_STYLE} from '../../utils/panel-theme';
import {
  Deck,
  MapView,
  WebMercatorViewport,
  _CustomProjectionView as CustomProjectionView
} from '@deck.gl/core';
import {BitmapLayer, PathLayer, TextLayer} from '@deck.gl/layers';
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
  formatDistance,
  formatGridValue,
  getGridLines,
  getGridStep,
  intersectBounds,
  snapBoundsOut,
  type Bounds,
  type GridLine
} from './grid';
import {NativeRaster, type RasterImage, type RasterInfo} from './native-raster';
import {
  containsBounds,
  expandBounds,
  getRasterWindow,
  selectRasterLevel,
  type RasterLevel,
  type RasterTint
} from './raster-window';

import '@deck.gl/widgets/stylesheet.css';

type ProjectionMode = 'native' | 'web-mercator';

type Scene = {
  id: 'utm-32n' | 'antarctic-polar-stereographic';
  label: string;
  /** The name of the coordinate reference system of the rasters. */
  crsLabel: string;
  /**
   * The coordinate reference system of the rasters, as a PROJ string. The view and each layer of
   * the scene take the same string: deck.gl then draws the layer's coordinates as they are.
   */
  crs: string;
  /** The names of the two axes in the grid labels. */
  axes: [string, string];
  /** The Cloud Optimized GeoTIFFs of the scene. Each is in `crs`. */
  rasters: string[];
  /** A color ramp for single-band rasters. */
  tint?: RasterTint;
  /** The bounds of the rasters together, in `crs`. */
  dataBounds: Bounds;
  /** A longitude/latitude near the center of the rasters. */
  center: [number, number];
  /** The first zoom of the projected view. */
  zoom: number;
  minZoom: number;
  maxZoom: number;
  /** `BasemapLayer`'s `projectedMaxStretch`, when the default is too low for the projection. */
  maxStretch?: number;
  attribution: string;
};

type ExampleSettings = {
  scene: Scene['id'];
  projection: ProjectionMode;
  grid: boolean;
  imagery: boolean;
};

/** The view center in longitude/latitude, and the zoom of the projected view. */
type Camera = {longitude: number; latitude: number; zoom: number};

type ProjectedCRS = NonNullable<ReturnType<CustomProjectionView['makeViewport']>>['crs'];

type RasterState = {
  source: NativeRaster;
  info?: RasterInfo;
  /** The coarse level that is always drawn. */
  baseLevel?: RasterLevel;
  base?: RasterImage;
  /** The block of finer pixels for the area on the screen. */
  detail?: RasterImage;
};

type SceneState = {
  scene: Scene;
  view: CustomProjectionView;
  crs: ProjectedCRS;
  rasters: RasterState[];
  abort: AbortController;
};

/** The geometry of the current view, measured through the viewport. */
type Frame = {
  width: number;
  height: number;
  /** The area on the screen, in the coordinate reference system of the scene. */
  bounds: Bounds;
  /** Units of the coordinate reference system for each pixel, at the view center. */
  unitsPerPixel: number;
  toPixel: (position: number[]) => number[];
  toProjected: (pixel: number[]) => number[];
  /** The length on the screen, in pixels, of one metre on the ground at a pixel. */
  getPixelsPerMetre: (pixel: number[]) => number;
};

type GridLabel = {position: number[]; text: string; angle: number; axis: 'x' | 'y'};

/** A style document, as `BasemapLayer` takes it. */
type BasemapStyle = Exclude<BasemapLayer['props']['style'], string | null>;
type BasemapStyleLayer = NonNullable<BasemapStyle['layers']>[number];

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

const BASEMAP_ATTRIBUTION = [
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
  '<a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">&copy; OpenMapTiles</a>',
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  '<a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener">Natural Earth</a>'
].join(' ');

const REMA_TILES = ['17_33', '17_34', '17_35', '18_33', '18_34', '18_35'];

const SCENES: Scene[] = [
  {
    id: 'utm-32n',
    label: 'Sentinel-2 image in UTM zone 32N',
    crsLabel: 'UTM zone 32N (EPSG:32632)',
    // EPSG:32632 as a PROJ string. For the code, math.gl draws only the 6 degrees of the zone, and
    // this image starts west of them.
    crs: '+proj=tmerc +lat_0=0 +lon_0=9 +k=0.9996 +x_0=500000 +y_0=0 +datum=WGS84 +units=m +no_defs',
    axes: ['E', 'N'],
    rasters: [
      'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/32/V/LN/2020/8/S2B_32VLN_20200816_1_L2A/TCI.tif'
    ],
    dataBounds: [300000, 6690240, 409800, 6800040],
    center: [6.32, 60.82],
    zoom: 9.1,
    minZoom: 6,
    maxZoom: 16,
    attribution:
      'Contains modified <a href="https://www.copernicus.eu/en/access-data" target="_blank" rel="noopener">Copernicus Sentinel</a> data 2020'
  },
  {
    id: 'antarctic-polar-stereographic',
    label: 'REMA hillshade in Antarctic polar stereographic',
    crsLabel: 'Antarctic polar stereographic (EPSG:3031)',
    crs: '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs',
    axes: ['X', 'Y'],
    rasters: REMA_TILES.map(
      tile =>
        `https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/rema/mosaics/v2.0/32m/${tile}/${tile}_32m_v2.0_browse.tif`
    ),
    tint: [
      [36, 58, 92],
      [250, 252, 255]
    ],
    dataBounds: [199904, -1400096, 500096, -1199904],
    center: [164.9, -77.7],
    zoom: 8.1,
    minZoom: 4,
    maxZoom: 14,
    // The scale of the projection grows steeply away from the pole.
    maxStretch: 16,
    attribution:
      '<a href="https://www.pgc.umn.edu/data/rema/" target="_blank" rel="noopener">REMA</a> &copy; Polar Geospatial Center (CC BY 4.0)'
  }
];

const SETTINGS_SCHEMA: SettingsSchema = {
  title: 'Settings',
  sections: [
    {
      id: 'settings',
      name: 'Settings',
      initiallyCollapsed: false,
      settings: [
        {
          name: 'scene',
          label: 'Scene',
          type: 'select',
          options: SCENES.map(scene => ({label: scene.label, value: scene.id})),
          description: 'A Cloud Optimized GeoTIFF and its coordinate reference system.'
        },
        {
          name: 'projection',
          label: 'Projection',
          type: 'select',
          options: [
            {label: 'CRS of the raster', value: 'native'},
            {label: 'Web Mercator', value: 'web-mercator'}
          ],
          description:
            'Draw the same layers in a `_CustomProjectionView` in the CRS of the raster, or in a `MapView`.'
        },
        {
          name: 'grid',
          label: 'Projected grid',
          type: 'boolean',
          description: 'A grid in the metres of the CRS of the raster.'
        },
        {
          name: 'imagery',
          label: 'Raster',
          type: 'boolean',
          description: 'The GeoTIFF, between the fills and the roads and labels of the basemap.'
        }
      ]
    }
  ]
};

/** One object for each render: `BasemapLayer` resolves the style again when it changes. */
const BASEMAP_LOAD_OPTIONS = {baseUrl: STYLE_URL};
/** The length of the equator in metres: the width of the Web Mercator world. */
const EARTH_CIRCUMFERENCE = 40075016.6855;
/** The largest block of fine pixels that one read loads. */
const MAX_DETAIL_PIXELS = 9_000_000;
/** The largest overview that is loaded whole. */
const MAX_BASE_SIZE = 1600;
const LABEL_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * Draws a vector basemap and Cloud Optimized GeoTIFFs in the coordinate reference system of the
 * GeoTIFFs, with a grid in projected metres, and compares the scene with Web Mercator.
 */
export function mountBasemapNativeCrsRasterExample(container: HTMLElement): () => void {
  const rootElement = createRoot(container);
  const ownerDocument = rootElement.ownerDocument;
  const settings: ExampleSettings = {
    scene: SCENES[0].id,
    projection: 'native',
    grid: true,
    imagery: true
  };
  const mapView = new MapView({id: 'web-mercator', repeat: false});
  const hud = createHud(ownerDocument);
  const attribution = createAttribution(ownerDocument);
  const infoWidget = new BoxPanelWidget({
    style: EXAMPLE_PANEL_STYLE,
    id: 'basemap-native-crs-raster-info',
    placement: 'top-left',
    widthPx: 360,
    title: 'BasemapLayer',
    collapsible: true
  });

  let disposed = false;
  let styles: {under: BasemapStyle; over: BasemapStyle} | null = null;
  let state: SceneState | null = null;
  let camera: Camera = {longitude: 0, latitude: 0, zoom: 1};
  let frame: Frame | null = null;
  let pointer: number[] | null = null;
  let pendingReads = 0;
  let gridCache: {key: string; lines: GridLine[]} | null = null;
  let detailTimer: ReturnType<typeof setTimeout> | undefined;
  let detailAbort: AbortController | null = null;

  const deck = new Deck({
    parent: rootElement,
    // The view changes between the two kinds when the projection setting changes.
    views: mapView as MapView | CustomProjectionView,
    viewState: {longitude: 0, latitude: 0, zoom: 1},
    controller: {dragRotate: false, touchRotate: false},
    layers: [],
    widgets: [infoWidget],
    onViewStateChange: ({viewState}) => {
      handleViewState(viewState as Record<string, unknown>);
    },
    onResize: () => renderView()
  });
  rootElement.append(hud.element, attribution);
  rootElement.addEventListener('pointermove', handlePointerMove);
  rootElement.addEventListener('pointerleave', handlePointerLeave);
  syncInfoWidget();
  void loadStyle();
  void activateScene(getScene(settings));

  return () => {
    disposed = true;
    clearTimeout(detailTimer);
    detailAbort?.abort();
    releaseScene();
    rootElement.removeEventListener('pointermove', handlePointerMove);
    rootElement.removeEventListener('pointerleave', handlePointerLeave);
    deck.finalize();
    rootElement.remove();
    container.replaceChildren();
  };

  /** Loads the style and divides its layers into the layers below and above the raster. */
  async function loadStyle() {
    try {
      const response = await fetch(STYLE_URL);
      const style = (await response.json()) as BasemapStyle;
      if (disposed) {
        return;
      }
      const layers = style.layers || [];
      const isAbove = (layer: BasemapStyleLayer) =>
        layer.type === 'symbol' ||
        (layer.type === 'line' &&
          (layer['source-layer'] === 'transportation' || layer['source-layer'] === 'boundary'));
      styles = {
        under: {...style, layers: layers.filter(layer => !isAbove(layer))},
        over: {...style, layers: layers.filter(isAbove)}
      };
      render();
    } catch (error) {
      hud.setStatus(`The basemap style did not load: ${getMessage(error)}`);
    }
  }

  async function activateScene(scene: Scene) {
    releaseScene();
    const view = new CustomProjectionView({id: scene.id, crs: scene.crs});
    await view.initialize();
    if (disposed || settings.scene !== scene.id) {
      return;
    }
    // The viewport gives the resolved CRS, which converts between longitude/latitude and metres.
    const probe = view.makeViewport({
      width: 1,
      height: 1,
      viewState: {center: [scene.center[0], scene.center[1], 0], zoom: 0}
    });
    if (!probe) {
      return;
    }
    const crs = probe.crs;
    const [minX, minY, maxX, maxY] = scene.dataBounds;
    const center = crs.converter.WGS84.to([(minX + maxX) / 2, (minY + maxY) / 2]);
    const sceneState: SceneState = {
      scene,
      view,
      crs,
      rasters: scene.rasters.map(url => ({source: new NativeRaster(url, scene.tint)})),
      abort: new AbortController()
    };
    state = sceneState;
    camera = {longitude: center[0], latitude: center[1], zoom: scene.zoom};
    attribution.innerHTML = `${scene.attribution} | ${BASEMAP_ATTRIBUTION}`;
    renderView();
    for (const raster of sceneState.rasters) {
      void loadBase(sceneState, raster);
    }
  }

  function releaseScene() {
    clearTimeout(detailTimer);
    detailAbort?.abort();
    state?.abort.abort();
    for (const raster of state?.rasters || []) {
      raster.source.finalize();
    }
    state = null;
    frame = null;
    gridCache = null;
    pointer = null;
    pendingReads = 0;
  }

  /** Loads the header of a raster and one coarse level of the whole raster. */
  async function loadBase(sceneState: SceneState, raster: RasterState) {
    const {signal} = sceneState.abort;
    pendingReads++;
    try {
      const info = await raster.source.open(signal);
      const baseLevel =
        info.levels.find(level => Math.max(level.width, level.height) <= MAX_BASE_SIZE) ||
        info.levels[info.levels.length - 1];
      const window = getRasterWindow(info.bounds, baseLevel, info.bounds);
      if (!window) {
        return;
      }
      raster.info = info;
      raster.baseLevel = baseLevel;
      raster.base = await raster.source.read(window, baseLevel, signal);
    } catch (error) {
      if (!signal.aborted) {
        hud.setStatus(`The raster did not load: ${getMessage(error)}`);
      }
    } finally {
      if (state === sceneState) {
        pendingReads--;
        renderView();
      }
    }
  }

  /** Loads the pixels that the screen can show, for the area on the screen. */
  async function loadDetail() {
    const sceneState = state;
    if (!sceneState || !frame || !settings.imagery) {
      return;
    }
    detailAbort?.abort();
    const abort = new AbortController();
    detailAbort = abort;
    const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const unitsPerPixel = frame.unitsPerPixel / pixelRatio;
    const visible = frame.bounds;
    await Promise.all(
      sceneState.rasters.map(async raster => {
        const {info, baseLevel} = raster;
        if (!info || !baseLevel) {
          return;
        }
        let level = selectRasterLevel(info.levels, unitsPerPixel);
        let window = getRasterWindow(info.bounds, level, expandBounds(visible, 0.2));
        // A block that is too large for one read comes from a coarser level.
        while (
          window &&
          window.width * window.height > MAX_DETAIL_PIXELS &&
          level.index < baseLevel.index
        ) {
          level = info.levels[level.index + 1];
          window = getRasterWindow(info.bounds, level, expandBounds(visible, 0.2));
        }
        if (!window || level.index >= baseLevel.index) {
          raster.detail = undefined;
          return;
        }
        const needed = intersectBounds(visible, info.bounds);
        if (
          needed &&
          raster.detail?.level.index === level.index &&
          containsBounds(raster.detail.bounds, needed)
        ) {
          return;
        }
        pendingReads++;
        render();
        try {
          const detail = await raster.source.read(window, level, abort.signal);
          if (!abort.signal.aborted) {
            raster.detail = detail;
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            hud.setStatus(`The raster did not load: ${getMessage(error)}`);
          }
        } finally {
          if (state === sceneState) {
            pendingReads--;
          }
        }
      })
    );
    if (state === sceneState && !abort.signal.aborted) {
      render();
    }
  }

  function handleViewState(viewState: Record<string, unknown>) {
    if (!state) {
      return;
    }
    if (settings.projection === 'native') {
      const center = viewState.center as number[];
      camera = {longitude: center[0], latitude: center[1], zoom: viewState.zoom as number};
    } else {
      const longitude = viewState.longitude as number;
      const latitude = viewState.latitude as number;
      camera = {
        longitude,
        latitude,
        zoom: (viewState.zoom as number) - getMercatorZoomOffset(state.crs, longitude, latitude)
      };
    }
    camera = clampCamera(camera, state);
    renderView();
  }

  function handlePointerMove(event: PointerEvent) {
    const bounds = rootElement.getBoundingClientRect();
    pointer = [event.clientX - bounds.left, event.clientY - bounds.top];
    updateHud();
  }

  function handlePointerLeave() {
    pointer = null;
    updateHud();
  }

  function render() {
    const sceneState = state;
    const width = rootElement.clientWidth;
    const height = rootElement.clientHeight;
    if (disposed || !sceneState || !width || !height) {
      return;
    }
    const {scene, crs} = sceneState;
    const native = settings.projection === 'native';
    const mercatorViewState = {
      longitude: camera.longitude,
      latitude: camera.latitude,
      zoom: camera.zoom + getMercatorZoomOffset(crs, camera.longitude, camera.latitude),
      pitch: 0,
      bearing: 0
    };
    const projectedViewState = {
      center: [camera.longitude, camera.latitude, 0] as [number, number, number],
      zoom: camera.zoom
    };
    const viewport = native
      ? sceneState.view.makeViewport({width, height, viewState: projectedViewState})
      : new WebMercatorViewport({width, height, ...mercatorViewState});
    if (!viewport) {
      return;
    }
    frame = measureFrame(viewport, crs, width, height, native ? null : mercatorViewState.zoom);

    const basemapProps = {
      loadOptions: BASEMAP_LOAD_OPTIONS,
      ...(scene.maxStretch !== undefined && {projectedMaxStretch: scene.maxStretch})
    };
    // A layer keeps the state of one kind of view: each projection has its own layers.
    const suffix = settings.projection;
    const gridLines = settings.grid ? getGrid(scene, frame) : [];
    const gridProps = {
      data: gridLines,
      getPath: (line: GridLine) => line.path,
      coordinateSystem: scene.crs,
      widthUnits: 'pixels' as const,
      jointRounded: true
    };
    deck.setProps({
      ...(native
        ? {views: sceneState.view, viewState: projectedViewState}
        : {views: mapView, viewState: mercatorViewState}),
      layers: [
        new BasemapLayer({id: `basemap-under-${suffix}`, style: styles?.under ?? null, ...basemapProps}),
        ...(settings.imagery ? getRasterLayers(sceneState, suffix) : []),
        new PathLayer<GridLine>({
          ...gridProps,
          id: `grid-casing-${suffix}`,
          getColor: [12, 22, 34, 70],
          getWidth: line => (line.major ? 3.2 : 2.4)
        }),
        new PathLayer<GridLine>({
          ...gridProps,
          id: `grid-${suffix}`,
          getColor: line => (line.major ? [255, 255, 255, 235] : [255, 255, 255, 170]),
          getWidth: line => (line.major ? 1.6 : 1)
        }),
        new BasemapLayer({id: `basemap-over-${suffix}`, style: styles?.over ?? null, ...basemapProps}),
        new TextLayer<GridLabel>({
          id: `grid-labels-${suffix}`,
          data: getGridLabels(gridLines, scene, frame),
          coordinateSystem: scene.crs,
          getPosition: label => [label.position[0], label.position[1], 0],
          getText: label => label.text,
          getAngle: label => label.angle,
          getSize: 11,
          getColor: [255, 255, 255, 255],
          getTextAnchor: label => (label.axis === 'x' ? 'middle' : 'end'),
          getAlignmentBaseline: 'center',
          getPixelOffset: label => (label.axis === 'x' ? [0, 0] : [-4, 0]),
          fontFamily: LABEL_FONT,
          fontWeight: 600,
          background: true,
          getBackgroundColor: [15, 22, 32, 200],
          backgroundPadding: [4, 2],
          backgroundBorderRadius: 3,
          characterSet: 'auto'
        })
      ]
    });
    updateHud();
  }

  /** Draws the view, then loads the raster pixels for it when the view stops. */
  function renderView() {
    render();
    clearTimeout(detailTimer);
    detailTimer = setTimeout(() => void loadDetail(), 200);
  }

  function getRasterLayers(sceneState: SceneState, suffix: string) {
    const layers: BitmapLayer[] = [];
    sceneState.rasters.forEach((raster, index) => {
      for (const [name, image] of [
        ['base', raster.base],
        ['detail', raster.detail]
      ] as const) {
        if (image) {
          layers.push(
            new BitmapLayer({
              id: `raster-${index}-${name}-${suffix}`,
              image: image.image,
              bounds: image.bounds,
              // The bounds are metres of the CRS of the raster. In the projected view, that is
              // the CRS of the view, and the image is drawn as it is. In Web Mercator, deck.gl
              // converts the positions, and draws the image on a mesh that follows the warp.
              coordinateSystem: sceneState.scene.crs,
              // Show the pixels of the file as squares when the view is closer than the raster.
              textureParameters: {minFilter: 'linear', magFilter: 'nearest', mipmapFilter: 'linear'}
            })
          );
        }
      }
    });
    return layers;
  }

  function getGrid(scene: Scene, currentFrame: Frame): GridLine[] {
    const step = getGridStep(currentFrame.unitsPerPixel);
    const bounds = intersectBounds(
      snapBoundsOut(expandBounds(currentFrame.bounds, 0.25), step * 4),
      expandBounds(scene.dataBounds, 6)
    );
    if (!bounds) {
      return [];
    }
    const key = `${scene.id}|${step}|${bounds.join()}`;
    if (gridCache?.key !== key) {
      gridCache = {key, lines: getGridLines(bounds, step, 48)};
    }
    return gridCache.lines;
  }

  function updateHud() {
    const sceneState = state;
    if (!sceneState || !frame) {
      return;
    }
    const {scene} = sceneState;
    const native = settings.projection === 'native';
    const {width, height, unitsPerPixel} = frame;
    const top = [width / 2, 0];
    const bottom = [width / 2, height];
    // The ground distance of a bar that is at most 150 pixels long at the view center.
    const distance = getNiceDistance(150 / frame.getPixelsPerMetre([width / 2, height / 2]));
    const scales = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
      top,
      bottom,
      [width / 2, height / 2]
    ].map(frame.getPixelsPerMetre);
    const variation = (Math.max(...scales) / Math.min(...scales) - 1) * 100;
    const center = frame.toProjected([width / 2, height / 2]);
    const origin = frame.toPixel(center);
    const north = frame.toPixel([center[0], center[1] + unitsPerPixel * 64]);
    const northAngle =
      (Math.atan2(north[0] - origin[0], origin[1] - north[1]) * 180) / Math.PI || 0;

    const finest = Math.min(
      ...sceneState.rasters.map(
        raster => (raster.detail || raster.base)?.level.resolution ?? Infinity
      )
    );
    let position = '';
    if (pointer) {
      const [x, y] = frame.toProjected(pointer);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        position = `${scene.axes[0]} ${formatGridValue(x)} m   ${scene.axes[1]} ${formatGridValue(y)} m`;
      }
    }
    hud.update({
      title: native ? scene.crsLabel : 'Web Mercator (EPSG:3857)',
      distance: `${formatDistance(distance)} on the ground`,
      topBar: distance * frame.getPixelsPerMetre(top),
      bottomBar: distance * frame.getPixelsPerMetre(bottom),
      variation: `The scale changes ${formatPercent(variation)} across the view`,
      north:
        Math.abs(northAngle) < 0.05
          ? 'Grid north is up'
          : `Grid north is ${Math.abs(northAngle).toFixed(1)}° ${northAngle > 0 ? 'clockwise' : 'counterclockwise'} from up`,
      position,
      status: getImageryStatus(finest)
    });
  }

  function getImageryStatus(finest: number): string {
    if (!settings.imagery) {
      return '';
    }
    const loading = pendingReads > 0 ? ' · loading…' : '';
    return Number.isFinite(finest)
      ? `Raster: ${Math.round(finest)} m pixels${loading}`
      : `Raster${loading}`;
  }

  function syncInfoWidget() {
    infoWidget.setProps({
      panel: new ColumnPanel({
        id: 'basemap-native-crs-raster-panel',
        title: 'BasemapLayer',
        panels: [
          new MarkdownPanel({
            id: 'summary',
            title: '',
            markdown: [
              'A vector basemap and a Cloud Optimized GeoTIFF, drawn in the coordinate reference',
              'system of the GeoTIFF. The pixels of the raster are not resampled, and the roads',
              'and labels of the basemap draw above them.',
              '',
              'Select **Web Mercator** to see the same layers warped.'
            ].join('\n')
          }),
          new SettingsPanel({
            id: 'settings',
            label: 'Settings',
            schema: SETTINGS_SCHEMA,
            settings: {...settings} satisfies SettingsState,
            onSettingsChange: nextSettings => {
              const scene = SCENES.find(
                option => option.id === getValueAtPath(nextSettings, 'scene')
              );
              const projection = getValueAtPath(nextSettings, 'projection');
              const sceneChanged = Boolean(scene && scene.id !== settings.scene);
              if (scene) {
                settings.scene = scene.id;
              }
              if (projection === 'native' || projection === 'web-mercator') {
                settings.projection = projection;
              }
              settings.grid = Boolean(getValueAtPath(nextSettings, 'grid'));
              settings.imagery = Boolean(getValueAtPath(nextSettings, 'imagery'));
              if (sceneChanged && scene) {
                void activateScene(scene);
              } else {
                renderView();
              }
            }
          })
        ]
      })
    });
  }
}

function getScene(settings: ExampleSettings): Scene {
  return SCENES.find(scene => scene.id === settings.scene) || SCENES[0];
}

function toProjected(crs: ProjectedCRS, lngLat: number[]): number[] {
  const converter = crs.converter.WGS84;
  return converter.from(converter.normalize(lngLat));
}

/** The ratio of a distance in the CRS to the distance on the ground, at a projected position. */
function getProjectedScaleFactor(crs: ProjectedCRS, position: number[]): number {
  const scale = crs.getRenderingScale([position[0], position[1], 0]);
  return scale ? 1 / scale[0] : 1;
}

/**
 * The zoom of the Web Mercator view minus the zoom of the projected view, when both draw the
 * ground at the same scale at a position.
 */
function getMercatorZoomOffset(crs: ProjectedCRS, longitude: number, latitude: number): number {
  const scaleFactor = getProjectedScaleFactor(crs, toProjected(crs, [longitude, latitude]));
  return Math.log2(scaleFactor * Math.cos((latitude * Math.PI) / 180));
}

/** Keeps the view center near the rasters, and the zoom in the limits of the scene. */
function clampCamera(camera: Camera, {scene, crs}: SceneState): Camera {
  const zoom = Math.min(Math.max(camera.zoom, scene.minZoom), scene.maxZoom);
  const limit = expandBounds(scene.dataBounds, 0.75);
  const [x, y] = toProjected(crs, [camera.longitude, camera.latitude]);
  const clampedX = Math.min(Math.max(x, limit[0]), limit[2]);
  const clampedY = Math.min(Math.max(y, limit[1]), limit[3]);
  if (clampedX === x && clampedY === y) {
    return {...camera, zoom};
  }
  const [longitude, latitude] = crs.converter.WGS84.to([clampedX, clampedY]);
  return {longitude, latitude, zoom};
}

function measureFrame(
  viewport: {project: (position: number[]) => number[]; unproject: (pixel: number[]) => number[]},
  crs: ProjectedCRS,
  width: number,
  height: number,
  mercatorZoom: number | null
): Frame {
  const toPixel = (position: number[]) => viewport.project(crs.converter.WGS84.to(position));
  const toProjectedPixel = (pixel: number[]) => toProjected(crs, viewport.unproject(pixel));
  const bounds: Bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const steps = 8;
  for (let step = 0; step <= steps; step++) {
    const along = step / steps;
    for (const pixel of [
      [along * width, 0],
      [along * width, height],
      [0, along * height],
      [width, along * height]
    ]) {
      const [x, y] = toProjectedPixel(pixel);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      }
    }
  }
  const center = toProjectedPixel([width / 2, height / 2]);
  const beside = toProjectedPixel([width / 2 + 64, height / 2]);
  const unitsPerPixel = Math.hypot(beside[0] - center[0], beside[1] - center[1]) / 64;
  const getPixelsPerMetre =
    mercatorZoom === null
      ? (pixel: number[]) => getProjectedScaleFactor(crs, toProjectedPixel(pixel)) / unitsPerPixel
      : (pixel: number[]) =>
          (512 * 2 ** mercatorZoom) /
          (EARTH_CIRCUMFERENCE * Math.cos((viewport.unproject(pixel)[1] * Math.PI) / 180));
  return {
    width,
    height,
    bounds,
    unitsPerPixel,
    toPixel,
    toProjected: toProjectedPixel,
    getPixelsPerMetre
  };
}

/**
 * Puts a label on each grid line where the line meets the bottom edge (lines of constant x) or the
 * right edge (lines of constant y) of the screen.
 */
function getGridLabels(lines: GridLine[], scene: Scene, frame: Frame): GridLabel[] {
  const {width, height} = frame;
  const labels: (GridLabel & {pixel: number})[] = [];
  for (const line of lines) {
    const isX = line.axis === 'x';
    const target = isX ? height - 34 : width - 10;
    const axis = isX ? 1 : 0;
    let previous = frame.toPixel(line.path[0]);
    for (let index = 2; index < line.path.length; index += 2) {
      const next = frame.toPixel(line.path[index]);
      if (previous[axis] - target !== 0 && (previous[axis] - target) * (next[axis] - target) <= 0) {
        const ratio = (target - previous[axis]) / (next[axis] - previous[axis]);
        const start = line.path[index - 2];
        const end = line.path[index];
        const pixel = [
          previous[0] + (next[0] - previous[0]) * ratio,
          previous[1] + (next[1] - previous[1]) * ratio
        ];
        // Keep the labels off the panel, the readout and the attribution.
        const visible = isX
          ? pixel[0] > 400 && pixel[0] < width - 110
          : pixel[1] > 60 && pixel[1] < height - 70;
        if (visible) {
          let angle = (Math.atan2(previous[1] - next[1], next[0] - previous[0]) * 180) / Math.PI;
          angle -= isX ? 90 : 0;
          angle = ((((angle + 90) % 180) + 180) % 180) - 90;
          labels.push({
            position: [
              start[0] + (end[0] - start[0]) * ratio,
              start[1] + (end[1] - start[1]) * ratio
            ],
            text: `${formatGridValue(line.value)} m${scene.axes[isX ? 0 : 1]}`,
            angle,
            axis: line.axis,
            pixel: pixel[0]
          });
        }
        break;
      }
      previous = next;
    }
  }
  // Leave out a label of a line of constant x that is too near the label before it.
  let last = -Infinity;
  return labels
    .sort((a, b) => a.pixel - b.pixel)
    .filter(label => {
      if (label.axis === 'y') {
        return true;
      }
      const keep = label.pixel - last >= 96;
      last = keep ? label.pixel : last;
      return keep;
    });
}

/** The largest 1, 2 or 5 times a power of ten that is not more than `metres`. */
function getNiceDistance(metres: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(metres));
  const fraction = metres / magnitude;
  let factor = 1;
  if (fraction >= 5) {
    factor = 5;
  } else if (fraction >= 2) {
    factor = 2;
  }
  return factor * magnitude;
}

function formatPercent(percent: number): string {
  return `${percent.toFixed(percent < 1 ? 2 : 1)}%`;
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
  root.style.fontFamily = 'system-ui, sans-serif';
  container.replaceChildren(root);
  return root;
}

type HudContent = {
  title: string;
  distance: string;
  topBar: number;
  bottomBar: number;
  variation: string;
  north: string;
  position: string;
  status: string;
};

/** The readout of the projection: two scale bars, the scale change and the pointer position. */
function createHud(ownerDocument: Document) {
  const create = (style: Partial<CSSStyleDeclaration>, parent?: HTMLElement) => {
    const element = ownerDocument.createElement('div');
    Object.assign(element.style, style);
    parent?.append(element);
    return element;
  };
  const element = create({
    position: 'absolute',
    left: '12px',
    bottom: '12px',
    minWidth: '250px',
    padding: '10px 12px',
    borderRadius: '8px',
    font: '12px/1.5 system-ui, sans-serif',
    color: '#e8eef5',
    background: 'rgba(15, 22, 32, 0.86)',
    boxShadow: '0 2px 12px rgba(0, 0, 0, 0.35)',
    pointerEvents: 'none'
  });
  element.className = 'basemap-native-crs-raster-hud';
  const title = create({fontWeight: '600', fontSize: '13px', color: '#ffffff'}, element);
  const distance = create({marginTop: '4px'}, element);
  const createBar = (caption: string) => {
    const row = create({display: 'flex', alignItems: 'center', gap: '8px', height: '16px'}, element);
    const bar = create(
      {height: '6px', borderRadius: '1px', background: '#ffd166', flex: 'none'},
      row
    );
    const text = create({color: '#aebccb', whiteSpace: 'nowrap'}, row);
    return {
      set: (length: number) => {
        bar.style.width = `${length.toFixed(1)}px`;
        text.textContent = `${caption} · ${length.toFixed(1)} px`;
      }
    };
  };
  const topBar = createBar('top edge');
  const bottomBar = createBar('bottom edge');
  const variation = create({marginTop: '4px'}, element);
  const north = create({}, element);
  const mono = {fontFamily: LABEL_FONT, fontSize: '11px', color: '#aebccb', whiteSpace: 'pre'};
  const position = create({...mono, marginTop: '4px', minHeight: '17px'}, element);
  const status = create({...mono, minHeight: '17px'}, element);

  return {
    element,
    update(content: HudContent) {
      title.textContent = content.title;
      distance.textContent = content.distance;
      topBar.set(content.topBar);
      bottomBar.set(content.bottomBar);
      variation.textContent = content.variation;
      north.textContent = content.north;
      position.textContent = content.position;
      status.textContent = content.status;
    },
    setStatus(text: string) {
      status.textContent = text;
    }
  };
}

function createAttribution(ownerDocument: Document): HTMLDivElement {
  const attribution = ownerDocument.createElement('div');
  attribution.className = 'basemap-attribution';
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
