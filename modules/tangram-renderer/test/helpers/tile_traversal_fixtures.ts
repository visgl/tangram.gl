// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TangramTraversalState} from '../../src/tile/tile_traversal_adapter';
import type {VisibilityViewState} from '../../src/scene/visibility_adapter';
import Geo from '../../src/utils/geo';

/** Compact geographic frame with independent data/style zoom. */
export function createTraversalView(overrides: Partial<VisibilityViewState> = {}): VisibilityViewState {
    const southwest = Geo.latLngToMeters([-45, -10]), northeast = Geo.latLngToMeters([45, 10]);
    return {center: {lng: 0, lat: 0}, zoom: 8, tile_zoom: 2, size: {css: {width: 64, height: 64}},
        bounds: {sw: {x: southwest[0], y: southwest[1]}, ne: {x: northeast[0], y: northeast[1]}},
        buffer: 0, wrap: false, ...overrides};
}

const central = ['1/1/2', '1/2/2', '2/1/2', '2/2/2'];
/** Fixed expected footprints shared by procedure-level and full candidate lifecycle tests. */
export const traversalFixtures: Array<{name: string; state: TangramTraversalState; keys: string[]}> = [
    {name: 'flat/perspective geographic footprint', state: {eyes: [{view: createTraversalView(), projection: {type: 'web-mercator'}}]}, keys: central},
    {name: 'FirstPerson explicit bounded footprint', state: {eyes: [{view: createTraversalView({bounds: null}),
        projection: {type: 'web-mercator', visibleBounds: [-45, -10, 45, 10]}}]}, keys: central},
    {name: 'empty FirstPerson horizon footprint', state: {eyes: [{view: createTraversalView(), projection: {type: 'web-mercator', visibleBounds: null}}]}, keys: []},
    {name: 'globe footprint', state: {eyes: [{view: createTraversalView({tile_zoom: 3}),
        projection: {type: 'globe', visibleBounds: [-100, 20, -50, 60]}}]}, keys: ['1/2/3', '1/3/3', '2/2/3', '2/3/3']},
    {name: 'globe antimeridian', state: {eyes: [{view: createTraversalView(),
        projection: {type: 'globe', visibleBounds: [170, -10, -170, 10]}}]}, keys: ['3/1/2', '3/2/2', '0/1/2', '0/2/2']},
    {name: 'stereo deduplication', state: {eyes: [
        {view: createTraversalView(), projection: {type: 'web-mercator'}},
        {view: createTraversalView(), projection: {type: 'web-mercator'}}]}, keys: central},
    {name: 'distinct stereo eye union', state: {eyes: [
        {view: createTraversalView(), projection: {type: 'web-mercator', visibleBounds: [-120, -10, -40, 10]}},
        {view: createTraversalView(), projection: {type: 'web-mercator', visibleBounds: [40, -10, 120, 10]}}]},
        keys: ['0/1/2', '0/2/2', '1/1/2', '1/2/2', '2/1/2', '2/2/2', '3/1/2', '3/2/2']},
    {name: 'not ready', state: {eyes: []}, keys: []}
];
