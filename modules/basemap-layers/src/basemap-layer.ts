// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {SharedMVTLayer, SharedTileset2D} from '@deck.gl-community/geo-layers';
import {pickTerrainSurface, type TerrainSurface, type TerrainSurfaceHit} from './terrain-query';
import {isGlobeViewport} from './is-globe-viewport';
import {getStyleZoom, isProjectedViewport} from './projected-viewport';
import {getBasemapTilesetAdapter} from './projected-tileset';
import {DEFAULT_MAX_STRETCH} from './projected-tile-selection';
import {loadGeoJsonData, type BasemapSource} from './style-resolver';
import {
  CompositeLayer,
  log,
  type DefaultProps,
  type UpdateParameters,
  type Viewport
} from '@deck.gl/core';
import {load} from '@loaders.gl/core';
import {
  createDemTileset,
  getBasemapLayers,
  getSourceLoadOptions,
  getStyleDefinitionZoomLimits,
  getStyleSourceLayers,
  getTilePyramidProps,
  getVectorTileLoader,
  isVectorTileSource,
  VECTOR_TILE_ZOOM_OFFSET
} from './globe-layers';
import {
  acquireSharedLabelPlacement,
  DEFAULT_PLACEMENT_INTERVAL,
  getSharedLabelPlacementKey,
  LabelPlacement,
  releaseSharedLabelPlacement
} from './label-placement';
import {MapStyleLoader, type MapStyleLoaderOptions} from './map-style-loader';
import {getDemUnpackVector} from './hillshade-layer';
import {getStyleZoomKey} from './style-accessor';
import type {BasemapStyle, ResolvedBasemapStyle} from './style-resolver';
import {GlyphStore} from './glyph-store';
import {loadSpriteAtlases} from './sprite';
import type {SpriteAtlas} from './sprite';
import type {LabelFontFamily} from './text-font';
import type {RejectRasterTile} from './raster-tile-loader';

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
  loadOptions: BasemapLayerProps['loadOptions']
): MapStyleLoaderOptions {
  return {
    mapStyle: (loadOptions || undefined) as NonNullable<MapStyleLoaderOptions['mapStyle']>
  };
}

/**
 * Globe-related runtime toggles used by {@link BasemapLayer}.
 */
export type BasemapGlobeConfig = {
  /** Renders the atmosphere overlays returned by the globe helpers when available. */
  atmosphere?: boolean;
  /** Renders the main globe basemap content when `true`. */
  basemap?: boolean;
  /** Enables symbol-label rendering on the globe path when `true`. */
  labels?: boolean;
};

/**
 * The data of a `geojson` source in {@link BasemapLayerProps.sourceData}: a GeoJSON object, or the
 * URL of one, as the source's `data` in the style.
 */
export type BasemapSourceData = object | string;

/**
 * Props accepted by {@link BasemapLayer}.
 */
