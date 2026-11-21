// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  SharedMVTLayer,
  SharedTile2DLayer,
  SharedTileset2D,
  type SharedTile2DHeader,
  type SharedTileset2DAdapter
} from '@deck.gl-community/geo-layers';
import type {RequestScheduler} from '@loaders.gl/core/loader-utils';
import {TileLayer, type Tile2DHeader} from '@deck.gl/geo-layers';
import {pickTerrainSurface, type TerrainSurface, type TerrainSurfaceHit} from './terrain-query';
import {isGlobeViewport} from './is-globe-viewport';
import {ZoomLoadGate} from './zoom-load-gate';
import {getStyleZoom, isProjectedViewport} from './projected-viewport';
import {getBasemapTilesetAdapter} from './projected-tileset';
import {getSourceTileBounds, getSourceTileTemplates} from './source-tiles';
import {DEFAULT_MAX_STRETCH} from './projected-tile-selection';
import {getSourceKey, loadGeoJsonData, type BasemapSource} from './style-resolver';
import type {BasemapFeatureState} from './feature-state';
import {
  CompositeLayer,
  log,
  type DefaultProps,
  type GetPickingInfoParams,
  type Layer,
  type LayersList,
  type PickingInfo,
  type UpdateParameters,
  type Viewport
} from '@deck.gl/core';
import {load} from '@loaders.gl/core';
import {derefLayers, diff, type StyleSpecification} from '@maplibre/maplibre-gl-style-spec';
import {
  createDemTileset,
  getBasemapLayers,
  getInsertionError,
  getSourceLoadOptions,
  getStyleDefinitionZoomLimits,
  getStyleSourceLayers,
  getStyleLayerPropsMap,
  getTilePyramidProps,
  getVectorTileLoader,
  isDrawnStyleLayer,
  isVectorTileSource,
  VECTOR_TILE_ZOOM_OFFSET,
  type StyleLayerPropsMap,
  type StyleLayerSubLayerProps
} from './globe-layers';
import {
  acquireSharedLabelPlacement,
  DEFAULT_PLACEMENT_INTERVAL,
  getSharedLabelPlacementKey,
  LabelPlacement,
  releaseSharedLabelPlacement
} from './label-placement';
import {MapStyleLoader, type MapStyleLoaderOptions} from './map-style-loader';
import {BasemapStyleSchema, ResolvedBasemapStyleSchema} from './map-style-schema';
import {getBasemapFetch, getBasemapLayerFetch, hasCustomScheme} from './basemap-protocol';
import {getDemUnpackVector} from './hillshade-layer';
import {getTileLoadOptions} from './pmtiles-source';
import {getStyleZoomKey} from './style-accessor';
import {getResolvedBasemapStyleBaseUrl, isResolvedBasemapStyle} from './style-resolver';
import type {
  BasemapLoadOptions,
  BasemapStyle,
  ResolvedBasemapStyle,
  ResolvedBasemapStyleLayer
} from './style-resolver';
import {GlyphStore} from './glyph-store';
import {getSpriteSources, loadSpriteAtlases} from './sprite';
import type {SpriteAtlas} from './sprite';
import type {LabelFontFamily} from './text-font';
import type {RejectRasterTile} from './raster-tile-loader';
import {
  querySourceFeaturesInTiles,
  type BasemapSourceFeature,
  type QuerySourceFeaturesOptions
} from './source-features';

/**
 * Logs a non-error basemap-layer runtime event to deck.gl logging.
 */
function logBasemapLayerEvent(message: string, details?: unknown): void {
  log.probe(1, message, details ?? '')();
}

/**
 * Logs a basemap-layer runtime error to deck.gl logging.
 */
function logBasemapLayerError(message: string, error: Error): void {
  log.error(`${message}: ${error.message}`)();
}

function getMapStyleLoaderOptions(
  loadOptions: BasemapLayerProps['loadOptions'],
  sourceCache: Map<string, BasemapSource>
): MapStyleLoaderOptions {
  return {mapStyle: {...loadOptions, sourceCache}};
}

/**
 * Drawing toggles of the basemap helpers (`getBasemapLayers`). They apply in every mode, not only
 * on a globe. `BasemapLayer` takes them as the flat `labels` and `atmosphere` props.
 */
export type BasemapGlobeConfig = {
  /** Draws the atmosphere in globe mode. Default `false`. */
  atmosphere?: boolean;
  /** Draws the style layers. Default `true`. `false` draws only the atmosphere. */
  basemap?: boolean;
  /** Draws the style's symbol layers (labels and icons). Default `true`. */
  labels?: boolean;
};

/** A tile given to `onTileLoad` and `onViewportLoad`: deck.gl's tile header. */
export type BasemapTile = Tile2DHeader | SharedTile2DHeader;

/**
 * The data of a `geojson` source in {@link BasemapLayerProps.sourceData}: a GeoJSON object, or the
 * URL of one, as the source's `data` in the style.
 */
export type BasemapSourceData = object | string;

/**
 * deck.gl layers that {@link BasemapLayer} draws inside the style order (see
 * `BasemapLayerProps.insertLayers`).
 */
export type BasemapInsertion = {
  /**
   * The id of the style layer to draw `layers` before, as the `beforeId` of MapLibre GL JS's
   * `addLayer`. Omit it to draw `layers` over the whole basemap.
   */
  beforeId?: string | null;
  /** The deck.gl layers to draw. */
  layers: LayersList;
};

/** The `loadOptions` of {@link BasemapLayer}: basemap request options and loaders.gl options. */
export type BasemapLayerLoadOptions = NonNullable<BasemapLoadOptions> & Record<string, unknown>;

/**
 * Props accepted by {@link BasemapLayer}.
 */
