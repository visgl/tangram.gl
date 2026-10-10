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
