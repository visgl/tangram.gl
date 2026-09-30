// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, it} from 'vitest';
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
});
