// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  CompositeLayer,
  type Color,
  type DefaultProps,
  type UpdateParameters,
  type Viewport
} from '@deck.gl/core';
import {SolidPolygonLayer} from '@deck.gl/layers';

/** How many times the longer side of the screen the background reaches from the view center. */
const BACKGROUND_REACH = 4;
/** The reach in a pitched view, which shows the ground up to its horizon. */
const PITCHED_BACKGROUND_REACH = 64;
/** The share of the reach by which the view may move before the background is made again. */
const BACKGROUND_SLACK = 0.5;

/** A square in the units of a view's coordinate reference system. */
export type BackgroundSquare = {
  /** The center of the square. */
  center: [number, number];
  /** Half the side of the square. */
  reach: number;
  /** The reach that the view the square was made for needs. */
  viewReach: number;
};

/** What `getBackgroundSquare` reads of a projected viewport. */
type BackgroundViewport = Pick<Viewport, 'width' | 'height' | 'scale' | 'center'> & {
  pitch?: number;
  unprojectFlat: (common: number[]) => number[];
};

/**
 * The square a background fills in a projected view: around the view center, several screens
 * wide. `previous` is kept while the view stays well inside it, at a similar scale. A fixed
 * polygon that covers every view down to the lowest zoom has coordinates too large for the
 * precision of the GPU when the view zooms in, and leaves parts of the screen empty.
 */
export function getBackgroundSquare(
  viewport: BackgroundViewport,
  previous?: BackgroundSquare | null
): BackgroundSquare | null {
  const [x, y] = viewport.unprojectFlat([viewport.center[0], viewport.center[1]]);
  // The units of the coordinate reference system per pixel.
  const origin = viewport.unprojectFlat([0, 0]);
  const unit = viewport.unprojectFlat([1 / viewport.scale, 0]);
  const unitsPerPixel = Math.abs(unit[0] - origin[0]);
  const screen = Math.max(viewport.width, viewport.height) * unitsPerPixel;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(screen > 0) || !Number.isFinite(screen)) {
    return previous ?? null;
  }
  const viewReach = screen * (viewport.pitch ? PITCHED_BACKGROUND_REACH : BACKGROUND_REACH);
  if (
    previous &&
    previous.viewReach >= viewReach / 2 &&
    previous.viewReach <= viewReach * 2 &&
    Math.abs(x - previous.center[0]) <= previous.reach * BACKGROUND_SLACK &&
    Math.abs(y - previous.center[1]) <= previous.reach * BACKGROUND_SLACK
  ) {
    return previous;
  }
  // Twice the reach of the view: the square also covers the view at half the scale.
  return {center: [x, y], reach: viewReach * 2, viewReach};
}

/** Props of {@link ProjectedBackgroundLayer}. */
export type ProjectedBackgroundLayerProps = {
  /** The fill color, `[r, g, b, a]`. */
  getFillColor?: Color;
};

/**
 * The `background` style layer of a projected view (deck.gl's `_CustomProjectionView`): a fill
 * of the screen. In a Web Mercator view the background is a polygon of the world. A projected
 * view has no outline of the world in longitude and latitude, so this layer fills a square
 * around the view, in the units of the view's coordinate reference system, and moves it with the
 * view (see `getBackgroundSquare`).
 */
export class ProjectedBackgroundLayer extends CompositeLayer<ProjectedBackgroundLayerProps> {
  static layerName = 'ProjectedBackgroundLayer';
  static defaultProps: DefaultProps<ProjectedBackgroundLayerProps> = {
    getFillColor: {type: 'color', value: [0, 0, 0, 255]}
  };

  declare state: {square: BackgroundSquare | null; polygons: number[][][]};

  initializeState(): void {
    this.state = {square: null, polygons: []};
  }

  /** Also when the view leaves the square the background fills. */
  shouldUpdateState(params: UpdateParameters<this>): boolean {
    if (super.shouldUpdateState(params)) {
      return true;
    }
    return (
      params.changeFlags.viewportChanged &&
      getBackgroundSquare(params.context.viewport, this.state.square) !== this.state.square
    );
  }

  updateState(): void {
    const square = getBackgroundSquare(this.context.viewport, this.state.square);
    if (square !== this.state.square) {
      const polygons = square
        ? [
            [
              [square.center[0] - square.reach, square.center[1] - square.reach],
              [square.center[0] + square.reach, square.center[1] - square.reach],
              [square.center[0] + square.reach, square.center[1] + square.reach],
              [square.center[0] - square.reach, square.center[1] + square.reach]
            ]
          ]
        : [];
      this.setState({square, polygons});
    }
  }

  renderLayers() {
    return new SolidPolygonLayer(
      this.getSubLayerProps({
        id: 'fill',
        data: this.state.polygons,
        // The units of the view's coordinate reference system.
        coordinateSystem: 'cartesian',
        getPolygon: (polygon: number[][]) => polygon,
        getFillColor: this.props.getFillColor,
        updateTriggers: {getFillColor: this.props.getFillColor}
      })
    );
  }
}
