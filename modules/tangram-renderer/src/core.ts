// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export {default as Renderer} from './scene/renderer';
export {default as HostFrame} from './scene/host_frame';
export {calculatePlanarGroundBounds} from './scene/ground_footprint';
export {PROJECTION_CONSTANTS, projectGeographicPosition, projectGeographicVector, unprojectGlobePosition, getGeographicProjectionProcedure} from './scene/projection_math';
export type {GeographicProjectionPosition, GeographicProjectionProcedure} from './scene/projection_math';
export {convertLumaLight, mapTangramLight} from './lights/light-definitions';
export type {ResolvedTangramLight, TangramLightMapping, TangramLight, TangramAmbientLight,
    TangramDirectionalLight, TangramPointLight, TangramSpotLight, TangramLightExtensions,
    TangramPositionalLightExtensions, TangramLightColor} from './lights/light-definitions';
export type {Light as LumaLight} from '@luma.gl/shadertools';
export type {TangramTileSourceMetadata} from './sources/tile_source_metadata';
export {default as LumaDeviceRenderer} from './gpu/luma_device_renderer';
export {WebMercatorGlobeVisibilityAdapter, WebMercatorVisibilityAdapter} from './scene/visibility_adapter';
export type {HostFrameOptions, HostRenderView, HostTileLODOptions, HostTileResourceOptions, TileResourceStatistics, TileSourceStatistics, HostCamera, HostProjection, GeographicAnchor, LegacyHostFrame, RendererOptions, RenderOptions, Viewport} from './types';
export type {VisibilityLODAdapter, GlobeVisibilityLODAdapter, VisibilityViewState, GlobeVisibilityViewState, CalculatedViewBounds} from './scene/visibility_adapter';