export type BasemapLayerProps = {
  /** Optional deck.gl layer identifier. */
  id?: string;
  /**
   * MapLibre or Mapbox style JSON, a URL that resolves to one, or a resolved style. A resolved
   * style draws at once without fetching its TileJSON and GeoJSON data again. A copy resolves again.
   * Default `null`.
   */
  style?: string | BasemapStyle | ResolvedBasemapStyle | null;
  /**
   * Options for the requests of the layer, and loaders.gl options for its tiles:
   * - `baseUrl`, `fetch` and `fetchOptions` apply to the TileJSON, GeoJSON `data`, sprite and
   *   glyph requests (see `resolveBasemapStyle`). With `rejectRasterTile`, they also apply to
   *   raster tiles.
   * - loaders.gl namespaces such as `mvt` and `core` go to the tile loaders, with the deck.gl
   *   `fetch` prop.
   * - A style URL loads with `MapStyleLoader`, with these options as its `mapStyle` options.
   */
  loadOptions?: BasemapLayerLoadOptions | null;
  /**
   * Selects whether the sublayers draw as a flat map or on a globe. `'auto'` (the default) reads
   * it from the viewport: globe sublayers in a deck.gl `GlobeView`, map sublayers in other views.
   * `'map'` and `'globe'` override the viewport.
   */
  mode?: 'auto' | 'map' | 'globe';
  /**
   * The state of features, which `["feature-state", key]` reads in paint properties, as MapLibre
   * GL JS's `setFeatureState` sets it: by source id, then, for a `vector` source, by source layer,
   * then by feature id. Pass a new object to change a state; a change computes again only the paint
   * attributes of the style layers that read the changed states, and keeps their geometry.
   */
  featureState?: BasemapFeatureState | null;
  /**
   * Draws the style's symbol layers (labels and icons). Default `true`. It applies in every mode.
   * With `false`, the tiles do not decode the source layers that only symbol layers read.
   */
  labels?: boolean;
  /**
   * Draws the atmosphere around the globe in globe mode. Default `false`. The atmosphere layers
   * are placeholders that draw nothing yet.
   */
  atmosphere?: boolean;
  /**
   * @deprecated Use the `labels` and `atmosphere` props, and deck.gl's `visible` prop in place of
   * `basemap: false`. A field set here overrides the flat prop of the same name.
   */
  globe?: {
    config?: BasemapGlobeConfig;
  } | null;
  /**
   * Draws labels with the browser's fonts instead of the style's `glyphs`. By default labels are
   * drawn with the style's glyphs, as in MapLibre GL JS, and a style without `glyphs` maps each
   * symbol layer's `text-font` to a CSS family list, weight and style (see the module docs). A
   * string replaces the family list for every label; a function receives the `text-font` names
   * and returns a family list or `LabelFont` fields. Pass a stable function: tiles regenerate when
   * it changes.
   */
  fontFamily?: LabelFontFamily | null;
  /**
   * Milliseconds between two placements of the labels while the view keeps changing, as MapLibre
   * GL JS's `fadeDuration` (default 300). The view the map comes to rest in is always placed; 0
   * places every frame. The `BasemapLayer`s of a deck share one placement (see
   * `separateLabelPlacement`), which takes the interval of the last of them rendered: give them
   * the same interval.
   */
  labelPlacementInterval?: number;
  /**
   * Places this layer's labels apart from those of the other `BasemapLayer`s of the deck. By
   * default (`false`) the labels of every `BasemapLayer` in a deck are placed together, as the
   * layers of one style: a label hides those it overlaps, and those of a `BasemapLayer` drawn later
   * are placed first. With `true`, this layer's labels collide only with each other.
   */
  separateLabelPlacement?: boolean;
  /**
   * Milliseconds that vector tile loads wait after the last zoom change of a view (default 0: no
   * wait). In a zoom gesture the view passes through several tile zooms; each tile loaded at one
   * of them is decoded and triangulated, and is drawn for a fraction of a second. With a wait, a
   * tile that a loaded ancestor tile draws, enlarged, waits until the zoom comes to rest, and is
   * not loaded if no view selects it then. A tile without a loaded ancestor, such as the new
   * tiles at the edges of a zoom out, loads at once. A pan does not change the zoom, and its
   * loads do not wait.
   */
  zoomLoadDelay?: number;
  /**
   * The stretch limit of the tile selection in a projected view (deck.gl's
   * `_CustomProjectionView`), see `ProjectedTileSelectionOptions.maxStretch`. The default, 4, suits
   * most projections. A projection whose scale grows steeply toward the edge of its area of use,
   * such as a polar stereographic projection, needs a larger limit to draw out to that edge: 16
   * draws an EPSG:3031 view out to latitude 60N. A change reloads the tiles.
   */
  projectedMaxStretch?: number;
  /**
   * Returns `true` for a raster tile that has no map data, such as the placeholder image that some
   * tile services return with status 200 where they have no coverage. The tile is then drawn from
   * its nearest ancestor tile that has data, enlarged, and the placeholder is not drawn. The
   * function receives the bytes of the response (see `RasterTileResponse`). With this prop, raster
   * tiles are requested with the `fetch` and `fetchOptions` of `loadOptions`. Pass a stable
   * function: raster tiles reload when it changes. See `createRasterTileFingerprintFilter`.
   */
  rejectRasterTile?: RejectRasterTile | null;
  /**
   * Called with the resolved style each time a style resolves, as MapLibre GL JS's `style.load`
   * event. Its sprites, glyphs and tiles can still be loading.
   */
  onStyleLoad?: ((style: ResolvedBasemapStyle) => void) | null;
  /**
   * Called when a tile of a vector, raster, raster-dem or geojson source loads, as deck.gl's
   * `TileLayer.onTileLoad`. The style layers of one source share its tiles: each load is reported
   * once.
   */
  onTileLoad?: ((tile: BasemapTile) => void) | null;
  /**
   * Called with the tiles of all sources in the current viewport when they have loaded, as
   * deck.gl's `TileLayer.onViewportLoad` and MapLibre GL JS's `idle` event. The style and its
   * sprites have loaded too. A viewport that selects no tiles is not reported.
   */
  onViewportLoad?: ((tiles: BasemapTile[]) => void) | null;
  /**
   * Called with the `attribution` of the sources that the style draws, when they change, as
   * MapLibre GL JS's `AttributionControl` collects them: a source that only hidden layers draw is
   * left out, each attribution is given once, and one that another contains is left out. The
   * strings are the provider's HTML, not sanitized: display them as safe linked text.
   */
  onAttributionChange?: ((attributions: string[]) => void) | null;
  /**
   * The data of `geojson` sources of the style, by source id, in place of their `data` in the
   * style, as MapLibre GL JS's `GeoJSONSource.setData`. Each entry is compared by identity: when
   * one changes, only that source is indexed again and its tiles cut again. The style is not
   * loaded again, and the other sources keep their tiles. A URL is fetched with the `fetch` and
   * `fetchOptions` of `loadOptions`, relative to the style URL or `loadOptions.baseUrl`, and again
   * when the style URL or `loadOptions` change; the source keeps its previous data until it
   * loads. An entry that is removed, `null` or `undefined` gives the source its data in the style
   * again. An id that is not a `geojson` source of the style is ignored with a warning.
   */
  sourceData?: Record<string, BasemapSourceData | null | undefined> | null;
  /**
   * Extra deck.gl props for the sublayers that draw one style layer, or null for none: for example
   * `extensions` and their props for the roads only. Called for each style layer when the style or
   * the function changes, not for each tile. `extensions` are added after the sublayer's own and
   * `updateTriggers` are merged with its own; `id` and `data` are ignored. A fill or line layer
   * with extra props draws in a sublayer of its own, not batched with its neighbors. Pass a
   * stable function: the tiles regenerate when it changes.
   */
  getStyleLayerProps?:
    | ((styleLayer: ResolvedBasemapStyleLayer) => StyleLayerSubLayerProps | null | undefined)
    | null;
  /**
   * deck.gl layers drawn inside the style order, as MapLibre GL JS's `addLayer(layer, beforeId)`:
   * each insertion's `layers` draw before the style layer `beforeId`, and over the whole basemap
   * without one. Insertions before the same style layer draw in the order of this list. The layers
   * are sublayers of the basemap, and are picked as if they were top-level layers: their own
   * `onHover` and `onClick` receive the events, and `info.layer` is the inserted layer. A `beforeId`
   * that names no layer of the style raises an error to `onError`, and its layers are not drawn.
   */
  insertLayers?: BasemapInsertion[] | null;
};

/** A `sourceData` entry and its GeoJSON: the entry itself, or its URL's once it loads. */
type SourceDataEntry = {
  /** The entry of the `sourceData` prop. */
  input: BasemapSourceData;
  /** Its GeoJSON object, or the previous entry's until a URL loads, or null. */
  data: object | null;
  /** For a URL, the URL that it resolves against and the `loadOptions` that it loads with. */
  context?: {baseUrl: string | undefined; loadOptions: BasemapLayerProps['loadOptions']};
};

/** A `geojson` source of the resolved style with the data of its `sourceData` entry. */
type SourceDataSource = {
  /** The source in the resolved style. */
  base: BasemapSource;
  /** The data of its `sourceData` entry. */
  data: object;
  /** `base` with `data`: the tileset key, kept while neither changes. */
  source: BasemapSource;
};

const fractionalZoomLimitsCache = new WeakMap<ResolvedBasemapStyle, number[]>();

/**
 * The fractional `minzoom`/`maxzoom` limits of a style, computed once per resolved style:
 * `shouldUpdateState` reads them on every viewport change, but they only change with the style.
 */
function getFractionalZoomLimits(resolvedStyle: ResolvedBasemapStyle): number[] {
  let limits = fractionalZoomLimitsCache.get(resolvedStyle);
  if (!limits) {
    limits = getStyleDefinitionZoomLimits(resolvedStyle).filter(
      (limit): limit is number => limit !== undefined && !Number.isInteger(limit)
    );
    fractionalZoomLimitsCache.set(resolvedStyle, limits);
  }
  return limits;
}

/**
 * Internal state tracked by {@link BasemapLayer}.
 */
