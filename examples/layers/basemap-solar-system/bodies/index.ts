// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// bodies: the map of each body. A registry with the CRS, raster tile source, vector data and
// credits of each body, and its BasemapLayer styles. Imports celestial/ only. Later home:
// tangram.gl, as basemaps of other worlds.

export type {Body, BodyMap, GeoSource, VectorData} from './registry';
export {BODIES, SHIM_HOST, rasterCredit} from './registry';
export type {BasemapStyle, SurfaceMode} from './styles';
export {DETAIL_FROM, EARTH_STYLE_URL, getBodyStyle, getEarthStyle, surfaceCredit} from './styles';
export {TEXTURE_STYLE_ZOOM, getVectorTexture} from './textures';
