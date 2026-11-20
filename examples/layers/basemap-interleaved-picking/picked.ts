// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {BasemapPickedFeature} from '@tangram.gl/basemap-layers';

/** The properties of a census tract in `manhattan-census-tracts.geojson`. */
export type TractProperties = {
  geoid: string;
  name: string;
  population: number;
  housingUnits: number;
  landAreaKm2: number;
  populationPerKm2: number;
};

export type TractFeature = {
  type: 'Feature';
  id: string;
  properties: TractProperties;
  geometry: {type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][]};
};

/** What the cursor is on: a feature of the basemap style, or a feature of the data layer. */
export type Picked =
  | {kind: 'basemap'; feature: BasemapPickedFeature}
  | {kind: 'data'; feature: TractFeature};

/** A key that is the same for each pick of one feature. Each pick makes a new `Picked` object. */
export function getPickedKey(picked: Picked | null): string {
  if (!picked) {
    return '';
  }
  if (picked.kind === 'data') {
    return `data/${picked.feature.id}`;
  }
  const {source, sourceLayer, id, styleLayerId} = picked.feature;
  return `basemap/${source}/${sourceLayer}/${id}/${styleLayerId}`;
}

/** Whether two picks are of the same feature. */
export function isSamePicked(a: Picked | null, b: Picked | null): boolean {
  return getPickedKey(a) === getPickedKey(b);
}