type BasemapLayerState = {
  /**
   * Places the labels of every symbol style layer together (see `LabelPlacement`): the deck's
   * shared placement, or this layer's own with `separateLabelPlacement`.
   */
  labelPlacement: LabelPlacement | null;
  /** The deck whose shared placement `labelPlacement` is, or null for a placement of its own. */
  sharedLabelPlacementKey: object | null;
  /** The fully resolved style definition currently backing the generated sublayers. */
  resolvedStyle: ResolvedBasemapStyle | null;
  /** The `style` prop that `resolvedStyle` was made from. */
  styleInput: BasemapLayerProps['style'];
  /**
   * A copy of `styleInput` when it is an object, as it was when it was read. A style changed in
   * place is compared with this copy. Null while a load runs, and when a source or the sprite of
   * the style failed to load: the next style then loads.
   */
  styleSnapshot: BasemapStyle | null;
  /** The most recent style-resolution error, if one occurred. */
  loadError: Error | null;
  /** Monotonic token used to discard stale async style loads. */
  loadToken: number;
  /** `getStyleZoomKey` of the zoom the current sublayers were generated at. */
  zoomKey: string | null;
  /** Sprites of the resolved style, once loaded. */
  spriteAtlases: SpriteAtlas[] | null;
  /** The sprite URLs and pixel ratio of `spriteLoad`. */
  spriteKey: string | null;
  /** The load of the sprites of the resolved style, kept for a new style with the same sprites. */
  spriteLoad: Promise<SpriteAtlas[]> | null;
  /** The sources of the styles resolved with `sourceCacheOptions` (see `BasemapLoadOptions`). */
  sourceCache: Map<string, BasemapSource>;
  /** The `loadOptions` that the sources in `sourceCache` were loaded with. */
  sourceCacheOptions: BasemapLayerProps['loadOptions'] | undefined;
  /** The `loadOptions` that the sources, the sprites and the glyphs were loaded with. */
  styleLoadOptions: BasemapLayerProps['loadOptions'] | undefined;
  /** The glyphs of the resolved style's `glyphs` URL, or null without one. */
  glyphs: GlyphStore | null;
  /** Decoded data caches owned by this basemap, shared across style runs. */
  tilesets: Map<BasemapSource, SharedTileset2D>;
  /**
   * What each tileset decodes: for a vector source its source layers, as JSON (see
   * `getStyleSourceLayers`), for a raster-dem source its encoding.
   */
  tilesetSourceLayers: Map<BasemapSource, string>;
  /** Loading configuration used to construct the current source caches. */
  tileLoadOptions: unknown;
  /** The `projectedMaxStretch` the current source caches select tiles with. */
  tileMaxStretch: number | null;
  /** Fetch identity, kept separate from render-only props such as view mode. */
  tileFetch: unknown;
  /** Holds the vector tile loads while a view zooms (see `zoomLoadDelay`). */
  zoomLoadGate: ZoomLoadGate;
  /** The `loadToken` of the last style load that ended. */
  loadedToken: number;
  /** The resolved style that the current sublayers were generated from. */
  renderedStyle: ResolvedBasemapStyle | null;
  /** The content of each tile reported to `onTileLoad`, to report a load once. */
  reportedTiles: WeakMap<object, unknown>;
  /** The tiles last reported to `onViewportLoad`. */
  viewportTiles: BasemapTile[] | null;
  /** The attributions last reported to `onAttributionChange`, as JSON. */
  attributions: string;
  /** The entries of the `sourceData` prop, by source id. */
  sourceData: Map<string, SourceDataEntry>;
  /** The sources that the `sourceData` entries replace, by source id. */
  sourceDataSources: Map<string, SourceDataSource>;
  /** The resolved style with the `sourceData` sources, and the resolved style it was made from. */
  styleWithSourceData: {base: ResolvedBasemapStyle; style: ResolvedBasemapStyle} | null;
  /** The extra sublayer props of each style layer, and the style and function they came from. */
  styleLayerProps: {
    style: ResolvedBasemapStyle;
    getStyleLayerProps: BasemapLayerProps['getStyleLayerProps'];
    value: StyleLayerPropsMap | null;
  } | null;
  /** The layers of `insertLayers` in the current sublayers, picked as top-level layers. */
  insertedLayers: Set<Layer>;
  /** The style and unknown `beforeId`s that errors were last raised for, to raise them once. */
  insertionError: {style: ResolvedBasemapStyle; beforeIds: string} | null;
  /** The config `getStyleConfig` last returned, kept while its inputs do not change. */
  styleConfig: {
    labels: unknown;
    atmosphere: unknown;
    globe: unknown;
    value: {config: Required<BasemapGlobeConfig>};
  } | null;
};

/**
 * A deck.gl {@link CompositeLayer} that loads a style document and renders the
 * corresponding basemap sublayers.
 *
 * @typeParam ExtraPropsT The props of the layer's `extensions`, such as `MaskExtensionProps`.
 */
export class BasemapLayer<ExtraPropsT extends {} = {}> extends CompositeLayer<
  ExtraPropsT & Required<BasemapLayerProps>
