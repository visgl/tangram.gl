// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import Pbf from 'pbf';
import {VectorTile, VectorTileFeature} from '@mapbox/vector-tile';
import Geo from '../utils/geo';
import {parseMvtJsonProperties} from './mvt-properties';

interface MvtOptions {
    parseJson?: boolean | readonly string[];
}

interface MvtPoint {
    x: number;
    y: number;
}

interface MvtFeature {
    id?: string | number;
    type: number;
    properties: Record<string, unknown>;
    loadGeometry(): MvtPoint[][];
}

interface MvtLayer {
    extent: number;
    length: number;
    feature(index: number): MvtFeature;
}

/** Mapbox Vector Tile object produced by the legacy vector-tile decoder. */
export interface MvtTile {
    layers: Record<string, MvtLayer>;
}

interface TangramGeometry {
    type: string;
    coordinates: [number, number] | [number, number][] | [number, number][][] | [number, number][][][];
}

interface TangramFeature {
    type: 'Feature';
    geometry: TangramGeometry | null;
    id?: string | number;
    properties: Record<string, unknown>;
}

export interface TangramFeatureCollection {
    type: 'FeatureCollection';
    features: TangramFeature[];
}

/** Parse MVT bytes using Tangram's established Mapbox vector-tile implementation. */
export function parseMvtWithLegacy(response: ArrayBuffer | ArrayLike<number>, options: MvtOptions = {}): Record<string, TangramFeatureCollection> {
    const tile = new VectorTile(new Pbf(new Uint8Array(response))) as unknown as MvtTile;
    return convertMvtTileWithLegacy(tile, options);
}

/** Convert a Mapbox VectorTile object to Tangram's layer-indexed GeoJSON shape. */
export function convertMvtTileWithLegacy(tile: MvtTile, options: MvtOptions = {}): Record<string, TangramFeatureCollection> {
    const layers: Record<string, TangramFeatureCollection> = {};
    for (const layerName in tile.layers) {
        const layer = tile.layers[layerName];
        const scale = Geo.tile_scale / layer.extent;
        const layerGeoJson: TangramFeatureCollection = {type: 'FeatureCollection', features: []};

        for (let featureIndex = 0; featureIndex < layer.length; featureIndex++) {
            const feature = layer.feature(featureIndex);
            const featureGeoJson: TangramFeature = {
                type: 'Feature', geometry: {type: '', coordinates: []}, id: feature.id, properties: feature.properties
            };
            parseMvtJsonProperties(featureGeoJson, options.parseJson);

            const coordinates: [number, number][][] = feature.loadGeometry().map(ring =>
                ring.map(point => [point.x * scale, point.y * scale])
            );
            let geometry = featureGeoJson.geometry;
            if (!geometry) {
                continue;
            }
            geometry.coordinates = coordinates;

            if (VectorTileFeature.types[feature.type] === 'Point') {
                if (coordinates.length === 1) {
                    geometry.type = 'Point';
                    geometry.coordinates = geometry.coordinates[0][0];
                }
                else {
                    geometry.type = 'MultiPoint';
                    geometry.coordinates = geometry.coordinates[0];
                }
            }
            else if (VectorTileFeature.types[feature.type] === 'LineString') {
                if (coordinates.length === 1) {
                    geometry.type = 'LineString';
                    geometry.coordinates = geometry.coordinates[0];
                }
                else {
                    geometry.type = 'MultiLineString';
                }
            }
            else if (VectorTileFeature.types[feature.type] === 'Polygon') {
                geometry = decodeMultiPolygon(geometry);
            }

            featureGeoJson.geometry = geometry;
            layerGeoJson.features.push(featureGeoJson);
        }
        layers[layerName] = layerGeoJson;
    }
    return layers;
}

/** Decode flattened MVT polygon rings into Polygon or MultiPolygon coordinates. */
export function decodeMultiPolygon(geometry: TangramGeometry): TangramGeometry | null {
    const polygons: [number, number][][][] = [];
    let polygon: [number, number][][] = [];
    let outerWinding: 'CW' | 'CCW' | null = null;
    const rings = geometry.coordinates as [number, number][][];
    for (const ring of rings) {
        const winding = Geo.ringWinding(ring);
        if (winding == null) {
            continue;
        }
        outerWinding = outerWinding || winding;
        if (winding === outerWinding && polygon.length > 0) {
            polygons.push(polygon);
            polygon = [];
        }
        polygon.push(ring);
    }
    if (polygon.length > 0) {
        polygons.push(polygon);
    }

    if (polygons.length === 1) {
        geometry.type = 'Polygon';
        geometry.coordinates = polygons[0];
    }
    else if (polygons.length > 1) {
        geometry.type = 'MultiPolygon';
        geometry.coordinates = polygons;
    }
    else {
        return null;
    }
    return geometry;
}
