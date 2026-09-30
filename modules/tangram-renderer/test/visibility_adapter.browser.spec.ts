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

    it('omits tiles wholly behind the globe horizon when the camera is known', () => {
        const adapter = new WebMercatorGlobeVisibilityAdapter();
        const coordinates = adapter.findVisibleTileCoordinates({
            tile_zoom: 4,
            buffer: 0,
            visibleBounds: [-180, -85, 180, 85],
            maxElevation: 0,
            cameraPosition: [0, -1000, 0]
        });

        expect(coordinates.length).toBeGreaterThan(0);
        expect(coordinates.length).toBeLessThan(16 * 16);
        expect(coordinates.every(({x}) => x !== 0 && x !== 15)).toBe(true);
    });

    it('keeps geographic-bounds behavior when no globe camera is supplied', () => {
        const adapter = new WebMercatorGlobeVisibilityAdapter();
        const coordinates = adapter.findVisibleTileCoordinates({
            tile_zoom: 2,
            buffer: 0,
            visibleBounds: [-180, -85, 180, 85]
        });

        expect(coordinates).toHaveLength(16);
    });

    it('does not assume surface-only content when the elevation bound is unknown', () => {
        const adapter = new WebMercatorGlobeVisibilityAdapter();
        expect(adapter.findVisibleTileCoordinates({
            tile_zoom: 4, buffer: 0, visibleBounds: [-180, -85, 180, 85],
            cameraPosition: [0, -1000, 0]
        })).toHaveLength(256);
    });

    it('retains elevated content beyond the ground horizon and expands monotonically', () => {
        const adapter = new WebMercatorGlobeVisibilityAdapter();
        const state = {
            tile_zoom: 8, buffer: 0, visibleBounds: [82, -1, 84, 1] as const,
            cameraPosition: [0, -1000, 0] as const
        };
        const surface = adapter.findVisibleTileCoordinates({...state, maxElevation: 0});
        const elevated = adapter.findVisibleTileCoordinates({...state, maxElevation: 200000});
        const higher = adapter.findVisibleTileCoordinates({...state, maxElevation: 400000});
        expect(surface).toHaveLength(0);
        expect(elevated.length).toBeGreaterThan(0);
        expect(new Set(higher.map(tile => tile.key))).toEqual(new Set(elevated.map(tile => tile.key)));
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid elevation bound %s', maxElevation => {
        expect(() => new WebMercatorGlobeVisibilityAdapter().findVisibleTileCoordinates({
            tile_zoom: 1, buffer: 0, visibleBounds: [-180, -85, 180, 85], maxElevation
        })).toThrow(/maxElevation/);
    });

    it.each([[0, 0, 0], [0, -256, 0], [0, Number.NaN, 0]])('retains candidates for an unusable camera %s', (...cameraPosition) => {
        expect(new WebMercatorGlobeVisibilityAdapter().findVisibleTileCoordinates({
            tile_zoom: 1, buffer: 0, visibleBounds: [-180, -85, 180, 85], maxElevation: 0,
            cameraPosition
        })).toHaveLength(4);
    });

    it('never rejects tiles containing analytically visible elevated samples', () => {
        const adapter = new WebMercatorGlobeVisibilityAdapter();
        const maximumElevation = 200000;
        const elevatedRadius = 256 * (1 + maximumElevation / 6370972);
        for (const longitude of [-88, -82, 0, 82, 88]) {
            const angle = longitude * Math.PI / 180;
            const point = [elevatedRadius * Math.sin(angle), -elevatedRadius * Math.cos(angle)];
            const direction = [point[0], point[1] + 1000];
            // Independently verify the sight segment does not intersect the sphere.
            const parameter = Math.max(0, Math.min(1,
                1000 * direction[1] / (direction[0] ** 2 + direction[1] ** 2)));
            expect(Math.hypot(parameter * direction[0], -1000 + parameter * direction[1])).toBeGreaterThan(256);
            const coordinates = adapter.findVisibleTileCoordinates({
                tile_zoom: 8, buffer: 0,
                visibleBounds: [longitude - 0.01, -0.01, longitude + 0.01, 0.01],
                cameraPosition: [0, -1000, 0], maxElevation: maximumElevation
            });
            const meters = Geo.latLngToMeters([longitude, 0]);
            const expected = Geo.tileForMeters(meters, 8);
            expect(coordinates.some(tile => tile.x === expected.x && tile.y === expected.y)).toBe(true);
        }
    });

    it('keeps height selection monotonic across a world-spanning polar footprint', () => {
        const adapter = new WebMercatorGlobeVisibilityAdapter();
        const state = {tile_zoom: 4, buffer: 0, visibleBounds: [-180, -90, 180, 90] as const,
            cameraPosition: [0, -1000, 0] as const};
        let previous = new Set<string>();
        for (const maxElevation of [0, 1000, 200000, Number.MAX_VALUE]) {
            const coordinates = adapter.findVisibleTileCoordinates({...state, maxElevation});
            const keys = new Set(coordinates.map(tile => tile.key));
            for (const key of previous) expect(keys.has(key)).toBe(true);
            expect(keys.size).toBe(coordinates.length);
            previous = keys;
        }
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