> {
  /** Deck.gl layer name. */
  static layerName = 'BasemapLayer';

  /** Default props for {@link BasemapLayer}. */
  static defaultProps: DefaultProps<BasemapLayerProps> = {
    mode: 'auto',
    featureState: null,
    labels: true,
    atmosphere: false,
    globe: null,
    style: null,
    loadOptions: null,
    fontFamily: null,
    rejectRasterTile: null,
    getStyleLayerProps: null,
    insertLayers: {type: 'object', value: null, compare: false},
    labelPlacementInterval: DEFAULT_PLACEMENT_INTERVAL,
    separateLabelPlacement: false,
    zoomLoadDelay: 0,
    projectedMaxStretch: DEFAULT_MAX_STRETCH,
    onStyleLoad: {type: 'function', optional: true, value: null},
    onTileLoad: {type: 'function', optional: true, value: null},
    onViewportLoad: {type: 'function', optional: true, value: null},
    onAttributionChange: {type: 'function', optional: true, value: null},
    // Compared by entry: a new object with the same entries changes nothing.
    sourceData: {type: 'object', value: null, compare: 1}
  };

  /** Current layer state. */
  state: BasemapLayerState = undefined!;

  /**
   * Queries a caller-owned displayed terrain surface through the selected deck viewport. The
   * layer adds nothing: this is `pickTerrainSurface(viewport, pixel, surface, commonToSurface)`.
   */
  getTerrainAt(
    viewport: Viewport,
    pixel: readonly [number, number],
    surface: TerrainSurface,
    commonToSurface: Readonly<ArrayLike<number>>
  ): TerrainSurfaceHit | null {
    return pickTerrainSurface(viewport, pixel, surface, commonToSurface);
  }

  /** Initializes the asynchronous style-loading state. */
  initializeState(): void {
    this.state = {
      labelPlacement: null,
      sharedLabelPlacementKey: null,
      resolvedStyle: null,
      styleInput: null,
      styleSnapshot: null,
      loadError: null,
      loadToken: 0,
      zoomKey: null,
      tilesets: new Map(),
      tilesetSourceLayers: new Map(),
      tileLoadOptions: null,
      tileMaxStretch: null,
      tileFetch: null,
      spriteAtlases: null,
      spriteKey: null,
      spriteLoad: null,
      sourceCache: new Map(),
      sourceCacheOptions: undefined,
      styleLoadOptions: undefined,
      glyphs: null,
      zoomLoadGate: new ZoomLoadGate(),
      loadedToken: 0,
      renderedStyle: null,
      reportedTiles: new WeakMap(),
      viewportTiles: null,
      // No style draws no sources: the first report is the first attribution.
      attributions: '[]',
      sourceData: new Map(),
      sourceDataSources: new Map(),
      styleWithSourceData: null,
      styleLayerProps: null,
      insertedLayers: new Set(),
      insertionError: null,
      styleConfig: null
    };
  }

  /**
   * False while the style, its sprites or the tiles of the current viewport load, as deck.gl's
   * `TileLayer.isLoaded`. A style or tile that failed to load counts as loaded.
   */
  get isLoaded(): boolean {
    const state = this.state;
    if (!state || state.loadedToken !== state.loadToken) {
      return false;
    }
    // Until the sublayers of the style exist, the sublayers that `super` checks are not its own.
    const {resolvedStyle, spriteAtlases, renderedStyle} = state;
    if (resolvedStyle && (!spriteAtlases || renderedStyle !== resolvedStyle)) {
      return false;
    }
    return super.isLoaded;
  }

  /**
   * The extra sublayer props of each style layer of `style` (see `getStyleLayerProps`), computed
   * once per style and function.
   */
  private getStyleLayerPropsMap(style: ResolvedBasemapStyle): StyleLayerPropsMap | null {
    const {getStyleLayerProps} = this.props;
    const cached = this.state.styleLayerProps;
    if (cached?.style === style && cached.getStyleLayerProps === getStyleLayerProps) {
      return cached.value;
    }
    const value = getStyleLayerPropsMap(style, getStyleLayerProps ?? null);
    this.state.styleLayerProps = {style, getStyleLayerProps, value};
    return value;
  }

  /**
   * The drawing toggles of the props, in the `{config}` form of the basemap helpers: `labels` and
   * `atmosphere`, with the fields of the deprecated `globe.config` over them. The object keeps
   * its identity while these props do not change.
   */
  getStyleConfig(): {config: Required<BasemapGlobeConfig>} {
    const {labels, atmosphere, globe} = this.props;
    const cached = this.state?.styleConfig;
    if (
      cached &&
      cached.labels === labels &&
      cached.atmosphere === atmosphere &&
      cached.globe === globe
    ) {
      return cached.value;
    }
    const config = {labels: labels !== false, atmosphere: Boolean(atmosphere), basemap: true};
    const legacy = globe?.config;
    if (legacy) {
      log.deprecated(
        'BasemapLayer prop `globe.config`',
        'the `labels` and `atmosphere` props, and `visible` for `basemap: false`'
      )();
      for (const key of ['labels', 'atmosphere', 'basemap'] as const) {
        if (legacy[key] !== undefined) {
          config[key] = Boolean(legacy[key]);
        }
      }
    }
    const value = {config};
    if (this.state) {
      this.state.styleConfig = {labels, atmosphere, globe, value};
    }
    return value;
  }

  /**
   * Sublayers depend on the zoom, but only through `getStyleZoomKey`: style values step every
   * `STYLE_ZOOM_STEP`, filters at integer zooms, and layer visibility changes at
   * `minzoom`/`maxzoom`. Re-render when that key changes, not on every viewport change.
   */
  shouldUpdateState(params: UpdateParameters<this>): boolean {
    if (super.shouldUpdateState(params)) {
      return true;
    }
    const {resolvedStyle, zoomKey} = this.state;
    if (!resolvedStyle || !params.changeFlags.viewportChanged) {
      return false;
    }
    return this.getZoomKey(resolvedStyle, params.context.viewport) !== zoomKey;
  }

  /** Returns the key of what the sublayers depend on in `viewport`, for a resolved style. */
  getZoomKey(resolvedStyle: ResolvedBasemapStyle, viewport: Viewport | undefined): string {
    const zoomKey = getStyleZoomKey(getStyleZoom(viewport), getFractionalZoomLimits(resolvedStyle));
    // A projected view draws as a map, with other sublayers: longitude/latitude geometry.
    const drawMode = isProjectedViewport(viewport) ? 'projected' : this.getDrawMode(viewport);
    return `${drawMode}:${zoomKey}`;
  }

  /**
   * The mode the sublayers are drawn in. With `mode: 'auto'`, a globe viewport draws globe
   * sublayers and any other viewport draws map sublayers. Above zoom 12, `GlobeView` draws with a
   * Web Mercator viewport, so a globe basemap draws as a map there: globe depth and culling
   * parameters assume longitude/latitude geometry on a sphere.
   */
  getDrawMode(viewport: Viewport | undefined): 'map' | 'globe' {
    const {mode = 'auto'} = this.props;
    if (mode === 'map') {
      return 'map';
    }
    if (!viewport) {
      return mode === 'globe' ? 'globe' : 'map';
    }
    return isGlobeViewport(viewport) ? 'globe' : 'map';
  }

  /** Reacts to changes in the input style definition. */
  updateState({props, oldProps, changeFlags}: UpdateParameters<this>): void {
    this.updateLabelPlacement();
    if (
      changeFlags.dataChanged ||
      props.style !== oldProps.style ||
      props.loadOptions !== oldProps.loadOptions
    ) {
      const updated =
        !changeFlags.dataChanged &&
        props.loadOptions === oldProps.loadOptions &&
        oldProps.style === this.state.styleInput &&
        this.updateStyleByDiff(props.style);
      if (!updated) {
        this.loadStyle(props.style, props.loadOptions);
      }
    }
    if (
      props.sourceData !== oldProps.sourceData ||
      props.style !== oldProps.style ||
      props.loadOptions !== oldProps.loadOptions
    ) {
      this.updateSourceData(props);
    }
  }

  /**
   * Takes the entries of the `sourceData` prop. An entry that is the same as before keeps its data;
   * a GeoJSON object is used as it is, and a URL is fetched. A URL is fetched again when the URL
   * that it resolves against or the `loadOptions` change.
   */
  private updateSourceData({sourceData, style, loadOptions}: BasemapLayerProps): void {
    const previous = this.state.sourceData;
    const entries = new Map<string, SourceDataEntry>();
    const baseUrl = getStyleBaseUrl(style, ((loadOptions || {}) as {baseUrl?: string}).baseUrl);
    for (const [sourceId, input] of Object.entries(sourceData || {})) {
      if (input === null || input === undefined) {
        continue;
      }
      const previousEntry = previous.get(sourceId);
      if (
        previousEntry?.input === input &&
        (typeof input !== 'string' ||
          (previousEntry.context?.baseUrl === baseUrl &&
            previousEntry.context?.loadOptions === loadOptions))
      ) {
        entries.set(sourceId, previousEntry);
      } else if (typeof input !== 'string') {
        entries.set(sourceId, {input, data: input});
      } else {
        // As MapLibre's `setData`, the source keeps the data it has until the new data loads.
        const entry: SourceDataEntry = {
          input,
          data: previousEntry?.data ?? null,
          context: {baseUrl, loadOptions}
        };
        entries.set(sourceId, entry);
        this.loadSourceData(sourceId, entry);
      }
    }
    this.setState({sourceData: entries});
  }

  /** Fetches the GeoJSON of a `sourceData` URL, unless the entry has changed by then. */
  private loadSourceData(sourceId: string, entry: SourceDataEntry): void {
    const {baseUrl, loadOptions} = entry.context!;
    const isCurrent = () => this.state.sourceData.get(sourceId) === entry;
    loadGeoJsonData(entry.input as string, baseUrl, loadOptions)
      .then(data => {
        if (isCurrent()) {
          const entries = new Map(this.state.sourceData);
          entries.set(sourceId, {...entry, data});
          this.setState({sourceData: entries});
        }
      })
      .catch((error: Error) => {
        if (isCurrent()) {
          logBasemapLayerError(`Failed to load the data of GeoJSON source "${sourceId}"`, error);
        }
      });
  }

  /**
   * The resolved style with the data of the `sourceData` entries in its `geojson` sources. A source
   * is a new object only when its entry or its source in the resolved style changes, and the style
   * only when one of its sources does: the tilesets are keyed by source object, so the other sources
   * keep their tiles.
   */
  private getStyleWithSourceData(resolvedStyle: ResolvedBasemapStyle): ResolvedBasemapStyle {
    const {sourceData, sourceDataSources: previous, styleWithSourceData} = this.state;
    const replaced = new Map<string, SourceDataSource>();
    let changed = styleWithSourceData?.base !== resolvedStyle;
    for (const [sourceId, {data}] of sourceData) {
      const base = resolvedStyle.sources?.[sourceId];
      if (base?.type !== 'geojson') {
        log.warn(`[BasemapLayer] sourceData "${sourceId}" is not a geojson source of the style`)();
        continue;
      }
      if (!data) {
        continue;
      }
      let entry = previous.get(sourceId);
      if (!entry || entry.base !== base || entry.data !== data) {
        entry = {base, data, source: {...base, data}};
        changed = true;
      }
      replaced.set(sourceId, entry);
    }
    if (replaced.size !== previous.size) {
      changed = true;
    }
    this.state.sourceDataSources = replaced;
    if (!replaced.size) {
      this.state.styleWithSourceData = null;
      return resolvedStyle;
    }
    if (changed || !styleWithSourceData) {
      const sources = {...resolvedStyle.sources};
      for (const [sourceId, {source}] of replaced) {
        sources[sourceId] = source;
      }
      this.state.styleWithSourceData = {base: resolvedStyle, style: {...resolvedStyle, sources}};
    }
    return this.state.styleWithSourceData!.style;
  }

  /**
   * Applies a new style object as MapLibre GL JS's `setStyle(style, {diff: true})` applies it. A
   * change that loads nothing, such as a paint or layout value, a filter, a zoom range or the order
   * of the layers, makes a new resolved style with the sources of the current one, in this update.
   * Returns false when the style must load: a source, the sprite or the glyphs changed, or the
   * styles cannot be compared.
   */
  private updateStyleByDiff(style: BasemapLayerProps['style']): boolean {
    const {resolvedStyle, styleSnapshot} = this.state;
    // A glyph range that failed loads again with the next load.
    if (
      !resolvedStyle ||
      !styleSnapshot ||
      !isStyleObject(style) ||
      isResolvedBasemapStyle(style) ||
      this.state.glyphs?.failed
    ) {
      return false;
    }
    const snapshot = copyStyle(style);
    let commands: ReturnType<typeof diff>;
    try {
      commands = diff(styleSnapshot as StyleSpecification, snapshot as StyleSpecification);
    } catch {
      return false;
    }
    if (commands.some(({command}) => LOADING_DIFF_COMMANDS.has(command))) {
      return false;
    }
    const updatedStyle = commands.length ? getUpdatedStyle(snapshot, resolvedStyle) : resolvedStyle;
    if (!updatedStyle) {
      return false;
    }
    logBasemapLayerEvent('Updated basemap style', {commands: commands.length});
    this.setState({resolvedStyle: updatedStyle, styleInput: style, styleSnapshot: snapshot});
    return true;
  }

  /**
   * Resolves the configured style input and stores the latest successful result
   * in layer state.
   */
  loadStyle(
    style: BasemapLayerProps['style'],
    loadOptions: BasemapLayerProps['loadOptions']
  ): void {
    if (!style) {
      const loadToken = this.state.loadToken + 1;
      logBasemapLayerEvent('Clearing basemap style');
      this.clearSourceTilesets();
      this.setState({
        resolvedStyle: null,
        styleInput: null,
        styleSnapshot: null,
        loadError: null,
        loadToken,
        loadedToken: loadToken,
        spriteAtlases: null,
        glyphs: null
      });
      return;
    }

    const loadToken = this.state.loadToken + 1;
    this.setState({loadToken});
    const styleJson = isStyleObject(style) && !isResolvedBasemapStyle(style) ? JSON.stringify(style) : null;
    const styleSnapshot: BasemapStyle | null = styleJson ? JSON.parse(styleJson) : null;
    // A style update by diff waits for this load (see `updateStyleByDiff`).
    this.state.styleSnapshot = null;
    // A load with other options takes a new cache: a load still running fills only its own.
    if (loadOptions !== this.state.sourceCacheOptions) {
      this.state.sourceCache = new Map();
      this.state.sourceCacheOptions = loadOptions;
    }
    const {sourceCache} = this.state;
    if (isResolvedBasemapStyle(style)) {
      logBasemapLayerEvent('Using resolved basemap style', {loadToken});
      this.setResolvedStyle(style, style, loadOptions, loadToken, null);
      return;
    }
    logBasemapLayerEvent('Resolving basemap style', {
      style: typeof style === 'string' ? style : 'inline-style-object',
      loadToken
    });

    Promise.resolve(
      typeof style === 'string'
        ? hasCustomScheme(style)
          ? loadProtocolStyle(style, loadOptions, sourceCache)
          : load(style, MapStyleLoader, getMapStyleLoaderOptions(loadOptions, sourceCache))
        : MapStyleLoader.parse(
            new TextEncoder().encode(styleJson!).buffer,
            getMapStyleLoaderOptions(loadOptions, sourceCache)
          )
    )
      .then(resolvedStyle => {
        if (this.state.loadToken === loadToken) {
          logBasemapLayerEvent('Resolved basemap style', {
            loadToken,
            sources: Object.keys(resolvedStyle.sources || {}),
            layers: resolvedStyle.layers?.length || 0
          });
          this.setResolvedStyle(resolvedStyle, style, loadOptions, loadToken, styleSnapshot);
        }
      })
      .catch((error: Error) => {
        if (this.state.loadToken === loadToken) {
          logBasemapLayerError('Failed to resolve basemap style', error);
          this.clearSourceTilesets();
          this.setState({
            resolvedStyle: null,
            styleInput: null,
            styleSnapshot: null,
            loadError: error,
            loadedToken: loadToken
          });
        }
      });
  }

  /** Draws `resolvedStyle`, the resolved form of the `style` prop, and loads its sprites. */
  private setResolvedStyle(
    resolvedStyle: ResolvedBasemapStyle,
    style: BasemapLayerProps['style'],
    loadOptions: BasemapLayerProps['loadOptions'],
    loadToken: number,
    styleSnapshot: BasemapStyle | null
  ): void {
    const sameOptions = loadOptions === this.state.styleLoadOptions;
    if (sameOptions && this.state.resolvedStyle && !isResolvedBasemapStyle(style)) {
      reuseSources(resolvedStyle, this.state.resolvedStyle);
    }
    const glyphs = getGlyphStore(resolvedStyle, style, loadOptions);
    const keepGlyphs =
      sameOptions && glyphs?.url === this.state.glyphs?.url && !this.state.glyphs?.failed;
    this.setState({
      resolvedStyle,
      styleInput: style,
      styleSnapshot: hasFailedSource(styleSnapshot, resolvedStyle) ? null : styleSnapshot,
      loadError: null,
      loadedToken: loadToken,
      styleLoadOptions: loadOptions,
      glyphs: keepGlyphs ? this.state.glyphs : glyphs
    });
    this.loadSprites(resolvedStyle, style, loadOptions, loadToken, sameOptions);
    // An error of the app's callback is not a load failure: it must not clear the style.
    try {
      this.getCurrentProps().onStyleLoad?.(resolvedStyle);
    } catch (error) {
      (this.getCurrentLayer() ?? this).raiseError(error as Error, 'onStyleLoad');
    }
  }

  /**
   * Loads the resolved style's sprites, if it has any, and stores them for the icon layers.
   * Relative sprite URLs resolve against the style URL.
   */
  loadSprites(
    resolvedStyle: ResolvedBasemapStyle,
    style: BasemapLayerProps['style'],
    loadOptions: BasemapLayerProps['loadOptions'],
    loadToken: number,
    sameOptions: boolean
  ): void {
    if (!resolvedStyle.sprite) {
      // No sprites to wait for (`null` means loading, see `MVTLabelLayerProps.spriteAtlases`).
      this.setState({spriteAtlases: [], spriteKey: null, spriteLoad: null});
      return;
    }
    const options = (loadOptions || {}) as {
      baseUrl?: string;
      fetch?: typeof fetch;
      fetchOptions?: RequestInit;
    };
    const baseUrl = getStyleBaseUrl(style, options.baseUrl);
    const pixelRatio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const spriteKey = JSON.stringify([getSpriteSources(resolvedStyle.sprite, baseUrl), pixelRatio]);
    if (!sameOptions || spriteKey !== this.state.spriteKey || !this.state.spriteLoad) {
      const spriteCount = getSpriteSources(resolvedStyle.sprite, baseUrl).length;
      const spriteLoad = loadSpriteAtlases(resolvedStyle.sprite, {
        baseUrl,
        fetch: options.fetch,
        fetchOptions: options.fetchOptions,
        pixelRatio
      });
      this.setState({spriteAtlases: null, spriteKey, spriteLoad});
      spriteLoad.then(spriteAtlases => {
        // A sprite that failed loads again with the next style.
        if (spriteAtlases.length < spriteCount && this.state.spriteLoad === spriteLoad) {
          this.state.spriteKey = null;
          this.state.styleSnapshot = null;
        }
      });
    }
    this.state.spriteLoad!.then(spriteAtlases => {
      if (this.state.loadToken === loadToken && this.state.spriteAtlases !== spriteAtlases) {
        this.setState({spriteAtlases});
        // The tiles can have loaded before the sprites.
        (this.getCurrentLayer() as this | null)?.checkViewportLoad();
      }
    });
  }

  /**
   * Returns the features of a `vector` or `geojson` source in the tiles that are loaded and drawn
   * now, as MapLibre GL JS's `Map#querySourceFeatures`: every feature of `sourceLayer` that matches
   * `filter`, whether a style layer draws it or not, in longitude and latitude. Tiles outside the
   * view are not read. A feature that crosses a tile edge, or a point in the buffer of two tiles,
   * is returned once per tile: compare `id`s to merge them. A source with no loaded tiles, a raster
   * source, or an unknown id returns `[]`.
   *
   * Tiles decode only the source layers that the style draws, so a source layer that no style layer
   * reads has no features here.
   */
  querySourceFeatures(
    sourceId: string,
    options?: QuerySourceFeaturesOptions | null
  ): BasemapSourceFeature[] {
    const style = this.state?.styleWithSourceData?.style || this.state?.resolvedStyle;
    const source = style?.sources?.[sourceId];
    const tileset = source && isVectorTileSource(source) && this.state.tilesets.get(source);
    if (!tileset) {
      return [];
    }
    return querySourceFeaturesInTiles(tileset.visibleTiles, sourceId, source, options || {});
  }

  /** The basemap owns caches; style-run consumers only attach/detach. */
  finalizeState(): void {
    this.state.loadToken++;
    // Loads of `sourceData` URLs that finish later find no entry.
    this.state.sourceData = new Map();
    this.clearSourceTilesets();
    this.releaseLabelPlacement();
  }

  /**
   * Takes the deck's shared label placement, or one of its own with `separateLabelPlacement`, and
   * gives back the one it had when that prop changed.
   */
  private updateLabelPlacement(): void {
    const separate = Boolean(this.props.separateLabelPlacement);
    const {labelPlacement, sharedLabelPlacementKey} = this.state;
    if (labelPlacement && separate === !sharedLabelPlacementKey) {
      return;
    }
    this.releaseLabelPlacement();
    if (separate) {
      this.state.labelPlacement = new LabelPlacement();
    } else {
      const key = getSharedLabelPlacementKey(this);
      this.state.sharedLabelPlacementKey = key;
      this.state.labelPlacement = acquireSharedLabelPlacement(key);
    }
  }

  /** Gives back the deck's shared placement, or releases this layer's own. */
  private releaseLabelPlacement(): void {
    const {labelPlacement, sharedLabelPlacementKey} = this.state;
    if (sharedLabelPlacementKey) {
      releaseSharedLabelPlacement(sharedLabelPlacementKey);
    } else {
      labelPlacement?.destroy();
    }
    this.state.labelPlacement = null;
    this.state.sharedLabelPlacementKey = null;
  }

  private clearSourceTilesets(): void {
    for (const tileset of this.state.tilesets.values()) tileset.finalize();
    this.state.tilesets.clear();
    this.state.tilesetSourceLayers.clear();
  }

  private updateSourceTilesets(style: ResolvedBasemapStyle): void {
    const sources = new Set(
      Object.values(style.sources || {}).filter(source => isVectorTileSource(source))
    );
    // The decoded tiles of a raster-dem source are shared by its hillshade layers.
    const demSources = new Set(
      Object.values(style.sources || {}).filter(
        source => source?.type === 'raster-dem' && source.tiles
      )
    );
    const optionsChanged =
      this.state.tileLoadOptions !== this.props.loadOptions ||
      this.state.tileFetch !== this.props.fetch ||
      this.state.tileMaxStretch !== this.props.projectedMaxStretch;
    // Tiles decode only the source layers the style draws: a style edit or a labels toggle that
    // changes the layers the loader decodes reloads the source's tiles.
    const sourceLayers = getStyleSourceLayers(style, this.getStyleConfig());
    const getDecodedLayers = (source: BasemapSource) =>
      (getSourceLoadOptions(this.props.loadOptions, sourceLayers.get(source)) as any)?.mvt?.layers;
    // Projected views and globes show latitudes past the edges of Web Mercator tiles: GeoJSON is
    // cut at them there, and tiled again when the view changes from one to the other.
    const geoJson = {
      clipToMercatorRange:
        this.props.mode === 'globe' ||
        (this.props.mode !== 'map' && isGlobeViewport(this.context.viewport)) ||
        isProjectedViewport(this.context.viewport)
    };
    const sourceLayerKeys = new Map([
      ...[...sources].map(
        source =>
          [
            source,
            JSON.stringify(getDecodedLayers(source) ?? null) +
              (source.type === 'geojson' ? `:${geoJson.clipToMercatorRange}` : '')
          ] as const
      ),
      // An encoding edited in place reloads the source's tiles.
      ...[...demSources].map(source => [source, `dem:${getDemUnpackVector(source)}`] as const)
    ]);
    for (const [source, tileset] of this.state.tilesets) {
      if (
        !sourceLayerKeys.has(source) ||
        optionsChanged ||
        this.state.tilesetSourceLayers.get(source) !== sourceLayerKeys.get(source)
      ) {
        tileset.finalize();
        this.state.tilesets.delete(source);
        this.state.tilesetSourceLayers.delete(source);
      }
    }
    this.state.tileLoadOptions = this.props.loadOptions;
    this.state.tileFetch = this.props.fetch;
    this.state.tileMaxStretch = this.props.projectedMaxStretch ?? null;
    for (const source of sources) {
      if (!this.state.tilesets.has(source)) {
        const loader = new SharedMVTLayer({
          id: `${this.id}-loader`,
          data: getSourceTileTemplates(source)!,
          fetch: getBasemapLayerFetch(this.props.fetch, 'arrayBuffer'),
          loadOptions: getTileLoadOptions(
            source,
            getSourceLoadOptions(this.props.loadOptions, sourceLayers.get(source))
          )
        });
        loader.context = this.context;
        const gate = this.state.zoomLoadGate;
        const loadTile = getVectorTileLoader(source, loader, geoJson);
        const tileset: SharedTileset2D = new SharedTileset2D({
          ...loader._getTilesetOptions(),
          adapter: getZoomGatedAdapter(
            gate,
            getBasemapTilesetAdapter(this.props.projectedMaxStretch, getSourceTileBounds(source))
          ),
          ...getTilePyramidProps(source),
          tileSize: source.tileSize || 512,
          zoomOffset: VECTOR_TILE_ZOOM_OFFSET,
          getTileData: tile => (tile.signal?.aborted ? null : loadTile(tile))
        });
        holdBeforeRequestSlot(tileset, gate);
        this.state.tilesets.set(source, tileset);
        this.state.tilesetSourceLayers.set(source, sourceLayerKeys.get(source)!);
      }
    }
    for (const source of demSources) {
      if (!this.state.tilesets.has(source)) {
        const tileset = createDemTileset(source, this.props.loadOptions, this.props.projectedMaxStretch);
        this.state.tilesets.set(source, tileset);
        this.state.tilesetSourceLayers.set(source, sourceLayerKeys.get(source)!);
      }
    }
  }

  /** The label placement, with the interval of the current props. */
  private getLabelPlacement(): LabelPlacement {
    this.updateLabelPlacement();
    const labelPlacement = this.state.labelPlacement!;
    // A shared placement takes the interval of the last of its layers rendered.
    labelPlacement.interval = Math.max(0, Number(this.props.labelPlacementInterval) || 0);
    return labelPlacement;
  }

  /** The props of the current layer: an async load can end after the props changed. */
  private getCurrentProps(): BasemapLayerProps {
    return (this.getCurrentLayer() ?? this).props;
  }

  /** Gives each tile load once to `onTileLoad`: the style layers of a source share its tiles. */
  private reportTileLoad(tile: BasemapTile): void {
    const {reportedTiles} = this.state;
    if (reportedTiles.has(tile) && reportedTiles.get(tile) === tile.content) {
      return;
    }
    reportedTiles.set(tile, tile.content);
    this.getCurrentProps().onTileLoad?.(tile);
  }

  /**
   * Calls `onViewportLoad` when the style, its sprites and the tiles that every tile sublayer
   * selects have loaded, and the tiles are not those last reported. As in deck.gl's `TileLayer`,
   * the tiles count, not the layers drawn from them.
   */
  private checkViewportLoad(): void {
    const {resolvedStyle, renderedStyle, spriteAtlases, loadedToken, loadToken} = this.state;
    if (
      loadedToken !== loadToken ||
      !resolvedStyle ||
      renderedStyle !== resolvedStyle ||
      !spriteAtlases
    ) {
      return;
    }
    const tiles: BasemapTile[] = [];
    for (const layer of this.getSubLayers()) {
      if (this.state.insertedLayers.has(layer)) {
        continue;
      }
      const selected = getLoadedSelectedTiles(layer);
      if (!selected) {
        return;
      }
      tiles.push(...selected);
    }
    const unique = [...new Set(tiles)];
    const last = this.state.viewportTiles;
    // A viewport that selects no tiles has nothing loaded (an empty `every` is true).
    const reported =
      last?.length === unique.length && last.every((tile, i) => tile === unique[i]);
    if (!unique.length || reported) {
      return;
    }
    this.state.viewportTiles = unique;
    this.getCurrentProps().onViewportLoad?.(unique);
  }

  /** Calls `onAttributionChange` when the attributions of the drawn sources change. */
  private updateAttributions(style: ResolvedBasemapStyle | null, zoom: number): void {
    const attributions = style ? getStyleAttributions(style, zoom, this.getStyleConfig()) : [];
    const key = JSON.stringify(attributions);
    if (key !== this.state.attributions) {
      this.state.attributions = key;
      this.getCurrentProps().onAttributionChange?.(attributions);
    }
  }

  /**
   * Adds this layer's tile and viewport callbacks to its tile sublayers, after their own. The
   * layer manager runs a sublayer's callbacks with the props of its latest render.
   */
  private addTileCallbacks(layers: Layer[]): Layer[] {
    return layers.map(layer => {
      if (
        this.state.insertedLayers.has(layer) ||
        !(layer instanceof TileLayer || layer instanceof SharedTile2DLayer)
      ) {
        return layer;
      }
      const {onTileLoad, onViewportLoad} = layer.props as {
        onTileLoad?: ((tile: BasemapTile) => void) | null;
        onViewportLoad?: ((tiles: BasemapTile[]) => void) | null;
      };
      return layer.clone({
        onTileLoad: (tile: BasemapTile) => {
          onTileLoad?.(tile);
          this.reportTileLoad(tile);
        },
        onViewportLoad: (tiles: BasemapTile[]) => {
          onViewportLoad?.(tiles);
          // The sublayer reports during its update, before the other sublayers update.
          Promise.resolve().then(() =>
            (this.getCurrentLayer() as this | null)?.checkViewportLoad()
          );
        }
      } as any);
    });
  }

  /** Renders the sublayers generated from the resolved style definition. */
  renderLayers() {
    const {resolvedStyle: baseStyle} = this.state;
    const {viewport} = this.context;
    // In a projected view, the zoom of the Web Mercator map of the same scale.
    const zoom = getStyleZoom(viewport);
    this.updateAttributions(baseStyle, zoom);
    // Recorded without setState: this only tracks what the current sublayers were built from.
    this.state.renderedStyle = baseStyle;
    if (!baseStyle) {
      const insertLayers = this.props.insertLayers || [];
      this.setInsertedLayers(insertLayers);
      return insertLayers.map(insertion => insertion.layers);
    }
    const resolvedStyle = this.getStyleWithSourceData(baseStyle);

    this.state.zoomLoadGate.delay = Math.max(0, Number(this.props.zoomLoadDelay) || 0);
    this.updateSourceTilesets(resolvedStyle);
    this.state.zoomKey = this.getZoomKey(resolvedStyle, viewport);

    const insertLayers = this.getValidInsertions(resolvedStyle);
    const layers = getBasemapLayers({
      insertLayers,
      idPrefix: this.props.id,
      featureState: this.props.featureState,
      pickable: this.props.pickable,
      mode: this.getDrawMode(viewport),
      globe: this.getStyleConfig(),
      styleDefinition: resolvedStyle,
      zoom,
      loadOptions: this.props.loadOptions,
      fetch: this.props.fetch,
      rejectRasterTile: this.props.rejectRasterTile,
      spriteAtlases: this.state.spriteAtlases,
      fontFamily: this.props.fontFamily,
      // A label font of the caller's is drawn with the browser's fonts.
      glyphs: this.props.fontFamily ? null : this.state.glyphs,
      labelPlacement: this.getLabelPlacement(),
      tilesets: this.state.tilesets,
      projected: isProjectedViewport(viewport),
      projectedMaxStretch: this.props.projectedMaxStretch,
      styleLayerProps: this.getStyleLayerPropsMap(resolvedStyle)
    });
    this.setInsertedLayers(insertLayers);
    const {extensions} = this.props;
    if (extensions.length === 0) {
      return this.addTileCallbacks(layers);
    }
    // The inserted layers are the app's: they do not take the extensions of the basemap, and stay
    // the same objects, which picking finds (see `getPickingInfo`).
    return this.addTileCallbacks(
      layers.map(layer =>
        this.state.insertedLayers.has(layer) ? layer : this.addExtensions(layer)
      )
    );
  }

  /**
   * A basemap sublayer with the extensions of this layer and the props of those extensions, as
   * `getSubLayerProps` gives them: the sublayers are not made with `getSubLayerProps`. A sublayer
   * keeps its own extensions, and runs them first.
   */
  private addExtensions(layer: Layer): Layer {
    const {extensions} = this.props;
    const props: Record<string, any> = {
      extensions: [...(layer.props.extensions || []), ...extensions],
      updateTriggers: {...layer.props.updateTriggers}
    };
    for (const extension of extensions) {
      const {updateTriggers, ...extensionProps} = extension.getSubLayerProps.call(this, extension);
      Object.assign(props, extensionProps);
      Object.assign(props.updateTriggers, updateTriggers);
    }
    return layer.clone(props);
  }

  /** Records the drawn layers of `insertions`, which picking reads (see `getPickingInfo`). */
  private setInsertedLayers(insertions: BasemapInsertion[]): void {
    // Recorded without setState, as `zoomKey`: it only tracks what the current sublayers are.
    this.state.insertedLayers = new Set(
      ([insertions.map(insertion => insertion.layers as unknown)].flat(Infinity) as unknown[]).filter(
        (layer): layer is Layer => Boolean(layer)
      )
    );
  }

  /**
   * The insertions of `insertLayers` whose `beforeId` names a layer of `resolvedStyle`. Each one
   * that does not raises an error to `onError`, once for each style and `insertLayers`, as
   * MapLibre GL JS's `addLayer` fires an `error` event for an unknown `beforeId`.
   */
  private getValidInsertions(resolvedStyle: ResolvedBasemapStyle): BasemapInsertion[] {
    const {insertLayers} = this.props;
    if (!insertLayers?.length) {
      return [];
    }
    const styleLayerIds = new Set((resolvedStyle.layers || []).map(layer => layer.id));
    const isKnown = ({beforeId}: BasemapInsertion) =>
      beforeId === undefined || beforeId === null || styleLayerIds.has(beforeId);
    const unknownIds = insertLayers
      .filter(insertion => !isKnown(insertion))
      .map(insertion => insertion.beforeId as string);
    // Apps pass a new `insertLayers` on every render: an error is raised again only when the style
    // or the unknown ids change.
    const beforeIds = JSON.stringify(unknownIds);
    const reported = this.state.insertionError;
    if (unknownIds.length && (reported?.style !== resolvedStyle || reported.beforeIds !== beforeIds)) {
      for (const beforeId of unknownIds) {
        this.raiseError(getInsertionError(beforeId), '');
      }
    }
    this.state.insertionError = unknownIds.length ? {style: resolvedStyle, beforeIds} : null;
    return insertLayers.filter(isKnown);
  }

  /**
   * Picks an inserted layer as a top-level layer: `info.layer` is the inserted layer, so that deck
   * calls its `onHover` and `onClick`, and not those of the basemap.
   */
  getPickingInfo(params: GetPickingInfoParams): PickingInfo {
    const info = super.getPickingInfo(params);
    const {sourceLayer} = params;
    if (sourceLayer && this.state.insertedLayers.has(sourceLayer)) {
      info.layer = sourceLayer;
    }
    return info;
  }
}

