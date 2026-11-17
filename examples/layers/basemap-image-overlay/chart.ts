// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** A longitude and a latitude, in degrees. */
export type Corner = [number, number];

/** The corners of an image source: top left, top right, bottom right and bottom left. */
export type Corners = [Corner, Corner, Corner, Corner];

/**
 * A scan of the 1859 U.S. Coast Survey chart "City of San Francisco and its Vicinity", 1280 by
 * 876 pixels, from Wikimedia Commons. Public domain.
 */
export const CHART_URL =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9d/1858_U.S._Coast_Survey_Chart_or_Map_of_San_Francisco%2C_Califorina_-_Geographicus_-_SanFrancisco-uscs-1859.jpg/1280px-1858_U.S._Coast_Survey_Chart_or_Map_of_San_Francisco%2C_Califorina_-_Geographicus_-_SanFrancisco-uscs-1859.jpg';

/** The page of the scan on Wikimedia Commons, with its source and licence. */
export const CHART_PAGE_URL =
  'https://commons.wikimedia.org/wiki/File:1858_U.S._Coast_Survey_Chart_or_Map_of_San_Francisco,_Califorina_-_Geographicus_-_SanFrancisco-uscs-1859.jpg';

/**
 * The approximate corners of the scan. West is at the top of the chart and north is at its right,
 * so the top left corner of the image is the south-west corner of the area.
 *
 * The latitudes come from the graticule on the border of the chart. The longitudes come from the
 * graticule too, moved 0.017 degrees west so that the shore of 1859 meets the modern shore at
 * Black Point and Rincon Point. The corners are approximate to about 100 m.
 */
export const CHART_CORNERS: Corners = [
  [-122.4427, 37.7437],
  [-122.4427, 37.8251],
  [-122.3717, 37.8251],
  [-122.3717, 37.7437]
];

/** How far the skew moves the bottom right corner, in degrees of longitude and latitude. */
export const SKEW_OFFSET: Corner = [0.012, 0.007];

/**
 * The corners of the chart. With `skew`, the bottom right corner moves to the north-east, so the
 * quad is not a parallelogram and the image is warped as a perspective view.
 */
export function getChartCorners(skew: boolean): Corners {
  if (!skew) {
    return CHART_CORNERS;
  }
  const [topLeft, topRight, [longitude, latitude], bottomLeft] = CHART_CORNERS;
  return [topLeft, topRight, [longitude + SKEW_OFFSET[0], latitude + SKEW_OFFSET[1]], bottomLeft];
}

/** The style that draws the chart: an `image` source and a `raster` layer over it. */
export function getChartStyle({opacity, skew}: {opacity: number; skew: boolean}) {
  return {
    version: 8 as const,
    sources: {
      chart: {type: 'image' as const, url: CHART_URL, coordinates: getChartCorners(skew)}
    },
    layers: [
      {
        id: 'chart',
        type: 'raster' as const,
        source: 'chart',
        paint: {'raster-opacity': opacity, 'raster-fade-duration': 0}
      }
    ]
  };
}
