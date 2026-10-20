// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** NASA GIBS Web Mercator Blue Marble imagery; the service supplies levels 0–8. */
export const BLUE_MARBLE_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';

/** Credit the imagery creator separately from the tile service; no endorsement is implied. */
export const BLUE_MARBLE_ATTRIBUTION = 'Imagery: <a href="https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/">NASA Earth Observatory</a> | Tiles: <a href="https://nasa-gibs.github.io/gibs-api-docs/">NASA GIBS</a>';

/** Return fresh scene records so examples can customize their camera and styles independently. */
export function createBlueMarbleScene() {
  return {
    scene: {background: {color: '#0b1729'}},
    // Imagery is already shaded by its provider. Do not relight it with the
    // legacy default directional light, especially across a curved globe.
    styles: {blueMarble: {base: 'raster', lighting: false}},
    sources: {blueMarble: {type: 'Raster', url: BLUE_MARBLE_URL, max_zoom: 8, attribution: BLUE_MARBLE_ATTRIBUTION}},
    layers: {ground: {data: {source: 'blueMarble'}, draw: {raster: {style: 'blueMarble', order: 0}}}}
  };
}