/** Diff commands that load a source, the sprite or the glyphs (see `diff`). */
const LOADING_DIFF_COMMANDS = new Set([
  'setStyle',
  'addSource',
  'removeSource',
  'setGeoJSONSourceData',
  'setSprite',
  'setGlyphs'
]);

function isStyleObject(style: BasemapLayerProps['style']): style is BasemapStyle {
  return Boolean(style) && typeof style === 'object';
}

/**
 * Whether a source of `style` failed to load: the TileJSON of a source with a `url`, or the data of
 * a GeoJSON source given by URL (see `resolveBasemapStyle`).
 */
function hasFailedSource(style: BasemapStyle | null, resolvedStyle: ResolvedBasemapStyle): boolean {
  return Object.entries(style?.sources || {}).some(([sourceId, source]) => {
    const resolved = resolvedStyle.sources[sourceId];
    return source.type === 'geojson'
      ? typeof source.data === 'string' && !resolved?.data
      : Boolean(source.url) && !resolved?.url;
  });
}

/** A copy of a style object, as `loadStyle` reads it: through JSON. */
function copyStyle(style: BasemapStyle): BasemapStyle {
  return JSON.parse(JSON.stringify(style));
}

/**
 * A copy of a style (see `copyStyle`) resolved with the sources of `current`, or null if it is not
 * valid. A style layer that did not change keeps its object, and with it the caches of its paint
 * and filters.
 */
