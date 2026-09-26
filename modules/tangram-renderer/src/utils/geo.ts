// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

// Miscellaneous geo functions

import {
    projectLngLatToMetersWithMath,
    unprojectMetersToLngLatWithMath
} from '../procedures/web-mercator-math';

export type Coordinate = number[];
export type Meters = {x: number; y: number};
export type Tile = {x: number; y: number; z: number};
export type Bounds = {sw: Meters; ne: Meters};
export type Geometry = {type: string; coordinates: unknown};
export type Transform = (coordinate: Coordinate) => void;

interface GeoNamespace {
    default_source_max_zoom: number;
    default_view_max_zoom: number;
    max_style_zoom: number;
    tile_size: number;
    half_circumference_meters: number;
    circumference_meters: number;
    min_zoom_meters_per_pixel: number;
    tile_scale: number;
    units_per_pixel: number;
    height_scale: number;
    metersPerPixel(z: number): number;
    metersPerTile(z: number): number;
    unitsPerMeter(z: number): number;
    metersForTile(tile: Tile): Meters;
    tileForMeters(coordinates: Coordinate, zoom: number): Tile;
    wrapTile(tile: Tile, mask?: {x: boolean; y: boolean}): Tile;
    metersToLatLng(coordinates: Coordinate): Coordinate;
    latLngToMeters(coordinates: Coordinate): Coordinate;
    tileSpaceToLatlng(geometry: Geometry, z: number, min: Meters): Geometry;
    copyGeometry(geometry: Geometry | null): Geometry | undefined;
    transformGeometry(geometry: Geometry | null, transform: Transform): void;
    boxIntersect(first: Bounds, second: Bounds): boolean;
    findBoundingBox(polygon: Coordinate[][]): [number, number, number, number];
    geometryType(type: string): 'point' | 'line' | 'polygon' | undefined;
    centroid(polygon: Coordinate[][], relative?: boolean): Coordinate | undefined;
    multiCentroid(polygons: Coordinate[][][]): Coordinate | null;
    signedPolygonRingAreaSum(ring: Coordinate[]): number;
    polygonRingArea(ring: Coordinate[]): number;
    polygonArea(polygon: Coordinate[][] | null): number | undefined;
    multiPolygonArea(polygons: Coordinate[][][]): number;
    ringWinding(ring: Coordinate[]): 'CW' | 'CCW' | undefined;
}

export const Geo = {} as GeoNamespace;
export default Geo;

// Projection constants
Geo.default_source_max_zoom = 18;
Geo.default_view_max_zoom = 20;
Geo.max_style_zoom = 25; // max zoom at which styles will be evaluated
Geo.tile_size = 256;
Geo.half_circumference_meters = 20037508.342789244;
Geo.circumference_meters = Geo.half_circumference_meters * 2;
Geo.min_zoom_meters_per_pixel = Geo.circumference_meters / Geo.tile_size; // min zoom draws world as 2 tiles wide

const meters_per_pixel: number[] = [];
Geo.metersPerPixel = function (z: number): number {
    meters_per_pixel[z] = meters_per_pixel[z] || Geo.min_zoom_meters_per_pixel / Math.pow(2, z);
    return meters_per_pixel[z];
};

const meters_per_tile: number[] = [];
Geo.metersPerTile = function (z: number): number {
    meters_per_tile[z] = meters_per_tile[z] || Geo.circumference_meters / Math.pow(2, z);
    return meters_per_tile[z];
};

// Conversion functions based on an defined tile scale
Geo.tile_scale = 4096; // coordinates are locally scaled to the range [0, tile_scale]
Geo.units_per_pixel = Geo.tile_scale / Geo.tile_size;
Geo.height_scale = 16;  // provides sub-meter precision for height values (16ths of a meters)

const units_per_meter: number[] = [];
Geo.unitsPerMeter = function (z: number): number {
    units_per_meter[z] = units_per_meter[z] || Geo.tile_scale / (Geo.tile_size * Geo.metersPerPixel(z));
    return units_per_meter[z];
};

// Convert tile location to mercator meters - multiply by pixels per tile, then by meters per pixel, adjust for map origin
Geo.metersForTile = function (tile: Tile): Meters {
    return {
        x: tile.x * Geo.circumference_meters / Math.pow(2, tile.z) - Geo.half_circumference_meters,
        y: -(tile.y * Geo.circumference_meters / Math.pow(2, tile.z) - Geo.half_circumference_meters)
    };
};

