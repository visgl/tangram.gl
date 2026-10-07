// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import {beforeEach, describe, expect, it} from 'vitest';
import VertexLayout from '../src/gl/vertex_layout';
import VertexData from '../src/gl/vertex_data';
import gl from '../src/gl/constants';
import type {VertexAttribute} from '../src/gl/vertex-types';

describe('VertexData', () => {

    // Note: a_color is intentionally not a multiple of 4, to test padding
    let attribs: VertexAttribute[] =  [
        { name: 'a_position', size: 3, type: gl.FLOAT, normalized: false },
        { name: 'a_color', size: 3, type: gl.UNSIGNED_BYTE, normalized: true }, // should be padded to 4 bytes
        { name: 'a_layer', size: 1, type: gl.FLOAT, normalized: false }
    ];

    describe('.constructor(vertex_layout)', () => {
        let subject: VertexData;
        let layout: VertexLayout;

        beforeEach(() => {
            layout = new VertexLayout(attribs);
            subject = new VertexData(layout);
        });

        it('returns a new instance', () => {
            expect(subject).toBeInstanceOf(VertexData);
        });
        it('sets up buffer views', () => {
            expect(subject.views[gl.FLOAT]).toBeInstanceOf(Float32Array);
            expect(subject.views[gl.UNSIGNED_BYTE]).toBeInstanceOf(Uint8Array);
        });
    });

    describe('.addVertex(vertex)', () => {
        let subject: VertexData;
        let layout: VertexLayout;
        let vertex: number[] = [
            25, 50, 100,    // position
            255, 0, 0,      // color
            2               // layer
        ];

        beforeEach(() => {
            layout = new VertexLayout(attribs);
            subject = layout.createVertexData();
            subject.addVertex(vertex);
        });

        it('advances the buffer offset', () => {
            expect(subject.offset).toBe(layout.stride);
        });
        it('sets a vertex attribute value in the buffer', () => {
            expect(subject.views[gl.FLOAT][0]).toBe(vertex[0]);
            expect(subject.views[gl.FLOAT][1]).toBe(vertex[1]);
            expect(subject.views[gl.FLOAT][2]).toBe(vertex[2]);
        });
    });

});
