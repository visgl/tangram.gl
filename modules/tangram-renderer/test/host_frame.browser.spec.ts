// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it, test} from 'vitest';
import HostFrame from '../src/scene/host_frame';

import type {HostCamera} from '../src/types';

const IDENTITY_MATRIX = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1
];

function createCamera(offset = 0): HostCamera {
    const view = IDENTITY_MATRIX.slice();
    view[12] = offset;
    return {
        view,
        projection: IDENTITY_MATRIX,
        position: [offset, 0, 0]
    };
}

describe('HostFrame', function () {
    test.each([{}, {type: ''}, {type: null}, {type: undefined}, 'globe', null])(
        'rejects an explicit malformed projection %j in modern, legacy, and per-eye frames', projection => {
            const base = {
                viewport: {width: 800, height: 600},
                geographicAnchor: {longitude: 0, latitude: 0, zoom: 4},
                renderViews: [{camera: createCamera()}]
            };
            expect(() => HostFrame.from({...base, projection})).toThrow(/projection/);
            expect(() => HostFrame.from({viewport: base.viewport, view: base.geographicAnchor,
                camera: createCamera(), projection})).toThrow(/projection/);
            expect(() => HostFrame.from({...base,
                renderViews: [{camera: createCamera(), projection}]})).toThrow(/projection/);
            expect(HostFrame.from(base).projection).toEqual({type: 'web-mercator'});
        }
    );
    it.each([undefined, 0, 3, 4])('normalizes data LOD %s in modern and legacy frames', tileZoom => {
        const frame = HostFrame.from({viewport: {width: 800, height: 600},
            view: {longitude: 0, latitude: 0, zoom: 4.5}, camera: createCamera(), tileZoom});
        expect(frame.tileZoom).toBe(tileZoom);
        expect(new HostFrame({...frame, tileZoom}).tileZoom).toBe(tileZoom);
        expect(frame.geographicAnchor.zoom).toBe(4.5);
    });

    it.each([-1, 0.5, 5, 23, NaN, Infinity, '3', null])('rejects invalid or finer-than-style data LOD %s', tileZoom => {
        const frame = {viewport: {width: 800, height: 600},
            geographicAnchor: {longitude: 0, latitude: 0, zoom: 4.5}, renderViews: [{camera: createCamera()}], tileZoom};
        expect(() => HostFrame.from(frame)).toThrow(/tileZoom/);
        expect(() => HostFrame.from({...frame, geographicAnchor: undefined,
            view: frame.geographicAnchor, renderViews: undefined, camera: createCamera()})).toThrow(/tileZoom/);
    });

    it('preserves copied planar bounds, explicit empty bounds and unknown bounds distinctly', () => {
        const visibleBounds = [-181, -10, -179, 10];
        const base = {viewport: {width: 800, height: 600}, view: {longitude: 180, latitude: 0, zoom: 4}, camera: createCamera()};
        const frame = HostFrame.from({...base, projection: {type: 'web-mercator', visibleBounds}});
        visibleBounds[0] = 0;
        expect(frame.projection).toEqual({type: 'web-mercator', visibleBounds: [-181, -10, -179, 10]});
        expect(HostFrame.from({...base, projection: {type: 'web-mercator', visibleBounds: null}}).projection).toEqual({type: 'web-mercator', visibleBounds: null});
        expect(HostFrame.from(base).projection).toEqual({type: 'web-mercator'});
        expect(() => HostFrame.from({...base, projection: {type: 'web-mercator', visibleBounds: [2, -10, 1, 10]}})).toThrow(/ordered visibleBounds/);
        expect(() => HostFrame.from({...base, projection: {type: 'web-mercator', visibleBounds: [-1, -90, 1, 10]}})).toThrow(/latitudes/);
        expect(() => HostFrame.from({...base, projection: {type: 'web-mercator', visibleBounds: [-1, -10, 1, 90]}})).toThrow(/latitudes/);
    });
    it('normalizes the original renderer frame shape', function () {
        const frame = HostFrame.from({
            viewport: { width: 800, height: 600 },
            view: { longitude: -74, latitude: 40.7, zoom: 16 },
            camera: createCamera(),
            tileBuffer: 2
        });

        expect(frame).toBeInstanceOf(HostFrame);
        expect(frame.viewport).toEqual({ x: 0, y: 0, width: 800, height: 600 });
        expect(frame.geographicAnchor).toEqual({
            longitude: -74,
            latitude: 40.7,
            altitude: 0,
            zoom: 16
        });
        expect(frame.activeRenderViewId).toBe('default');
        expect(frame.getRenderView().id).toBe('default');
        expect(frame.projection).toEqual({type: 'web-mercator'});
        expect(frame.tileBuffer).toBe(2);
    });

    it('stores multiple camera views over shared geographic state', function () {
        const frame = new HostFrame({
            viewport: { width: 1600, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, altitude: 10, zoom: 16 },
            renderViews: [
                {
                    id: 'left-eye',
                    viewport: { x: 0, y: 0, width: 800, height: 600 },
                    camera: createCamera(-0.03)
                },
                {
                    id: 'right-eye',
                    viewport: { x: 800, y: 0, width: 800, height: 600 },
                    camera: createCamera(0.03)
                }
            ],
            activeRenderViewId: 'left-eye'
        });

        expect(frame.renderViews).toHaveLength(2);
        expect(frame.getRenderView('right-eye').viewport.x).toBe(800);
        expect(frame.getRenderView('left-eye').camera.position[0]).toBeCloseTo(-0.03, 10);
        expect(frame.getRenderView('right-eye').camera.position[0]).toBeCloseTo(0.03, 10);
    });

    it('normalizes an explicit globe projection with host visibility bounds', function () {
        const frame = new HostFrame({
            viewport: { width: 800, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, zoom: 3 },
            projection: { type: 'globe', visibleBounds: [-120, -45, 20, 70] },
            renderViews: [{ id: 'main', camera: createCamera() }]
        });

        expect(frame.projection).toEqual({
            type: 'globe',
            visibleBounds: [-120, -45, 20, 70]
        });
    });

    it('rejects incomplete and ambiguous frame state', function () {
        expect(() => HostFrame.from({})).toThrow(/viewport/);
        expect(() => HostFrame.from({
            viewport: { width: 800, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, zoom: 16 },
            renderViews: []
        })).toThrow(/at least one render view/);
        expect(() => HostFrame.from({
            viewport: { width: 800, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, zoom: 16 },
            renderViews: [
                { id: 'eye', camera: createCamera() },
                { id: 'eye', camera: createCamera() }
            ]
        })).toThrow(/duplicated/);
        expect(() => HostFrame.from({
            viewport: { width: 800, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, zoom: 3 },
            projection: { type: 'albers' },
            renderViews: [{ camera: createCamera() }]
        })).toThrow(/projection type/);
        expect(() => HostFrame.from({
            viewport: { width: 800, height: 600 },
            geographicAnchor: { longitude: -74, latitude: 40.7, zoom: 3 },
            projection: { type: 'globe' },
            renderViews: [{ camera: createCamera() }]
        })).toThrow(/visibleBounds/);
    });

    it.each([0, 3000])('preserves and inherits a shared elevation bound %s', maxElevation => {
        const bounds: [number, number, number, number] = [-120, -45, 20, 70];
        const frame = HostFrame.from({
            viewport: {width: 800, height: 600},
            geographicAnchor: {longitude: 0, latitude: 0, zoom: 3},
            projection: {type: 'globe', visibleBounds: bounds, maxElevation},
            renderViews: [
                {id: 'left', camera: createCamera(), projection: {type: 'globe', visibleBounds: bounds}},
                {id: 'right', camera: createCamera(), projection: {type: 'globe', visibleBounds: bounds, maxElevation: maxElevation + 1}}
            ]
        });
        expect(frame.projection).toMatchObject({maxElevation});
        expect(frame.getRenderView('left').projection).toMatchObject({maxElevation});
        expect(frame.getRenderView('right').projection).toMatchObject({maxElevation: maxElevation + 1});
        bounds[0] = 0;
        expect(frame.projection).toMatchObject({visibleBounds: [-120, -45, 20, 70]});
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid legacy-frame elevation %s', maxElevation => {
        expect(() => HostFrame.from({
            viewport: {width: 800, height: 600}, view: {longitude: 0, latitude: 0, zoom: 3},
            camera: createCamera(), projection: {type: 'globe', visibleBounds: [-180, -85, 180, 85], maxElevation}
        })).toThrow(/maxElevation/);
    });

    it('rejects an eye that lowers the declared scene height', () => {
        expect(() => HostFrame.from({
            viewport: {width: 800, height: 600},
            geographicAnchor: {longitude: 0, latitude: 0, zoom: 3},
            projection: {type: 'globe', visibleBounds: [-180, -85, 180, 85], maxElevation: 3000},
            renderViews: [{camera: createCamera(), projection: {type: 'globe', visibleBounds: [-180, -85, 180, 85], maxElevation: 0}}]
        })).toThrow(/cannot lower/);
    });
});
