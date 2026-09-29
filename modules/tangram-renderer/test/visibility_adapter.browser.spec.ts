// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
import Geo from '../src/utils/geo';
import {
    WebMercatorGlobeVisibilityAdapter,
    WebMercatorVisibilityAdapter,
    type VisibilityViewState
} from '../src/scene/visibility_adapter';

describe('WebMercatorVisibilityAdapter', () => {
    it('calculates the legacy meter-space bounds and center tile', () => {
        const adapter = new WebMercatorVisibilityAdapter();
        const view = createViewState();
        const result = adapter.calculateBounds(view);
        const centerMeters = Geo.latLngToMeters([view.center.lng, view.center.lat]);

        expect(result.metersPerPixel).toBe(Geo.metersPerPixel(view.zoom));
        expect(result.centerMeters).toEqual({x: centerMeters[0], y: centerMeters[1]});
        expect(result.centerTile).toEqual(
            Geo.tileForMeters([centerMeters[0], centerMeters[1]], view.tile_zoom)
        );
        expect(result.sizeMeters).toEqual({
            x: view.size.css.width * Geo.metersPerPixel(view.zoom),
            y: view.size.css.height * Geo.metersPerPixel(view.zoom)
        });
        expect(result.bounds.sw.x).toBe(result.centerMeters.x - result.sizeMeters.x / 2);
        expect(result.bounds.ne.y).toBe(result.centerMeters.y + result.sizeMeters.y / 2);
    });

    it('preserves buffered tile ranges and clamps non-wrapping views', () => {
        const adapter = new WebMercatorVisibilityAdapter();
        const view = createViewState({
            bounds: {
                sw: {x: -Geo.half_circumference_meters, y: -Geo.half_circumference_meters},
                ne: {x: 0, y: 0}
            },
            buffer: 0,
            tile_zoom: 2,
            wrap: false
        });

        const coordinates = adapter.findVisibleTileCoordinates(view);

        expect(coordinates.map(({x, y, z}) => `${x}/${y}/${z}`)).toEqual([
            '0/2/2', '0/3/2',
            '1/2/2', '1/3/2',
            '2/2/2', '2/3/2'
        ]);
    });

    it('returns no tiles until bounds are available', () => {
        const adapter = new WebMercatorVisibilityAdapter();
        expect(adapter.findVisibleTileCoordinates(createViewState({bounds: null}))).toEqual([]);
    });
});

describe('WebMercatorGlobeVisibilityAdapter', () => {
    it('selects the geographic tile rectangle at the requested zoom', () => {
        const adapter = new WebMercatorGlobeVisibilityAdapter();
        const coordinates = adapter.findVisibleTileCoordinates({
            tile_zoom: 3,
            buffer: 0,
            visibleBounds: [-100, 20, -50, 60]
        });

        expect(coordinates.map(({x, y, z}) => `${x}/${y}/${z}`)).toEqual([
            '1/2/3', '1/3/3',
            '2/2/3', '2/3/3'
        ]);
    });

    it('splits antimeridian bounds and does not duplicate buffered tiles', () => {
        const adapter = new WebMercatorGlobeVisibilityAdapter();
        const coordinates = adapter.findVisibleTileCoordinates({
            tile_zoom: 2,
            buffer: 1,
            visibleBounds: [170, -10, 190, 10]
        });
        const keys = coordinates.map(({x, y, z}) => `${x}/${y}/${z}`);

        expect(keys).toEqual(['2/0/2', '2/1/2', '2/2/2', '2/3/2',
            '3/0/2', '3/1/2', '3/2/2', '3/3/2',
            '0/0/2', '0/1/2', '0/2/2', '0/3/2',
            '1/0/2', '1/1/2', '1/2/2', '1/3/2']);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('clamps polar bounds and covers all tiles for a world-spanning view', () => {
        const adapter = new WebMercatorGlobeVisibilityAdapter();
        const coordinates = adapter.findVisibleTileCoordinates({
            tile_zoom: 1,
            buffer: 0,
            visibleBounds: [-180, -90, 180, 90]
        });

        expect(coordinates.map(({x, y, z}) => `${x}/${y}/${z}`)).toEqual([
            '0/0/1', '0/1/1',
            '1/0/1', '1/1/1'
        ]);
    });
});

function createViewState(
    overrides: Partial<VisibilityViewState> = {}
): VisibilityViewState {
    return {
        center: {lng: -74.009764, lat: 40.705319},
        zoom: 3,
        tile_zoom: 3,
        size: {css: {width: 800, height: 600}},
        bounds: null,
        buffer: 0,
        wrap: true,
        ...overrides
    };
}