function getUpdatedStyle(
  style: BasemapStyle,
  current: ResolvedBasemapStyle
): ResolvedBasemapStyle | null {
  const {sources: _sources, ...definition} = style;
  const parsed = BasemapStyleSchema.safeParse(definition);
  if (!parsed.success) {
    return null;
  }
  const resolved = ResolvedBasemapStyleSchema.safeParse({
    ...parsed.data,
    sources: {},
    layers: derefLayers([...(parsed.data.layers || [])] as Parameters<typeof derefLayers>[0])
  });
  if (!resolved.success) {
    return null;
  }
  const currentLayers = new Map(current.layers.map(layer => [layer.id, layer]));
  return {
    ...resolved.data,
    sources: current.sources,
    layers: resolved.data.layers.map(layer => {
      const currentLayer = currentLayers.get(layer.id);
      return currentLayer && getSourceKey(currentLayer) === getSourceKey(layer)
        ? currentLayer
        : layer;
    })
  };
}

/**
 * Puts the source objects of `previous` back in `resolvedStyle` where the content of a source is
 * the same (see `getSourceKey`).
 */
function reuseSources(resolvedStyle: ResolvedBasemapStyle, previous: ResolvedBasemapStyle): void {
  const previousSources = new Map(
    Object.values(previous.sources).map(source => [getSourceKey(source), source])
  );
  for (const [sourceId, source] of Object.entries(resolvedStyle.sources)) {
    resolvedStyle.sources[sourceId] = previousSources.get(getSourceKey(source)) ?? source;
  }
}

