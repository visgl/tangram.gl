// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// Sets of values to match for directional and corner anchors
const lefts = ['left', 'top-left', 'bottom-left'];
const rights = ['right', 'top-right', 'bottom-right'];
const tops = ['top', 'top-left', 'top-right'];
const bottoms = ['bottom', 'bottom-left', 'bottom-right'];

type AnchorName = string | string[] | undefined;
type Point = [number, number];
type Buffer = [number, number, number, number];
interface PointAnchorNamespace {
    computeOffset(offset: Point, size: Point, anchor: AnchorName, buffer?: Buffer | null): Point;
    alignForAnchor(anchor: AnchorName): string;
    isLeftAnchor(anchor: AnchorName): boolean;
    isRightAnchor(anchor: AnchorName): boolean;
    isTopAnchor(anchor: AnchorName): boolean;
    isBottomAnchor(anchor: AnchorName): boolean;
    default_buffer: Buffer;
    zero_buffer: Buffer;
}
const PointAnchor = {

    computeOffset (offset: Point, size: Point, anchor: AnchorName, buffer: Buffer | null = null): Point {
        if (!anchor || anchor === 'center') {
            return offset;
        }

        const offset2: Point = [offset[0], offset[1]];
        buffer = buffer || this.default_buffer;

        // An optional left/right offset
        if (this.isLeftAnchor(anchor)) {
            offset2[0] -= size[0] / 2;
            if (anchor === 'left') {
                offset2[0] -= buffer[0];
            }
        }
        else if (this.isRightAnchor(anchor)) {
            offset2[0] += size[0] / 2;
            if (anchor === 'right') {
                offset2[0] += buffer[1];
            }
        }

        // An optional top/bottom offset
        if (this.isTopAnchor(anchor)) {
            offset2[1] -= size[1] / 2;
            if (anchor === 'top') {
                offset2[1] -= buffer[2];
            }
        }
        else if (this.isBottomAnchor(anchor)) {
            offset2[1] += size[1] / 2;
            if (anchor === 'bottom') {
                offset2[1] += buffer[3];
            }
        }

        return offset2;
    },

    alignForAnchor (anchor: AnchorName): string {
        if (anchor && anchor !== 'center') {
            if (this.isLeftAnchor(anchor)) {
                return 'right';
            }
            else if (this.isRightAnchor(anchor)) {
                return 'left';
            }
        }
        return 'center';
    },

    isLeftAnchor (anchor: AnchorName): boolean {
        return (lefts.indexOf(typeof anchor === 'string' ? anchor : '') > -1);
    },

    isRightAnchor (anchor: AnchorName): boolean {
        return (rights.indexOf(typeof anchor === 'string' ? anchor : '') > -1);
    },

    isTopAnchor (anchor: AnchorName): boolean {
        return (tops.indexOf(typeof anchor === 'string' ? anchor : '') > -1);
    },

    isBottomAnchor (anchor: AnchorName): boolean {
        return (bottoms.indexOf(typeof anchor === 'string' ? anchor : '') > -1);
    },

    // Buffers: [left, right, top, bottom]
    default_buffer: [2.5, 2.5, 1.5, 0.75],
    zero_buffer: [0, 0, 0, 0]

} as PointAnchorNamespace;

export default PointAnchor;
