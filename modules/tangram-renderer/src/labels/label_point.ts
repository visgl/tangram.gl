// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import Label from './label';
import type {CollisionBounds, CollisionLabel} from './collision-types';
import type {LabelLayout, LabelParent} from './label-types';
import PointAnchor from './point_anchor';
import OBB from '../utils/obb';
import StyleParser from '../styles/style_parser';

type LabelPointCoordinate = [number, number];
type LabelPointSize = [number, number];
type LabelPointLayout = LabelLayout;
const typedStyleParser = StyleParser as unknown as {zeroPair: readonly number[]};

export default class LabelPoint extends Label {

    position: LabelPointCoordinate;
    angle: number;
    parent: LabelParent | undefined;
    start_anchor_index: number;
    degenerate: boolean;
    throw_away: boolean;
    static PLACEMENT: Record<string, number>;

    constructor (position: LabelPointCoordinate, size: LabelPointSize, layout: LabelPointLayout, angle = 0) {
        super(size, layout);
        this.type = 'point';
        this.position = [position[0], position[1]];
        this.angle = angle;
        this.parent = this.layout.parent;
        this.update();

        this.start_anchor_index = 1;
        this.degenerate = !this.size[0] && !this.size[1] && !this.layout.buffer[0] && !this.layout.buffer[1];
        this.throw_away = false;
    }

    update() {
        super.update();
        this.computeOffset();
        this.updateBBoxes();
    }

    computeOffset () {
        this.offset = [this.layout.offset[0], this.layout.offset[1]];

        // Additional anchor/offset for point:
        if (this.parent) {
            let parent = this.parent;
            // point's own anchor, text anchor applied to point, additional point offset
            this.offset = PointAnchor.computeOffset(this.offset, parent.size, parent.anchor, PointAnchor.zero_buffer);
            this.offset = PointAnchor.computeOffset(this.offset, parent.size, this.anchor, PointAnchor.zero_buffer);
            if (parent.offset !== typedStyleParser.zeroPair) {        // point has an offset
                if (this.offset === typedStyleParser.zeroPair) {      // no text offset, use point's
                    this.offset = parent.offset;
                }
                else {                                           // text has offset, add point's
                    this.offset[0] += parent.offset[0];
                    this.offset[1] += parent.offset[1];
                }
            }
        }

        this.offset = PointAnchor.computeOffset(this.offset, this.size, this.anchor);
    }

    updateBBoxes (this: Pick<LabelPoint, 'size' | 'unit_scale' | 'position' | 'offset' | 'angle' | 'obb' | 'aabb' | 'breach' | 'may_repeat_across_tiles'> & {layout: Pick<LabelLayout, 'buffer' | 'italic'>} & Partial<Pick<LabelPoint, 'inTileBounds' | 'mayRepeatAcrossTiles'>>) {
        let width = (this.size[0] + this.layout.buffer[0] * 2) * this.unit_scale * Label.epsilon;
        let height = (this.size[1] + this.layout.buffer[1] * 2) * this.unit_scale * Label.epsilon;

        // fudge width value as text may overflow bounding box if it has italic, bold, etc style
        if (this.layout.italic) {
            width += 5 * this.unit_scale;
        }

        // make bounding boxes
        this.obb = new OBB(
            this.position[0] + (this.offset[0] * this.unit_scale),
            this.position[1] - (this.offset[1] * this.unit_scale),
            -this.angle, // angle is negative because tile system y axis is pointing down
            width,
            height
        );
        this.aabb = this.obb.getExtent();

        if (this.inTileBounds) {
            this.breach = !this.inTileBounds();
        }

        if (this.mayRepeatAcrossTiles) {
            this.may_repeat_across_tiles = this.mayRepeatAcrossTiles();
        }
    }

    discard (bboxes: CollisionBounds, exclude: CollisionLabel | null | 0 | '' = null) {
        if (this.degenerate) {
            return false;
        }

        if (super.discard(bboxes, exclude)) {
            // If more than one anchor specified, try them in order
            if (Array.isArray(this.layout.anchor)) {
                // Start on second anchor (first anchor was set on creation)
                for (let i=this.start_anchor_index; i < this.layout.anchor.length; i++) {
                    this.anchor = this.layout.anchor[i];
                    this.update();

                    if (!super.discard(bboxes, exclude)) {
                        return false;
                    }
                }
            }
            return true;
        }
        return false;
    }

}

// Placement strategies
LabelPoint.PLACEMENT = {
    VERTEX: 0,          // place labels at endpoints of line segments
    MIDPOINT: 1,        // place labels at midpoints of line segments
    SPACED: 2,          // place labels equally spaced along line
    CENTROID: 3         // place labels at center of polygons
};
