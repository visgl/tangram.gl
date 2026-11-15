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

type DeckAdapter = typeof sharedTile2DDeckAdapter;
type TraversalContext = Parameters<DeckAdapter['getTileIndices']>[0];
type TileContext = Parameters<DeckAdapter['getTileBoundingBox']>[0];
type TileIndex = ReturnType<DeckAdapter['getTileIndices']>[number];

function createBasemapTilesetAdapter(maxStretch: number) {
  return {
    getTileIndices(
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
            maxZoom: context.maxZoom,
            maxStretch
          });
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

const adapters = new Map<number, ReturnType<typeof createBasemapTilesetAdapter>>();

/**
 * The tile traversal of the basemap's shared tilesets: deck.gl's in a Web Mercator view and on a
 * globe, and `getProjectedTileIndices` with `maxStretch` (see `ProjectedTileSelectionOptions`) in
 * a projected view. A tileset can serve views of both kinds at once, so the view is tested at
 * each traversal. The same limit gives the same adapter.
 */
export function getBasemapTilesetAdapter(maxStretch = DEFAULT_MAX_STRETCH) {
  let adapter = adapters.get(maxStretch);
  if (!adapter) {
    adapter = createBasemapTilesetAdapter(maxStretch);
    adapters.set(maxStretch, adapter);
  }
  return adapter;
}

/** `getBasemapTilesetAdapter` with the default stretch limit. */
export const basemapTilesetAdapter = getBasemapTilesetAdapter();

/**
 * A deck.gl `Tileset2D` that also selects Web Mercator tiles in a projected view. Pass it to a
 * `TileLayer` as `TilesetClass`. In other views it selects as `Tileset2D` does.
 */
export class ProjectedTileset2D<DataT = any, ViewStateT = Viewport> extends Tileset2D<
  DataT,
  ViewStateT
> {
  private selectionViewport: Viewport | null = null;

  getTileIndices(options: Parameters<Tileset2D<DataT, ViewStateT>['getTileIndices']>[0]) {
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
      : getProjectedTileIndices(viewport, {z, extent, maxZoom: options.maxZoom, maxStretch});
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
 * A deck.gl `TileLayer` that hands its `maxStretch` (see `ProjectedTileSelectionOptions`) to a
 * `ProjectedTileset2D`, its `TilesetClass`.
 */
export class ProjectedTileLayer<DataT = any, ExtraPropsT extends {} = {}> extends TileLayer<
  DataT,
  ExtraPropsT & {maxStretch?: number}
> {
  static layerName = 'ProjectedTileLayer';
  static defaultProps = {TilesetClass: ProjectedTileset2D, maxStretch: DEFAULT_MAX_STRETCH};

  _getTilesetOptions() {
    return {...super._getTilesetOptions(), maxStretch: this.props.maxStretch};
  }
}
