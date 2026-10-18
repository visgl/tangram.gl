// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

export {resolveLabelPlacement} from './label-placement';
export type {ScreenLabelCandidate, LabelPlacementOptions} from './label-placement';
export {areGeographicLabelCopies} from './label-identity';
export type {GeographicLabelAnchor, GeographicLabelIdentityOptions} from './label-identity';
export {intersectsScreenBounds, unionScreenBounds, getScreenBoundsCells} from './screen-bounds';
export type {ScreenBounds, LabelViewport} from './screen-bounds';
export {default as TileBuildQueue} from './tile-build-queue';
export type {TileBuildTask} from './tile-build-queue';
export {TileResidency} from './tile-residency';
export {TileCachePolicy} from './tile-cache-policy';
export type {TileCacheRecord, TileCacheOptions, TileCacheStatistics} from './tile-cache-policy';
export {TERRARIUM_DECODER, TERRAIN_RGB_DECODER, decodeTerrainHeightGrid, sampleTerrainHeight} from './terrain-data';
export {sampleTerrainNeighborhood, resampleTerrainNodes} from './terrain-neighborhood';
export {TerrainHeightField} from './terrain-height-field';
export {TerrainResourceBudget} from './terrain-resource-budget';
export type {TerrainResourceDomain, TerrainResourceLease} from './terrain-resource-budget';
export {measureTerrainError, boundTerrainMeshError, selectTerrainMeshResolution, boundProjectedDisplacement} from './terrain-error';
export type {TerrainErrorEnvelope} from './terrain-error';
export {guardTerrainMotion} from './terrain-navigation';
export type {TerrainMotionResult} from './terrain-navigation';
export type {TerrainFieldBounds, TerrainHeightFieldOptions, TerrainHeightFieldStatistics} from './terrain-height-field';
export {createTerrainGroundTopology} from './terrain-ground-topology';
export type {TerrainGroundTopology} from './terrain-ground-topology';
export type {ElevationDecoder, TerrainGridOptions, TerrainHeightGrid} from './terrain-data';
export {TriangleQueryIndex} from './triangle-query-index';
export {adaptTerrainQuerySource} from './terrain-query';
export type {TerrainQuerySource, TerrainQueryHit} from './terrain-query';
export type {TerrainSurface, TerrainSurfaceBounds, TerrainRay, TerrainSurfaceHit} from '../selection/terrain_surface';
export type {IndexedTriangleHit, TriangleQueryResult, TriangleQueryIndexOptions} from './triangle-query-index';
export {buildGlobeTerrainMesh, prepareGlobeTerrainMesh, prepareGlobeTerrainMeshSteps, scaleGlobeTerrainMesh, scaleGlobeTerrainMeshSteps, getGlobeTerrainExaggeration} from './globe-terrain';
export type {GlobeTerrainMesh, GlobeTerrainMeshTemplate} from './globe-terrain';
export {GlobeTerrainPreparation, getPreparedGlobeTerrainTemplate, assertGlobeTerrainPreparationSnapshot} from './globe-terrain-preparation';
export type {GlobeTerrainPreparationSnapshot, GlobeTerrainPreparationStatistics} from './globe-terrain-preparation';
