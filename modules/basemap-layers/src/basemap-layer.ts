// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  SharedMVTLayer,
  SharedTile2DLayer,
  SharedTileset2D,
  type SharedTile2DHeader
} from '@deck.gl-community/geo-layers';
import {TileLayer, type Tile2DHeader} from '@deck.gl/geo-layers';
import {pickTerrainSurface, type TerrainSurface, type TerrainSurfaceHit} from './terrain-query';
import {isGlobeViewport} from './is-globe-viewport';
import {getStyleZoom, isProjectedViewport} from './projected-viewport';
import {getBasemapTilesetAdapter} from './projected-tileset';
import {DEFAULT_MAX_STRETCH} from './projected-tile-selection';
import type {BasemapSource} from './style-resolver';
import {
  CompositeLayer,
  log,
  type DefaultProps,
  type Layer,
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
  isDrawnStyleLayer,
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
import type {
  BasemapStyle,
  ResolvedBasemapStyle,
  ResolvedBasemapStyleLayer
} from './style-resolver';
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

/** A tile given to `onTileLoad` and `onViewportLoad`: deck.gl's tile header. */
export type BasemapTile = Tile2DHeader | SharedTile2DHeader;

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
};

/**
 * A deck.gl {@link CompositeLayer} that loads a style document and renders the
 * corresponding basemap sublayers.
 */
export class BasemapLayer extends CompositeLayer<Required<BasemapLayerProps>> {
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
    onStyleLoad: {type: 'function', optional: true, value: null},
    onTileLoad: {type: 'function', optional: true, value: null},
    onViewportLoad: {type: 'function', optional: true, value: null},
    onAttributionChange: {type: 'function', optional: true, value: null}
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
      loadedToken: 0,
      renderedStyle: null,
      reportedTiles: new WeakMap(),
      viewportTiles: null,
      // No style draws no sources: the first report is the first attribution.
      attributions: '[]'
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
        loadedToken: loadToken,
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
            loadedToken: loadToken,
            spriteAtlases: null,
            glyphs: getGlyphStore(resolvedStyle, style, loadOptions)
          });
          this.loadSprites(resolvedStyle, style, loadOptions, loadToken);
          // An error of the app's callback is not a load failure: it must not clear the style.
          try {
            this.getCurrentProps().onStyleLoad?.(resolvedStyle);
          } catch (error) {
            (this.getCurrentLayer() ?? this).raiseError(error as Error, 'onStyleLoad');
          }
        }
      })
      .catch((error: Error) => {
        if (this.state.loadToken === loadToken) {
          logBasemapLayerError('Failed to resolve basemap style', error);
          this.clearSourceTilesets();
          this.setState({resolvedStyle: null, loadError: error, loadedToken: loadToken});
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
        // The tiles can have loaded before the sprites.
        (this.getCurrentLayer() as this | null)?.checkViewportLoad();
      }
    });
  }

  /** The basemap owns caches; style-run consumers only attach/detach. */
  finalizeState(): void {
    this.state.loadToken++;
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
    const attributions = style ? getStyleAttributions(style, zoom, this.props.globe) : [];
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
      if (!(layer instanceof TileLayer || layer instanceof SharedTile2DLayer)) {
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
    const {resolvedStyle} = this.state;
    const {viewport} = this.context;
    // In a projected view, the zoom of the Web Mercator map of the same scale.
    const zoom = getStyleZoom(viewport);
    this.updateAttributions(resolvedStyle, zoom);
    // Recorded without setState: this only tracks what the current sublayers were built from.
    this.state.renderedStyle = resolvedStyle;
    if (!resolvedStyle) {
      return [];
    }

    this.updateSourceTilesets(resolvedStyle);
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
    return this.addTileCallbacks(layers);
  }
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
  globe: BasemapLayerProps['globe']
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
  globe: BasemapLayerProps['globe']
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