/**
   Given a point in mercator meters and a zoom level, return the tile X/Y/Z that the point lies in
*/
Geo.tileForMeters = function ([x, y]: Coordinate, zoom: number): Tile {
    return {
        x: Math.floor((x + Geo.half_circumference_meters) / (Geo.circumference_meters / Math.pow(2, zoom))),
        y: Math.floor((-y + Geo.half_circumference_meters) / (Geo.circumference_meters / Math.pow(2, zoom))),
        z: zoom
    };
};

// Wrap a tile to positive #s for zoom
// Optionally specify the axes to wrap
Geo.wrapTile = function({ x, y, z }: Tile, mask = { x: true, y: false }): Tile {
    var m = (1 << z) - 1;
    if (mask.x) {
        x = x & m;
    }
    if (mask.y) {
        y = y & m;
    }
    return { x, y, z };
};

/**
   Convert mercator meters to lat-lng, in-place
*/
Geo.metersToLatLng = function (c: Coordinate): Coordinate {
    const converted = unprojectMetersToLngLatWithMath([c[0], c[1]]);
    c[0] = converted[0];
    c[1] = converted[1];
    return c;
};

/**
  Convert lat-lng to mercator meters, in-place
*/
Geo.latLngToMeters = function (c: Coordinate): Coordinate {
    const converted = projectLngLatToMetersWithMath([c[0], c[1]]);
    c[0] = converted[0];
    c[1] = converted[1];
    return c;
};

// Transform from local tile coordinats to lat lng
Geo.tileSpaceToLatlng = function (geometry: Geometry, z: number, min: Meters): Geometry {
    const units_per_meter = Geo.unitsPerMeter(z);
    Geo.transformGeometry(geometry, (coord: Coordinate) => {
        coord[0] = (coord[0] / units_per_meter) + min.x;
        coord[1] = (coord[1] / units_per_meter) + min.y;
        Geo.metersToLatLng(coord);
    });
    return geometry;
};

// Copy GeoJSON geometry
Geo.copyGeometry = function (geometry: Geometry | null): Geometry | undefined {
    if (geometry == null) {
        return; // skip if missing geometry (valid GeoJSON)
    }

    const sourceCoordinates = geometry.coordinates as any;
    const copy: Geometry = { type: geometry.type, coordinates: undefined };

    if (geometry.type === 'Point') {
        copy.coordinates = [sourceCoordinates[0], sourceCoordinates[1]];
    }
    else if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') {
        copy.coordinates = sourceCoordinates.map((c: Coordinate) => [c[0], c[1]]);
    }
    else if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') {
        copy.coordinates = sourceCoordinates.map((ring: Coordinate[]) => ring.map(c => [c[0], c[1]]));
    }
    else if (geometry.type === 'MultiPolygon') {
        copy.coordinates = sourceCoordinates.map((polygon: Coordinate[][]) => {
            return polygon.map(ring => ring.map(c => [c[0], c[1]]));
        });
    }
    // TODO: support GeometryCollection
    return copy;
};

// Run an in-place transform function on each cooordinate in a GeoJSON geometry
Geo.transformGeometry = function (geometry: Geometry | null, transform: Transform): void {
    if (geometry == null) {
        return; // skip if missing geometry (valid GeoJSON)
    }

    if (geometry.type === 'Point') {
        transform(geometry.coordinates as Coordinate);
    }
    else if (geometry.type === 'LineString' || geometry.type === 'MultiPoint') {
        (geometry.coordinates as Coordinate[]).forEach(transform);
    }
    else if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') {
        (geometry.coordinates as Coordinate[][]).forEach(ring => ring.forEach(transform));
    }
    else if (geometry.type === 'MultiPolygon') {
        (geometry.coordinates as Coordinate[][][]).forEach(polygon => {
            polygon.forEach(ring => ring.forEach(transform));
        });
    }
    // TODO: support GeometryCollection
};

Geo.boxIntersect = function (b1: Bounds, b2: Bounds): boolean {
    return !(
        b2.sw.x > b1.ne.x ||
        b2.ne.x < b1.sw.x ||
        b2.sw.y > b1.ne.y ||
        b2.ne.y < b1.sw.y
    );
};

