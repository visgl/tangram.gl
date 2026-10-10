// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export {ClassicWebGLRenderer as Renderer, HostFrame, LumaDeviceRenderer, WebMercatorGlobeVisibilityAdapter, WebMercatorVisibilityAdapter} from '@vis.gl/tangram-renderer';
export type {FeatureSelectionResult, FeatureSelectionOptions} from '@vis.gl/tangram-renderer';
export {TerrainMeshSurface, pickTerrainAt} from './selection/terrain_surface';
export type {TerrainSurface, TerrainRay, TerrainSurfaceHit, TerrainMeshOptions} from './selection/terrain_surface';
export {calculatePlanarGroundBounds, calculatePlanarVolumeBounds} from './scene/ground_footprint';
export {validateProjectedLights} from './procedures/mesh-projector';
export {normalizeProjectedBasemapOptions} from './procedures/mesh-projector';
export {getProjectedRoadUnit} from './procedures/mesh-projector';
export {countProjectedTileCoordinates, getTileGeographicBounds} from './tile/tile_traversal_adapter';
export {getProjectedCoordinateOptions, PROJECTED_COMMON_SCALE} from './procedures/projected-coordinate-transform';
export {ProjectionBatchExecutor} from './procedures/projection-batch-executor.js';
export type {ProjectionExecutionOptions, ProjectionExecutionStatistics, ProjectionBatchRequestOptions} from './procedures/projection-batch-executor.js';
export type {ProjectedBasemapOptions, MeshProjectionStatistics} from './procedures/mesh-projector';
export {PROJECTION_CONSTANTS, projectGeographicPosition, projectGeographicVector, unprojectGlobePosition, getGeographicProjectionProcedure} from './scene/projection_math';
export type {GeographicProjectionPosition, GeographicProjectionProcedure} from './scene/projection_math';
export {convertLumaLight, mapTangramLight} from './lights/light-definitions';
export type {ResolvedTangramLight, TangramLightMapping, TangramLight, TangramAmbientLight,
    TangramDirectionalLight, TangramPointLight, TangramSpotLight, TangramLightExtensions,
    TangramPositionalLightExtensions, TangramLightColor} from './lights/light-definitions';
export type {Light as LumaLight} from '@luma.gl/shadertools';
export type {TangramTileSourceMetadata} from './sources/tile_source_metadata';
export type {HostFrameOptions, HostRenderView, HostTileLODOptions, HostTileResourceOptions, TileResourceStatistics, TileSourceStatistics, HostCamera, HostProjection, GeographicAnchor, LegacyHostFrame, RendererOptions, RenderOptions, Viewport, SceneDefinition, SceneListeners, SceneLoadOptions, VisibilityLODAdapter, GlobeVisibilityLODAdapter, VisibilityViewState, GlobeVisibilityViewState, CalculatedViewBounds} from '@vis.gl/tangram-renderer';
export type {ProjectionEngine, ProjectionEngineOptions, ProjectionEngineTransform} from './types.js';
