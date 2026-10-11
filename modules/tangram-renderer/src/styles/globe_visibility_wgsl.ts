// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {globeHorizon} from '../shader-modules/globe-horizon';

/** Shared GLSL horizon math with Tangram's radius-256, geographic-altitude contract. */
export const GLOBE_VISIBILITY_GLSL = `${globeHorizon.vs}
bool tangramGlobeOccluded(vec3 position, float altitude, vec3 eye) {
    return globeHorizon_isOccluded(
        globeHorizon_getAnchor(position, altitude, 256., 6370972.), eye, 256.);
}
`;

/** Shared WGSL horizon math with the same common-space and altitude contract. */
export const GLOBE_VISIBILITY_WGSL = `
${globeHorizon.source}
fn tangramGlobeOccluded(position: vec3<f32>, altitude: f32, eye: vec3<f32>) -> bool {
    return globeHorizon_isOccluded(
        globeHorizon_getAnchor(position, altitude, 256.0, 6370972.0), eye, 256.0);
}
`;
