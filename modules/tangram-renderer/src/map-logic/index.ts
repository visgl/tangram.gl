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
export type {ElevationDecoder, TerrainGridOptions, TerrainHeightGrid} from './terrain-data';
export {TriangleQueryIndex} from './triangle-query-index';
export type {IndexedTriangleHit, TriangleQueryResult, TriangleQueryIndexOptions} from './triangle-query-index';
export {buildGlobeTerrainMesh, prepareGlobeTerrainMesh, prepareGlobeTerrainMeshSteps, scaleGlobeTerrainMesh, getGlobeTerrainExaggeration} from './globe-terrain';
export type {GlobeTerrainMesh, GlobeTerrainMeshTemplate} from './globe-terrain';
export {GlobeTerrainPreparation, getPreparedGlobeTerrainTemplate} from './globe-terrain-preparation';
export type {GlobeTerrainPreparationSnapshot, GlobeTerrainPreparationStatistics} from './globe-terrain-preparation';
