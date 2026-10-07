// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Tile-local coordinates; additional height components are retained by builders. */
export type GeometryCoordinate = number[];
/** One ordered polyline or closed polygon ring. */
export type GeometryLine = GeometryCoordinate[];
/** Polygon rings may carry area metadata assigned during source preprocessing. */
export type GeometryRing = GeometryLine & {area?: number};
/** Polygon exterior followed by holes in source winding order. */
export type GeometryPolygon = GeometryRing[];
/** Builder sink shared by real packed buffers and deterministic geometry fixtures. */
export interface GeometryVertexData {
    vertex_count: number;
    vertex_elements: {push(index: number): void};
    addVertex(vertex: number[]): void;
}
/** Resolved line geometry parameters, independent of authored property caches. */
export interface PolylineStyle {
    width: number;
    cap?: 'butt' | 'square' | 'round';
    join?: 'miter' | 'bevel' | 'round';
    miter_limit?: number;
    texcoord_width: number;
    offset: number;
}
/** Attribute component indices; portable untextured lines explicitly disable UV writes. */
export interface PolylineVertexIndices {
    a_extrude: number;
    a_offset?: number;
    a_texcoord?: number | null;
}
/** Per-build mutable state; deferred segments retain the same geometry sink. */
export interface PolylineBuildContext {
    closed_polygon: boolean | undefined;
    remove_tile_edges: boolean | undefined;
    tile_edge_tolerance: number;
    miter_len_sq: number | undefined;
    join_type: number;
    cap_type: number;
    vertex_data: GeometryVertexData;
    vertex_template: number[];
    half_width: number;
    extrude_index: number;
    offset_index: number | undefined;
    v_scale: number | undefined;
    texcoord_index: number | null | undefined;
    texcoord_width: number;
    offset: number;
    geom_count: number;
    extra_lines?: GeometryLine[];
}
