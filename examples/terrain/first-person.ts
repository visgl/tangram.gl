// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {FirstPersonViewport, type FirstPersonViewState} from '@deck.gl/core';
import type {LoadedTerrain} from './load-terrain';
import {sampleTerrainAnchor} from './ground-following';

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
export function constrainTerrainEye(state: TerrainEyeState, tiles: Iterable<LoadedTerrain>, clearance: number, previousAltitude: number): {state: TerrainEyeState; available: boolean} {
    if (!Number.isFinite(previousAltitude)) throw new Error('Invalid previous eye altitude');
    const coordinate = getTerrainEyeCoordinate(state);
    const floor = sampleTerrainAnchor(tiles, [coordinate[0], coordinate[1]], clearance);
    const altitude = floor === null ? previousAltitude : Math.max(state.position[2], floor);
    return {state: {...state, position: [state.position[0], state.position[1], altitude]}, available: floor !== null};
}
