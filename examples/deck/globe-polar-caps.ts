// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {COORDINATE_SYSTEM} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';

const MERCATOR_LATITUDE_LIMIT = 85.0511287798066;

/** Untextured sea-level caps, not fabricated polar imagery, terrain or features. */
export function createGlobePolarCapMesh() {
  const positions: number[] = [];
  const indices: number[] = [];
  const longitudeSegments = 360;
  const latitudeSegments = 20;
  for (const hemisphere of [-1, 1]) {
    const start = positions.length / 3;
    for (let latitudeIndex = 0; latitudeIndex < latitudeSegments; latitudeIndex++) {
      // Slightly overlap the Mercator surface to avoid a floating-point hairline.
      const latitude = hemisphere * (MERCATOR_LATITUDE_LIMIT - 0.01 +
        (90 - MERCATOR_LATITUDE_LIMIT + 0.01) * latitudeIndex / latitudeSegments);
      for (let longitudeIndex = 0; longitudeIndex <= longitudeSegments; longitudeIndex++) {
        const longitude = -180 + longitudeIndex * 360 / longitudeSegments;
        positions.push(longitude, latitude, 0);
      }
    }
    // Triangulate the final small ring without a singular 90-degree vertex.
    // The spherical ring encloses the pole; chords cover its interior just as
    // they do elsewhere on a tessellated globe.
    const poleRing = start + (latitudeSegments - 1) * (longitudeSegments + 1);
    for (let longitudeIndex = 1; longitudeIndex < longitudeSegments - 1; longitudeIndex++) {
      if (hemisphere > 0) indices.push(poleRing, poleRing + longitudeIndex, poleRing + longitudeIndex + 1);
      else indices.push(poleRing, poleRing + longitudeIndex + 1, poleRing + longitudeIndex);
    }
    for (let latitudeIndex = 0; latitudeIndex < latitudeSegments - 1; latitudeIndex++) {
      for (let longitudeIndex = 0; longitudeIndex < longitudeSegments; longitudeIndex++) {
        const first = start + latitudeIndex * (longitudeSegments + 1) + longitudeIndex;
        const next = first + longitudeSegments + 1;
        if (hemisphere > 0) indices.push(first, first + 1, next, first + 1, next + 1, next);
        else indices.push(first, next, first + 1, first + 1, next, next + 1);
      }
    }
  }
  return {attributes: {POSITION: {size: 3, value: new Float32Array(positions)}},
    indices: {size: 1, value: new Uint16Array(indices)}};
}

const POLAR_CAP_MESH = createGlobePolarCapMesh();
// luma.gl 10 accepts explicit material props; the legacy boolean does not set unlit.
const UNLIT_MATERIAL = {unlit: true, ambient: 1, diffuse: 0};

/** Render only the missing globe surface through deck's geographic globe projection. */
export function createGlobePolarCaps(color: [number, number, number], visible: boolean) {
  return new SimpleMeshLayer({id: 'globe-polar-caps', data: [0], mesh: POLAR_CAP_MESH,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT, _instanced: false,
    getPosition: [0, 0, 0], getColor: color, material: UNLIT_MATERIAL, pickable: false, visible,
    parameters: {cullMode: 'back'}});
}
