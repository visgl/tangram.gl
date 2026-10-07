// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export {ClassicWebGLRenderer as Renderer, HostFrame, LumaDeviceRenderer, WebMercatorGlobeVisibilityAdapter, WebMercatorVisibilityAdapter} from '@vis.gl/tangram-renderer';
export {calculatePlanarGroundBounds} from './scene/ground_footprint';
export {normalizeProjectedBasemapOptions} from './procedures/mesh-projector';
export type {ProjectedBasemapOptions} from './procedures/mesh-projector';
export {PROJECTION_CONSTANTS, projectGeographicPosition, projectGeographicVector, unprojectGlobePosition, getGeographicProjectionProcedure} from './scene/projection_math';
export type {GeographicProjectionPosition, GeographicProjectionProcedure} from './scene/projection_math';
export {convertLumaLight, mapTangramLight} from './lights/light-definitions';
export type {ResolvedTangramLight, TangramLightMapping, TangramLight, TangramAmbientLight,
    TangramDirectionalLight, TangramPointLight, TangramSpotLight, TangramLightExtensions,
    TangramPositionalLightExtensions, TangramLightColor} from './lights/light-definitions';
export type {Light as LumaLight} from '@luma.gl/shadertools';
export type {TangramTileSourceMetadata} from './sources/tile_source_metadata';
export type {HostFrameOptions, HostRenderView, HostTileLODOptions, HostTileResourceOptions, TileResourceStatistics, TileSourceStatistics, HostCamera, HostProjection, GeographicAnchor, LegacyHostFrame, RendererOptions, RenderOptions, Viewport, SceneDefinition, SceneListeners, SceneLoadOptions, VisibilityLODAdapter, GlobeVisibilityLODAdapter, VisibilityViewState, GlobeVisibilityViewState, CalculatedViewBounds} from '@vis.gl/tangram-renderer';
export type {ProjectionEngine} from '@math.gl/projection/types';