export type BasemapLayerProps = {
  /** Optional deck.gl layer identifier. */
  id?: string;
  /** MapLibre or Mapbox style JSON, or a URL that resolves to one. */
  style: string | BasemapStyle | null;
  /** Load options forwarded to {@link resolveBasemapStyle}. */
  loadOptions?: Record<string, unknown> | null;
  /** Selects whether deck layers are generated for a flat map or a globe. */
  mode?: 'map' | 'globe';
  /** Optional globe-specific configuration used when `mode` is `'globe'`. */
  globe?: {
    /** Rendering toggles for globe-specific basemap behavior. */
    config?: BasemapGlobeConfig;
  };
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
   * places every frame.
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
  /** The most recent style-resolution error, if one occurred. */
  loadError: Error | null;
  /** Monotonic token used to discard stale async style loads. */
  loadToken: number;
  /** `getStyleZoomKey` of the zoom the current sublayers were generated at. */
  zoomKey: string | null;
  /** Sprites of the resolved style, once loaded. */
  spriteAtlases: SpriteAtlas[] | null;
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
  /** The entries of the `sourceData` prop, by source id. */
  sourceData: Map<string, SourceDataEntry>;
  /** The sources that the `sourceData` entries replace, by source id. */
  sourceDataSources: Map<string, SourceDataSource>;
  /** The resolved style with the `sourceData` sources, and the resolved style it was made from. */
  styleWithSourceData: {base: ResolvedBasemapStyle; style: ResolvedBasemapStyle} | null;
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
  /** Query a caller-owned displayed terrain surface through the selected deck viewport. */
  getTerrainAt(viewport: Viewport, pixel: readonly [number, number], surface: TerrainSurface,
    commonToSurface: Readonly<ArrayLike<number>>): TerrainSurfaceHit | null {
    return pickTerrainSurface(viewport, pixel, surface, commonToSurface);
  }
  /** Deck.gl layer name. */
  static layerName = 'BasemapLayer';

  /** Default props for {@link BasemapLayer}. */
  static defaultProps: DefaultProps<BasemapLayerProps> = {
    mode: 'map',
    globe: {
      type: 'object',
      value: {
        config: {
          atmosphere: false,
          basemap: true,
          labels: true
        }
      }
    },
    style: null,
    loadOptions: null,
    fontFamily: null,
    rejectRasterTile: null,
    labelPlacementInterval: DEFAULT_PLACEMENT_INTERVAL,
    separateLabelPlacement: false,
    projectedMaxStretch: DEFAULT_MAX_STRETCH,
    // Compared by entry: a new object with the same entries changes nothing.
    sourceData: {type: 'object', value: null, compare: 1}
  };

  /** Current layer state. */
  state: BasemapLayerState = undefined!;

  /** Initializes the asynchronous style-loading state. */
  initializeState(): void {
    this.state = {
      labelPlacement: null,
      sharedLabelPlacementKey: null,
      resolvedStyle: null,
      loadError: null,
      loadToken: 0,
      zoomKey: null,
      tilesets: new Map(),
      tilesetSourceLayers: new Map(),
      tileLoadOptions: null,
      tileMaxStretch: null,
      tileFetch: null,
      spriteAtlases: null,
      glyphs: null,
      sourceData: new Map(),
      sourceDataSources: new Map(),
      styleWithSourceData: null
    };
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
   * The mode the sublayers are drawn in. Above zoom 12, `GlobeView` draws with a Web Mercator
   * viewport, so a globe basemap draws as a map there: globe depth and culling parameters assume
   * longitude/latitude geometry on a sphere.
   */
  getDrawMode(viewport: Viewport | undefined): 'map' | 'globe' {
    const {mode = 'map'} = this.props;
    return mode === 'globe' && viewport && !isGlobeViewport(viewport) ? 'map' : mode;
  }

  /** Reacts to changes in the input style definition. */
  updateState({props, oldProps, changeFlags}: UpdateParameters<this>): void {
    this.updateLabelPlacement();
    if (
      changeFlags.dataChanged ||
      props.style !== oldProps.style ||
      props.loadOptions !== oldProps.loadOptions
    ) {
      this.loadStyle(props.style, props.loadOptions);
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
    const baseUrl =
      typeof style === 'string' ? style : ((loadOptions || {}) as {baseUrl?: string}).baseUrl;
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
        loadError: null,
        loadToken,
        spriteAtlases: null,
        glyphs: null
      });
      return;
    }

    const loadToken = this.state.loadToken + 1;
    this.setState({loadToken});
    logBasemapLayerEvent('Resolving basemap style', {
      style: typeof style === 'string' ? style : 'inline-style-object',
      loadToken
    });

    Promise.resolve(
      typeof style === 'string'
        ? load(style, MapStyleLoader, getMapStyleLoaderOptions(loadOptions))
        : MapStyleLoader.parse(
            new TextEncoder().encode(JSON.stringify(style)).buffer,
            getMapStyleLoaderOptions(loadOptions)
          )
    )
      .then(resolvedStyle => {
        if (this.state.loadToken === loadToken) {
          logBasemapLayerEvent('Resolved basemap style', {
            loadToken,
            sources: Object.keys(resolvedStyle.sources || {}),
            layers: resolvedStyle.layers?.length || 0
          });
          this.setState({
            resolvedStyle,
            loadError: null,
            spriteAtlases: null,
            glyphs: getGlyphStore(resolvedStyle, style, loadOptions)
          });
          this.loadSprites(resolvedStyle, style, loadOptions, loadToken);
        }
      })
      .catch((error: Error) => {
        if (this.state.loadToken === loadToken) {
          logBasemapLayerError('Failed to resolve basemap style', error);
          this.clearSourceTilesets();
          this.setState({resolvedStyle: null, loadError: error});
        }
      });
  }

  /**
   * Loads the resolved style's sprites, if it has any, and stores them for the icon layers.
   * Relative sprite URLs resolve against the style URL.
   */
  loadSprites(
    resolvedStyle: ResolvedBasemapStyle,
    style: BasemapLayerProps['style'],
    loadOptions: BasemapLayerProps['loadOptions'],
    loadToken: number
  ): void {
    if (!resolvedStyle.sprite) {
      // No sprites to wait for (`null` means loading, see `MVTLabelLayerProps.spriteAtlases`).
      this.setState({spriteAtlases: []});
      return;
    }
    const options = (loadOptions || {}) as {
      baseUrl?: string;
      fetch?: typeof fetch;
      fetchOptions?: RequestInit;
    };
    loadSpriteAtlases(resolvedStyle.sprite, {
      baseUrl: typeof style === 'string' ? style : options.baseUrl,
      fetch: options.fetch,
      fetchOptions: options.fetchOptions,
      pixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1
    }).then(spriteAtlases => {
      if (this.state.loadToken === loadToken) {
        this.setState({spriteAtlases});
      }
    });
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
    const sourceLayers = getStyleSourceLayers(style, this.props.globe);
    const getDecodedLayers = (source: BasemapSource) =>
      (getSourceLoadOptions(this.props.loadOptions, sourceLayers.get(source)) as any)?.mvt?.layers;
    const sourceLayerKeys = new Map([
      ...[...sources].map(
        source => [source, JSON.stringify(getDecodedLayers(source) ?? null)] as const
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
          data: source.tiles!,
          fetch: this.props.fetch,
          loadOptions: getSourceLoadOptions(this.props.loadOptions, sourceLayers.get(source))
        });
        loader.context = this.context;
        const tileset = new SharedTileset2D({
          ...loader._getTilesetOptions(),
          adapter: getBasemapTilesetAdapter(this.props.projectedMaxStretch),
          ...getTilePyramidProps(source),
          tileSize: source.tileSize || 512,
          zoomOffset: VECTOR_TILE_ZOOM_OFFSET,
          getTileData: getVectorTileLoader(source, loader)
        });
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

  /** Renders the sublayers generated from the resolved style definition. */
  renderLayers() {
    if (!this.state.resolvedStyle) {
      return [];
    }
    const resolvedStyle = this.getStyleWithSourceData(this.state.resolvedStyle);

    this.updateSourceTilesets(resolvedStyle);
    const {viewport} = this.context;
    // In a projected view, the zoom of the Web Mercator map of the same scale.
    const zoom = getStyleZoom(viewport);
    // Recorded without setState: this only tracks what the current sublayers were built from.
    this.state.zoomKey = this.getZoomKey(resolvedStyle, viewport);

    const layers = getBasemapLayers({
      idPrefix: this.props.id,
      mode: this.getDrawMode(viewport),
      globe: this.props.globe,
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
      projectedMaxStretch: this.props.projectedMaxStretch
    });
    const {extensions} = this.props;
    if (extensions.length === 0) {
      return layers;
    }
    // The sublayers are not made with `getSubLayerProps`: give them the extensions of this layer
    // and the props of those extensions, as `getSubLayerProps` does. A sublayer keeps its own
    // extensions, and runs them first.
    return layers.map(layer => {
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
    });
  }
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
    baseUrl: typeof style === 'string' ? style : options.baseUrl,
    fetch: options.fetch,
    fetchOptions: options.fetchOptions
  });
}
