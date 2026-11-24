// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {
  CompositeLayer,
  FirstPersonViewport,
  type Color,
  type DefaultProps,
  type UpdateParameters,
  type Viewport
} from '@deck.gl/core';
import {SolidPolygonLayer} from '@deck.gl/layers';
import {MAX_MERCATOR_LATITUDE, getStyleZoom} from './projected-viewport';

/** How many times the longer side of the screen the background reaches from the view center. */
const BACKGROUND_REACH = 4;
/** The reach in a pitched view, which shows the ground up to its horizon. */
const PITCHED_BACKGROUND_REACH = 64;
/** The share of the reach by which the view may move before the background is made again. */
const BACKGROUND_SLACK = 0.5;
/** WGS84 equatorial radius, in meters. */
const EARTH_RADIUS = 6_378_137;

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

/** Identify a geospatial first-person camera across copies of deck.gl. */
export function isGeographicFirstPersonViewport(viewport: unknown): viewport is FirstPersonViewport {
  const candidate = viewport as FirstPersonViewport | undefined;
  return (
    candidate?.isGeospatial === true &&
    (candidate.constructor as typeof FirstPersonViewport).displayName === FirstPersonViewport.displayName
  );
}

/**
 * A square around the view center. Keep it while the view stays well inside it at a similar
 * scale. A world-sized polygon can lose coverage when clipped against a first-person frustum
 * or rendered at high zoom in a projected view.
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
  let viewReach = screen * (viewport.pitch ? PITCHED_BACKGROUND_REACH : BACKGROUND_REACH);
  if (isGeographicFirstPersonViewport(viewport)) {
    // Cover the frustum up to the ground horizon, even when the far plane extends beyond it.
    const {width, height} = viewport;
    const altitude = Math.max(0, viewport.cameraPosition[2] / viewport.distanceScales.unitsPerMeter[2]);
    const horizon = Math.acos(EARTH_RADIUS / (EARTH_RADIUS + altitude));
    const latitudeRadians = (y * Math.PI) / 180;
    const latitudeReach = (horizon * 180) / Math.PI;
    const longitudeReach = horizon >= Math.PI / 2 - Math.abs(latitudeRadians)
      ? 180
      : (Math.asin(Math.sin(horizon) / Math.cos(latitudeRadians)) * 180) / Math.PI;
    const farCorners = [[0, 0], [width, 0], [width, height], [0, height]];
    const farReach = Math.max(...farCorners.map(([column, row]) => {
      const [longitude, latitude] = viewport.unproject([column, row, 1]);
      const delta = longitude - x;
      const wrappedDelta = delta - 360 * Math.round(delta / 360);
      return Math.max(
        Math.min(Math.abs(wrappedDelta), longitudeReach),
        Math.min(Math.abs(latitude - y), latitudeReach)
      );
    }));
    if (Number.isFinite(farReach)) {
      viewReach = Math.max(screen * BACKGROUND_REACH, farReach);
    }
  }
  if (
    previous &&
    previous.viewReach >= viewReach / 2 &&
    previous.viewReach <= viewReach * 2
  ) {
    const slack = Math.min(previous.reach * BACKGROUND_SLACK, previous.reach - viewReach);
    if (Math.abs(x - previous.center[0]) <= slack && Math.abs(y - previous.center[1]) <= slack) {
      return previous;
    }
  }
  // Twice the reach of the view: the square also covers the view at half the scale.
  return {center: [x, y], reach: viewReach * 2, viewReach};
}

/** Props of {@link ProjectedBackgroundLayer}. */
export type ProjectedBackgroundLayerProps = {
  /** The fill color, `[r, g, b, a]`. */
  getFillColor?: Color;
  /**
   * Whether the view is a Web Mercator map rather than a projected view: the square is then in
   * longitude and latitude, cut at the latitudes of the Web Mercator world. A patterned background
   * of a map draws such a square rather than the whole world, which leaves too little precision to
   * place the pattern at high zoom.
   */
  geographic?: boolean;
  /**
   * `FillPatternExtension`'s pattern scale, in Web Mercator common units per image pixel. In a
   * projected view the layer converts it to the view's common units, so that the pattern has the
   * size it has on the Web Mercator map of the same scale.
   */
  getFillPatternScale?: number;
};

/**
 * A background sized around a projected or first-person view. A geographic first-person view
 * and a patterned Web Mercator background draw the square in longitude and latitude instead
 * of projected coordinates (see `geographic`).
 */
export class ProjectedBackgroundLayer extends CompositeLayer<ProjectedBackgroundLayerProps> {
  static layerName = 'ProjectedBackgroundLayer';
  static defaultProps: DefaultProps<ProjectedBackgroundLayerProps> = {
    getFillColor: {type: 'color', value: [0, 0, 0, 255]},
    geographic: false
  };

  declare state: {
    square: BackgroundSquare | null;
    polygons: number[][][];
    /** The view's common units per Web Mercator common unit, where the square was made. */
    commonScale: number;
  };

  initializeState(): void {
    this.state = {square: null, polygons: [], commonScale: 1};
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
      const [x, y] = square?.center ?? [0, 0];
      const reach = square?.reach ?? 0;
      const limit = this.props.geographic ? MAX_MERCATOR_LATITUDE : Infinity;
      const bottom = Math.max(y - reach, -limit);
      const top = Math.min(y + reach, limit);
      const polygons = square
        ? [
            [
              [x - reach, bottom],
              [x + reach, bottom],
              [x + reach, top],
              [x - reach, top]
            ]
          ]
        : [];
      // 1 in a Web Mercator view. It changes slowly across a view, so it is kept with the square.
      const {viewport} = this.context;
      const commonScale = 2 ** getStyleZoom(viewport) / viewport.scale;
      this.setState({square, polygons, commonScale});
    }
  }

  renderLayers() {
    const {getFillPatternScale} = this.props;
    const props = this.getSubLayerProps({
      id: 'fill',
      data: this.state.polygons,
      // The units of the view's coordinate reference system, or longitude and latitude.
      coordinateSystem: this.props.geographic ? 'lnglat' : 'cartesian',
      getPolygon: (polygon: number[][]) => polygon,
      getFillColor: this.props.getFillColor,
      updateTriggers: {getFillColor: this.props.getFillColor}
    });
    // After the extension's props, which pass the scale through unchanged.
    if (getFillPatternScale !== undefined) {
      props.getFillPatternScale = getFillPatternScale * this.state.commonScale;
    }
    return new SolidPolygonLayer(props);
  }
}