/**
 * The most tile zooms between a held tile and the loaded ancestor that draws in its place. A much
 * coarser tile, such as one loaded for the first view of the map, has too little detail to draw
 * in place of a tile 8 times as fine.
 */
const MAX_PLACEHOLDER_ZOOMS = 3;

/** Whether a tileset has loaded content for a near ancestor of a tile, which draws in its place. */
function hasLoadedAncestor(
  tileset: SharedTileset2D,
  index: {x: number; y: number; z: number}
): boolean {
  for (let parent = index; parent.z > Math.max(0, index.z - MAX_PLACEHOLDER_ZOOMS); ) {
    parent = tileset.getParentIndex(parent);
    const ancestor = tileset.getTile(parent);
    if (ancestor?.isLoaded && ancestor.content) {
      return true;
    }
  }
  return false;
}

/** A request token that does not take a slot, for a held load that a newer load replaced. */
const NO_SLOT = {done: () => {}};

/**
 * Holds the vector tile loads of `tileset` in `gate` before they take a request slot, so that held
 * tiles do not keep a tile with no placeholder from loading. Only a tile that a loaded ancestor
 * draws, enlarged, meanwhile is held: in a zoom out the new tiles cover more than the old, and
 * load at once. `SharedTileset2D` has no option for its request scheduler, so this wraps its own.
 */
