// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {createProjectionEngine} from '@math.gl/projection/core';
import {equalEarth} from '@math.gl/projection/projections/eqearth';
import {albersEqualArea} from '@math.gl/projection/projections/aea';
import {equidistantCylindrical} from '@math.gl/projection/projections/eqc';
import {mercator} from '@math.gl/projection/projections/merc';

/** Register only the four algorithms needed by the example's five projection choices. */
export function createProjectedExampleProjectionEngine() {
  return createProjectionEngine({projections: [equalEarth, albersEqualArea, equidistantCylindrical, mercator]});
}
