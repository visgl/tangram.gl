// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {sharedTile2DDeckAdapter} from '@deck.gl-community/geo-layers';
import type {Viewport} from '@deck.gl/core';
import {TileLayer, Tileset2D} from '@deck.gl/geo-layers';
import {
  DEFAULT_MAX_STRETCH,
  getProjectedTileIndices,
  getProjectedTileZoom
} from './projected-tile-selection';
import {isProjectedViewport} from './projected-viewport';
import {type SourceTileBounds, filterTileIndicesByBounds} from './source-tiles';

type DeckAdapter = typeof sharedTile2DDeckAdapter;
type TraversalContext = Parameters<DeckAdapter['getTileIndices']>[0];
type TileContext = Parameters<DeckAdapter['getTileBoundingBox']>[0];
type TileIndex = ReturnType<DeckAdapter['getTileIndices']>[number];

function createBasemapTilesetAdapter(maxStretch: number, tileBounds: SourceTileBounds | null) {
  /** The tiles that cover the view, before the source's `bounds` are applied. */
  function getViewTileIndices(
    context: Omit<TraversalContext, 'viewState'> & {viewState: unknown}
  ): TileIndex[] {
    const viewport = context.viewState as Viewport;
    if (!isProjectedViewport(viewport)) {
      return sharedTile2DDeckAdapter.getTileIndices({...context, viewState: viewport});
    }
    const z = getProjectedTileZoom(viewport, context);
    return z === null
      ? []
      : getProjectedTileIndices(viewport, {
          z,
          extent: context.extent,
          minZoom: context.minZoom,
          maxZoom: context.maxZoom,
          maxStretch
        });
  }

  return {
    getTileIndices(
      context: Omit<TraversalContext, 'viewState'> & {viewState: unknown}
    ): TileIndex[] {
      return filterTileIndicesByBounds(getViewTileIndices(context), tileBounds);
    },
    getTileBoundingBox(
      context: Omit<TileContext, 'viewState'> & {viewState: unknown},
      index: TileIndex
    ) {
      return sharedTile2DDeckAdapter.getTileBoundingBox(
        {...context, viewState: context.viewState as Viewport},
        index
      );
    }
  };
}

const adapters = new Map<string, ReturnType<typeof createBasemapTilesetAdapter>>();

/**
 * The tile traversal of the basemap's shared tilesets: deck.gl's in a Web Mercator view and on a
 * globe, and `getProjectedTileIndices` with `maxStretch` (see `ProjectedTileSelectionOptions`) in
 * a projected view. A tileset can serve views of both kinds at once, so the view is tested at
 * each traversal. With `tileBounds`, a source's `bounds` (see `getSourceTileBounds`), the tiles
 * outside them are not selected, so they are never requested. The same limit and bounds give the
 * same adapter.
 */
export function getBasemapTilesetAdapter(
  maxStretch = DEFAULT_MAX_STRETCH,
  tileBounds: SourceTileBounds | null = null
) {
  const key = `${maxStretch}:${tileBounds ? tileBounds.join(',') : ''}`;
  let adapter = adapters.get(key);
  if (!adapter) {
    adapter = createBasemapTilesetAdapter(maxStretch, tileBounds);
    adapters.set(key, adapter);
  }
  return adapter;
}

/** `getBasemapTilesetAdapter` with the default stretch limit. */
export const basemapTilesetAdapter = getBasemapTilesetAdapter();

/**
 * A deck.gl `Tileset2D` that also selects Web Mercator tiles in a projected view. Pass it to a
 * `TileLayer` as `TilesetClass`. In other views it selects as `Tileset2D` does. With a
 * `tileBounds` option (see `getSourceTileBounds`), the tiles outside the bounds are not selected.
 */
export class ProjectedTileset2D<DataT = any, ViewStateT = Viewport> extends Tileset2D<
  DataT,
  ViewStateT
> {
  private selectionViewport: Viewport | null = null;

  getTileIndices(options: Parameters<Tileset2D<DataT, ViewStateT>['getTileIndices']>[0]) {
    const {tileBounds} = this.opts as {tileBounds?: SourceTileBounds | null};
    return filterTileIndicesByBounds(this.getViewTileIndices(options), tileBounds);
  }

  /** The tiles that cover the view, before the `tileBounds` are applied. */
  private getViewTileIndices(
    options: Parameters<Tileset2D<DataT, ViewStateT>['getTileIndices']>[0]
  ) {
    const {viewport} = options;
    this.selectionViewport = viewport || null;
    if (!viewport || !isProjectedViewport(viewport)) {
      return super.getTileIndices(options);
    }
    const {tileSize, zoomOffset, extent} = this.opts;
    const {maxStretch} = this.opts as {maxStretch?: number};
    const z = getProjectedTileZoom(viewport, {
      tileSize,
      zoomOffset,
      minZoom: options.minZoom,
      maxZoom: options.maxZoom,
      extent
    });
    return z === null
      ? []
      : getProjectedTileIndices(viewport, {
          z,
          extent,
          minZoom: options.minZoom,
          maxZoom: options.maxZoom,
          maxStretch
        });
  }

  /**
   * `Tileset2D` culls tiles outside the longitude/latitude box of the screen corners. In a
   * projected view a corner can lie outside the projection, without a longitude and latitude, and
   * the selection has tested each tile against the screen already.
   */
  isTileVisible(...parameters: Parameters<Tileset2D<DataT, ViewStateT>['isTileVisible']>): boolean {
    if (this.selectionViewport && isProjectedViewport(this.selectionViewport)) {
      return super.isTileVisible(parameters[0]);
    }
    return super.isTileVisible(...parameters);
  }
}

/**
 * A deck.gl `TileLayer` that hands its `maxStretch` (see `ProjectedTileSelectionOptions`) and its
 * `tileBounds` (see `getSourceTileBounds`) to a `ProjectedTileset2D`, its `TilesetClass`.
 */
export class ProjectedTileLayer<DataT = any, ExtraPropsT extends {} = {}> extends TileLayer<
  DataT,
  ExtraPropsT & {maxStretch?: number; tileBounds?: SourceTileBounds | null}
> {
  static layerName = 'ProjectedTileLayer';
  static defaultProps = {
    TilesetClass: ProjectedTileset2D,
    maxStretch: DEFAULT_MAX_STRETCH,
    tileBounds: null
  };

  _getTilesetOptions() {
    return {
      ...super._getTilesetOptions(),
      maxStretch: this.props.maxStretch,
      tileBounds: this.props.tileBounds
    };
  }
}
