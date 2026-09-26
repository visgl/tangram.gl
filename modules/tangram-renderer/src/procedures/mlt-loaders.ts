// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {MLTLoader} from '@loaders.gl/mlt/bundled';
import Geo from '../utils/geo';
import {parseMvtJsonProperties, type ParseJsonOption} from './mvt-properties';

const LAYER_PROPERTY = '__tangram_layer';
type GeoJsonFeature = {
    type: 'Feature';
    geometry: {type: string; coordinates: unknown} | null;
    id?: string | number;
    properties: Record<string, unknown>;
};
type GeoJsonFeatureCollection = {type: 'FeatureCollection'; features: GeoJsonFeature[]};

/** Parse MLT bytes with loaders.gl and normalize the result for Tangram's MVT source. */
export function parseMltWithLoaders(
    response: ArrayBuffer | Uint8Array,
    options: {parseJson?: ParseJsonOption} = {}
): Record<string, GeoJsonFeatureCollection> {
    const tileBuffer: ArrayBuffer = response instanceof Uint8Array
        ? Uint8Array.from(response).buffer as ArrayBuffer
        : response;
    const parsed = MLTLoader.parseSync!(tileBuffer, {
        mlt: {shape: 'geojson-table', coordinates: 'local', layerProperty: LAYER_PROPERTY}
    }) as {features: GeoJsonFeature[]};

    const layers: Record<string, GeoJsonFeatureCollection> = {};
    for (const feature of parsed.features) {
        const layerName = String(feature.properties[LAYER_PROPERTY] || '');
        delete feature.properties[LAYER_PROPERTY];
        if (!layerName) {
            continue;
        }
        if (feature.geometry) {
            feature.geometry.coordinates = scaleCoordinates(feature.geometry.coordinates, Geo.tile_scale);
        }
        parseMvtJsonProperties(feature, options.parseJson);
        layers[layerName] ||= {type: 'FeatureCollection', features: []};
        layers[layerName].features.push(feature);
    }
    return layers;
}

function scaleCoordinates(coordinates: unknown, scale: number): unknown {
    if (!Array.isArray(coordinates)) {
        return coordinates;
    }
    if (coordinates.length >= 2 && coordinates.every(value => typeof value === 'number')) {
        return coordinates.map(value => (value as number) * scale);
    }
    return coordinates.map(value => scaleCoordinates(value, scale));
}
