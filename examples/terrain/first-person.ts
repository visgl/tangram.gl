// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {FirstPersonViewport, type FirstPersonViewState} from '@deck.gl/core';
import type {LoadedTerrain} from './load-terrain';
import {sampleTerrainAnchor} from './ground-following';
import {TerrainSurfaceCollection, projectGeographicPosition} from '@tangram.gl/tangram-renderer/core';
import type {TerrainSurface} from '@tangram.gl/tangram-renderer/core';
import {TerrainHeightField, guardTerrainMotion} from '@tangram.gl/tangram-renderer/map-logic';

/** Geographic FirstPerson state with a required meter offset and finite anchor. */
export type TerrainEyeState = FirstPersonViewState & {
    /** Geographic anchor longitude in degrees. */
    longitude: number;
    /** Geographic anchor latitude in degrees. */
    latitude: number;
    /** Local deck meter offsets, not an EPSG:3857 meter coordinate. */
    position: [number, number, number];
};

/** Resolve the actual eye, including deck's XY meter offsets and latitude scale. */
export function getTerrainEyeCoordinate(state: TerrainEyeState): [number, number, number] {
    if (![state.longitude, state.latitude, ...state.position].every(Number.isFinite) || Math.abs(state.latitude) > 85.0511287798066 || state.modelMatrix) throw new Error('Terrain eye requires finite Mercator coordinates without a model matrix');
    const viewport = new FirstPersonViewport({...state, width: 1, height: 1});
    const coordinate = viewport.unprojectPosition(viewport.cameraPosition);
    if (!coordinate.every(Number.isFinite)) throw new Error('Terrain eye is outside finite projection space');
    coordinate[0] = ((coordinate[0] + 180) % 360 + 360) % 360 - 180;
    return coordinate;
}

/** Clamp a point eye above loaded top triangles; missing data holds its previous height. */
export function constrainTerrainEye(state: TerrainEyeState, tiles: Iterable<LoadedTerrain>, clearance: number, previousAltitude: number, displayedSurface?: TerrainSurface): {state: TerrainEyeState; available: boolean} {
    if (!Number.isFinite(previousAltitude)) throw new Error('Invalid previous eye altitude');
    const coordinate = getTerrainEyeCoordinate(state);
    const floor = sampleTerrainAnchor(tiles, [coordinate[0], coordinate[1]], clearance, displayedSurface);
    const altitude = floor === null ? previousAltitude : Math.max(state.position[2], floor);
    return {state: {...state, position: [state.position[0], state.position[1], altitude]}, available: floor !== null};
}

/**
 * Guard a finite eye segment against loaded top triangles, retaining look changes
 * when translation is blocked. This is a point-clearance guard, not avatar physics
 * or a certification that every intermediate footprint has loaded coverage.
 */
export function constrainTerrainMotion(previous: TerrainEyeState, proposed: TerrainEyeState, tiles: Iterable<LoadedTerrain>, clearance: number, displayedSurface?: TerrainSurface, footprint?: {
    /** Physical horizontal avatar radius; square envelope is conservative. */
    radius: number;
    /** Physical minimum body/eye height; omission uses the target-following clearance. */
    clearance?: number;
    /** Optional host-owned field matching the supplied visible grids, reused across controller events. */
    field?: TerrainHeightField;
}): {state: TerrainEyeState; available: boolean; blocked: boolean} {
    const loaded = [...tiles];
    const clamped = constrainTerrainEye(proposed, loaded, clearance, previous.position[2], displayedSurface);
    const start = getTerrainEyeCoordinate(previous), end = getTerrainEyeCoordinate(clamped.state);
    const startFloor = sampleTerrainAnchor(loaded, [start[0], start[1]], clearance, displayedSurface);
    // A newly admitted surface can raise the floor under a previously safe eye.
    // Repair that starting height before testing motion, so leaving the ground is not blocked.
    if (startFloor !== null) start[2] = Math.max(start[2], startFloor);
    const hold = (): TerrainEyeState => ({...proposed, longitude: previous.longitude, latitude: previous.latitude, position: [previous.position[0], previous.position[1], start[2]]});
    // Wrapped eye coordinates need an explicit world-copy path, not a ray through Earth.
    if (!clamped.available || Math.abs(end[0] - start[0]) > 180) return {state: hold(), available: clamped.available, blocked: true};
    const collection = new TerrainSurfaceCollection('web-mercator', displayedSurface ? [{id: 'displayed', surface: displayedSurface}] : loaded.map((tile, index) => ({id: String(index), surface: tile.surface})));
    const rayStart = projectGeographicPosition([start[0], start[1], start[2] - clearance], 'web-mercator');
    const rayEnd = projectGeographicPosition([end[0], end[1], end[2] - clearance], 'web-mercator');
    if (footprint) {
        if (!Number.isFinite(footprint.radius) || footprint.radius < 0) throw new Error('Invalid terrain avatar radius');
        const field = footprint.field ?? new TerrainHeightField(loaded.map(tile => tile.grid));
        // Bound Mercator scale across the path and the physical body radius.
        const latitude = Math.min(85.0511287798066, Math.max(Math.abs(start[1]), Math.abs(end[1])) + footprint.radius / 110000);
        const scale = 1 / Math.cos(latitude * Math.PI / 180);
        const guarded = guardTerrainMotion(field, [rayStart[0], rayStart[1], start[2]], [rayEnd[0], rayEnd[1], end[2]],
            {radius: footprint.radius * scale, clearance: footprint.clearance ?? clearance, maxStep: 2 * scale});
        if (guarded.blocked) return {state: hold(), available: guarded.available, blocked: true};
    }
    const hit = collection.intersectSegment(rayStart, rayEnd, {startInset: 1e-4, endInset: 1e-4});
    return hit ? {state: hold(), available: true, blocked: true} : {...clamped, blocked: false};
}
