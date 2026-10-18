// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Explicit map-surface coverage for host-owned render passes. A scene clear
 * color cannot paint into deck's existing pass or distinguish land from sky.
 * Like community basemap-layers' background polygon, this is geometry, not a
 * framebuffer clear. Tangram's normal tiling/refinement keeps it on the globe.
 * Coverage ends at the Web Mercator data domain; it does not invent polar data.
 */
export function createBasemapBackground(color: string) {
  const latitudeLimit = 85.0511287798066;
  const geometry = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {},
    geometry: {type: 'Polygon', coordinates: [[[-180, -latitudeLimit], [180, -latitudeLimit],
      [180, latitudeLimit], [-180, latitudeLimit], [-180, -latitudeLimit]]]}}]};
  return {
    sources: {basemapBackground: {type: 'GeoJSON', max_zoom: 14,
      url: `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(geometry))}`}},
    styles: {basemapBackground: {base: 'polygons', lighting: false}},
    layers: {basemapBackground: {data: {source: 'basemapBackground'},
      draw: {basemapBackground: {order: 0, color, interactive: false}}}}
  };
}
