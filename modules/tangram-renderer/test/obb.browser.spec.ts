// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {describe, expect, it} from 'vitest';
import OBB from '../src/utils/obb.js';

describe('OBB', () => {

    it('computes normalized axes with math.gl vectors', () => {
        const angle = Math.PI / 4;
        const obb = new OBB(0, 0, angle, 2, 4);

        expect(obb.axis_0[0]).toBeCloseTo(Math.cos(angle));
        expect(obb.axis_0[1]).toBeCloseTo(Math.sin(angle));
        expect(obb.axis_1[0]).toBeCloseTo(-Math.sin(angle));
        expect(obb.axis_1[1]).toBeCloseTo(Math.cos(angle));
    });

    describe('.intersect(obb) (aligned)', () => {
    	let obb1 = new OBB(1.0, 1.0, 0.0, 2.0, 2.0);
    	let obb2 = new OBB(2.0, 2.0, 0.0, 1.0, 1.0);
    	let obb3 = new OBB(2.5, 2.5, 0.0, 0.4, 0.4);

        it('test collision between oriented bounding boxes', () => {
            expect(OBB.intersect(obb1, obb2)).toBe(true);
            expect(OBB.intersect(obb3, obb2)).toBe(true);
            expect(OBB.intersect(obb1, obb3)).toBe(false);
        });
    });

    describe('.intersect(obb) (non-aligned)', () => {
        let obb1 = new OBB(1.0, 1.0, Math.PI / 4.0, 1.0, 1.0);
        let obb2 = new OBB(0.0, 0.0, 0.0, 1.0, 1.0);
        let obb3 = new OBB(0.0, 1.0, Math.PI * 2.0, 1.0, 0.999);

        it('test collision between oriented bounding boxes', () => {
            expect(OBB.intersect(obb1, obb2)).toBe(false);
            expect(OBB.intersect(obb2, obb1)).toBe(false);
            expect(OBB.intersect(obb2, obb3)).toBe(false);
            expect(OBB.intersect(obb1, obb3)).toBe(true);
        });
    });

    describe('.intersect(obb) (non-aligned with negative positions)', () => {
        let obb1 = new OBB(-1.0, -1.0, Math.PI / 4.0, 1.0, 1.0);
        let obb2 = new OBB(0.0, 0.0, 0.0, 1.0, 1.0);
        let obb3 = new OBB(0.0, -1.0, -Math.PI * 2.0, 1.0, 0.999);
        let obb4 = new OBB(1.0, -1.0, Math.PI / 4.0, 1.0, 1.0);
        let obb5 = new OBB(1.0, -0.5, Math.PI / 8.0, 1.0, 1.0);

        it('test collision between oriented bounding boxes', () => {
            expect(OBB.intersect(obb1, obb2)).toBe(false);
            expect(OBB.intersect(obb2, obb1)).toBe(false);
            expect(OBB.intersect(obb2, obb3)).toBe(false);
            expect(OBB.intersect(obb1, obb4)).toBe(false);
            expect(OBB.intersect(obb2, obb4)).toBe(false);
            expect(OBB.intersect(obb1, obb3)).toBe(true);
            expect(OBB.intersect(obb5, obb4)).toBe(true);
        });
    });

});