function holdBeforeRequestSlot(tileset: SharedTileset2D, gate: ZoomLoadGate): void {
  const internals = tileset as unknown as {_requestScheduler: RequestScheduler};
  const scheduler = internals._requestScheduler;
  if (!scheduler) {
    throw new Error('SharedTileset2D has no request scheduler to hold zoom loads before.');
  }
  const requests = new WeakMap<SharedTile2DHeader, number>();
  internals._requestScheduler = {
    async scheduleRequest(tile: SharedTile2DHeader, getPriority?: () => number) {
      const request = (requests.get(tile) ?? 0) + 1;
      requests.set(tile, request);
      const isCurrent = () => requests.get(tile) === request;
      if (
        gate.delay > 0 &&
        (await gate.wait(null, () => isCurrent() && hasLoadedAncestor(tileset, tile.index)))
      ) {
        if (!isCurrent()) {
          // A newer load of the tile replaced this one, and aborted its signal: it fetches nothing.
          return NO_SLOT;
        }
        // The view has come to rest: a tile that no view shows or selects now is not loaded.
        // Cancelled, it loads again if a view selects it later.
        if (!tile.isLoading || !tileset.visibleTiles.includes(tile)) {
          return null;
        }
      }
      return scheduler.scheduleRequest(tile, getPriority);
    }
  } as RequestScheduler;
}

/**
 * The basemap tile traversal `adapter`, which also records each view's zoom in `gate` at each tile
 * selection. This is the view's own zoom: in a projected view the Web Mercator zoom of the same
 * scale changes with the latitude, so a pan would hold loads as a zoom does.
 */
function getZoomGatedAdapter(
  gate: ZoomLoadGate,
  adapter: ReturnType<typeof getBasemapTilesetAdapter>
): SharedTileset2DAdapter<unknown> {
  return {
    getTileIndices(context) {
      const viewport = context.viewState as Viewport;
      gate.noteZoom(viewport.id, viewport.zoom);
      return adapter.getTileIndices(context);
    },
    getTileBoundingBox: (context, index) => adapter.getTileBoundingBox(context, index)
  };
}

/**
 * The selected tiles of a tile sublayer, once they have all loaded; null while one loads. A layer
 * that is not a tile layer selects no tiles.
 */
function getLoadedSelectedTiles(layer: Layer): BasemapTile[] | null {
  if (layer instanceof TileLayer) {
    const tileset = layer.state?.tileset;
    return tileset?.isLoaded ? tileset.selectedTiles! : null;
  }
  if (layer instanceof SharedTile2DLayer) {
    const views = [...((layer.state as any)?.tilesetViews?.values() ?? [])];
    if (!views.length || !views.every(view => view.isLoaded)) {
      return null;
    }
    return views.flatMap(view => view.selectedTiles);
  }
  return [];
}

/**
 * Whether a style layer is drawn at `zoom`, as MapLibre GL JS's `StyleLayer.isHidden`, and with
 * the globe toggles.
 */
function isShownAt(
  layer: ResolvedBasemapStyleLayer,
  zoom: number,
  globe: ReturnType<BasemapLayer['getStyleConfig']>
): boolean {
  return (
    isDrawnStyleLayer(layer, globe) &&
    layer.layout?.visibility !== 'none' &&
    !(layer.minzoom !== undefined && zoom < layer.minzoom) &&
    !(layer.maxzoom !== undefined && zoom >= layer.maxzoom)
  );
}

/**
 * The `attribution` of the sources that the shown layers of a style draw at `zoom`, in source
 * order, as MapLibre GL JS's `AttributionControl` collects them: each once, without blank ones,
 * and without one that another contains.
 */
function getStyleAttributions(
  style: ResolvedBasemapStyle,
  zoom: number,
  globe: ReturnType<BasemapLayer['getStyleConfig']>
): string[] {
  const used = new Set(
    (style.layers || []).filter(layer => isShownAt(layer, zoom, globe)).map(layer => layer.source)
  );
  const attributions: string[] = [];
  for (const [id, source] of Object.entries(style.sources || {})) {
    const {attribution} = source || {};
    if (
      used.has(id) &&
      typeof attribution === 'string' &&
      attribution.trim() &&
      !attributions.includes(attribution)
    ) {
      attributions.push(attribution);
    }
  }
  return attributions.filter(
    attribution =>
      !attributions.some(other => other !== attribution && other.includes(attribution))
  );
}

/**
 * Loads a style whose URL has a custom scheme, such as `pmtiles://`, with its protocol handler.
 * Relative URLs in the style resolve against the style URL.
 */
async function loadProtocolStyle(
  url: string,
  loadOptions: BasemapLayerProps['loadOptions'],
  sourceCache: Map<string, BasemapSource>
): Promise<ResolvedBasemapStyle> {
  const options = (loadOptions || {}) as {fetch?: typeof fetch; fetchOptions?: RequestInit};
  const response = await getBasemapFetch(options.fetch, 'json')(url, options.fetchOptions);
  if (!response.ok) {
    throw new Error(`Failed to load basemap style: ${url} (${response.status})`);
  }
  return MapStyleLoader.parse(await response.arrayBuffer(), {
    mapStyle: {
      ...loadOptions,
      sourceCache,
      baseUrl: (loadOptions?.baseUrl as string | undefined) || url
    }
  });
}

/**
 * The glyph store of a style's `glyphs` URL, or null without one. A relative URL resolves against
 * the style URL, as sprite URLs do.
 */
function getGlyphStore(
  resolvedStyle: ResolvedBasemapStyle,
  style: BasemapLayerProps['style'],
  loadOptions: BasemapLayerProps['loadOptions']
): GlyphStore | null {
  const url = resolvedStyle.glyphs;
  if (typeof url !== 'string' || !url) {
    return null;
  }
  const options = (loadOptions || {}) as {
    baseUrl?: string;
    fetch?: typeof fetch;
    fetchOptions?: RequestInit;
  };
  return new GlyphStore({
    url,
    baseUrl: getStyleBaseUrl(style, options.baseUrl),
    fetch: options.fetch,
    fetchOptions: options.fetchOptions
  });
}

/**
 * The URL that relative `sprite` and `glyphs` URLs resolve against: the style URL, the URL that a
 * resolved style was loaded from, or else `loadOptions.baseUrl`.
 */
function getStyleBaseUrl(
  style: BasemapLayerProps['style'],
  baseUrl: string | undefined
): string | undefined {
  if (typeof style === 'string') {
    return style;
  }
  return (isResolvedBasemapStyle(style) && getResolvedBasemapStyleBaseUrl(style)) || baseUrl;
}