// Finds the axis-aligned bounding box for a polygon
Geo.findBoundingBox = function (polygon: Coordinate[][]): [number, number, number, number] {
    var min_x = Infinity,
        max_x = -Infinity,
        min_y = Infinity,
        max_y = -Infinity;

    // Only need to examine outer ring (polygon[0])
    var num_coords = polygon[0].length;
    for (var c=0; c < num_coords; c++) {
        var coord = polygon[0][c];

        if (coord[0] < min_x) {
            min_x = coord[0];
        }
        if (coord[1] < min_y) {
            min_y = coord[1];
        }
        if (coord[0] > max_x) {
            max_x = coord[0];
        }
        if (coord[1] > max_y) {
            max_y = coord[1];
        }
    }

    return [min_x, min_y, max_x, max_y];
};

// Convert geometry type to one of: 'point', 'line', 'polygon'
Geo.geometryType = function(type: string): 'point' | 'line' | 'polygon' | undefined {
    if (type === 'Polygon' || type === 'MultiPolygon') {
        return 'polygon';
    }
    else if (type === 'LineString' || type === 'MultiLineString') {
        return 'line';
    }
    if (type === 'Point' || type === 'MultiPoint') {
        return 'point';
    }
};

// Geometric / weighted centroid of polygon
// Adapted from https://github.com/Leaflet/Leaflet/blob/c10f405a112142b19785967ce0e142132a6095ad/src/layer/vector/Polygon.js#L57
Geo.centroid = function (polygon: Coordinate[][], relative = true): Coordinate | undefined {
    if (!polygon || polygon.length === 0) {
        return;
    }

    let x = 0, y = 0, area = 0;
    let ring = polygon[0]; // only use first ring for now
    let len = ring.length;

    // optionally calculate relative to first coordinate to avoid precision issues w/small polygons
    let origin: Coordinate | undefined;
    if (relative) {
        const originCoordinate = ring[0];
        origin = originCoordinate;
        ring = ring.map(v => [v[0] - originCoordinate[0], v[1] - originCoordinate[1]]);
    }

    for (let i = 0, j = len - 1; i < len; j = i, i++) {
        let p0 = ring[i];
        let p1 = ring[j];
        let f = p0[1] * p1[0] - p1[1] * p0[0];

        x += (p0[0] + p1[0]) * f;
        y += (p0[1] + p1[1]) * f;
        area += f * 3;
    }

    if (!area) {
        return; // skip degenerate polygons
    }

    const c: Coordinate = [x / area, y / area];
    if (relative) {
        c[0] += origin![0];
        c[1] += origin![1];
    }
    return c;
};

Geo.multiCentroid = function (polygons: Coordinate[][][]): Coordinate | null {
    let n = 0;
    let centroid: Coordinate | null = null;

    for (let p=0; p < polygons.length; p++) {
        let c = Geo.centroid(polygons[p]);
        if (c) { // skip degenerate polygons
            centroid = centroid || [0, 0];
            centroid[0] += c[0];
            centroid[1] += c[1];
            n++;
        }
    }

    if (n > 0) {
        centroid![0] /= n;
        centroid![1] /= n;
    }

    return centroid; // will return null if all polygons were degenerate
};

Geo.signedPolygonRingAreaSum = function (ring: Coordinate[]): number {
    let area = 0;
    let n = ring.length;

    for (let i = 0; i < n - 1; i++) {
        let p0 = ring[i];
        let p1 = ring[i+1];

        area += p0[0] * p1[1] - p1[0] * p0[1];
    }

    area += ring[n - 1][0] * ring[0][1] - ring[0][0] * ring[n - 1][1];
    return area;
};

Geo.polygonRingArea = function (ring: Coordinate[]): number {
    return Math.abs(Geo.signedPolygonRingAreaSum(ring)) / 2;
};

// TODO: subtract inner rings
Geo.polygonArea = function (polygon: Coordinate[][] | null): number | undefined {
    if (!polygon) {
        return;
    }
    return Geo.polygonRingArea(polygon[0]);
};

Geo.multiPolygonArea = function (polygons: Coordinate[][][]): number {
    let area = 0;

    for (let p=0; p < polygons.length; p++) {
        area += Geo.polygonArea(polygons[p]) || 0;
    }

    return area;
};

Geo.ringWinding = function (ring: Coordinate[]): 'CW' | 'CCW' | undefined {
    let area = Geo.signedPolygonRingAreaSum(ring);
    if (area > 0) {
        return 'CW';
    }
    else if (area < 0) {
        return 'CCW';
    }
    // return undefined on zero area polygon
};
