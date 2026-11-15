// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {sharedTile2DDeckAdapter} from '@deck.gl-community/geo-layers';
import type {Viewport} from '@deck.gl/core';
import {Tileset2D} from '@deck.gl/geo-layers';
import {getProjectedTileIndices, getProjectedTileZoom} from './projected-tile-selection';
import {isProjectedViewport} from './projected-viewport';

type DeckAdapter = typeof sharedTile2DDeckAdapter;
type TraversalContext = Parameters<DeckAdapter['getTileIndices']>[0];
type TileContext = Parameters<DeckAdapter['getTileBoundingBox']>[0];
type TileIndex = ReturnType<DeckAdapter['getTileIndices']>[number];

/**
 * The tile traversal of the basemap's shared tilesets: deck.gl's in a Web Mercator view and on a
 * globe, and `getProjectedTileIndices` in a projected view. A tileset can serve views of both
 * kinds at once, so the view is tested at each traversal.
 */
export const basemapTilesetAdapter = {
  getTileIndices(context: Omit<TraversalContext, 'viewState'> & {viewState: unknown}): TileIndex[] {
    const viewport = context.viewState as Viewport;
    if (!isProjectedViewport(viewport)) {
      return sharedTile2DDeckAdapter.getTileIndices({...context, viewState: viewport});
    }
    const z = getProjectedTileZoom(viewport, context);
    return z === null
      ? []
      : getProjectedTileIndices(viewport, {z, extent: context.extent, maxZoom: context.maxZoom});
  },
  getTileBoundingBox(context: Omit<TileContext, 'viewState'> & {viewState: unknown}, index: TileIndex) {
    return sharedTile2DDeckAdapter.getTileBoundingBox(
      {...context, viewState: context.viewState as Viewport},
      index
    );
  }
};

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
    const z = getProjectedTileZoom(viewport, {
      tileSize,
      zoomOffset,
      minZoom: options.minZoom,
      maxZoom: options.maxZoom,
      extent
    });
    return z === null
      ? []
      : getProjectedTileIndices(viewport, {z, extent, maxZoom: options.maxZoom});
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
