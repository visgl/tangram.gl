// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type VBOMesh from '../gl/vbo_mesh';
import type {MeshOptions, MeshElementData} from '../gl/mesh-types';
import type {MeshLabel} from '../labels/main-pass-types';
import type {DrapedTerrainQueryMesh} from '../selection/draped-terrain-surface';
import type {StyleFeature, StyleParseTile, PropertyContext} from '../styles/property-types';
import type {LayerDrawGroup} from '../styles/layer-types';
import type {TileDataContext} from '../sources/tile_source_state';

/** Counters shared by worker replies and the main-thread tile debugger. */
export interface TileDebug extends Record<string, unknown> {
    /** Elapsed geometry construction time, or its start timestamp while building. */
    building?: number;
    /** Features visited by the geometry builder. */
    feature_count?: number;
    /** Drawn primitive count accumulated across mesh batches. */
    geometry_count?: number;
    /** Uploaded buffer bytes accumulated across mesh batches. */
    buffer_size?: number;
    /** Formatted primitive/feature ratio after the final batch. */
    geometry_ratio?: string;
    /** Optional introspection counters grouped by authored layer. */
    layers?: {list: Record<string, LayerDebugCounts>; tree: Record<string, LayerDebugCounts>} | null;
}

/** Hierarchical authored-layer counters without geometry or GPU ownership. */
export interface LayerDebugCounts {
    /** Feature contributions. */
    features: number;
    /** Geometry contributions. */
    geoms: number;
    /** Style names contributing to this layer. */
    styles: Record<string, number>;
    /** Whether this node is an authored base layer. */
    base: Record<string, number>;
    /** Child layer counters. */
    layers?: Record<string, LayerDebugCounts>;
}

/** Worker mesh attributes preserved during upload and temporal terrain replacement. */
export interface TileMeshVariant extends Record<string, unknown> {
    /** Authored style draw order, absent on non-style fixture or incomplete meshes. */
    blend_order?: number;
    /** Stable variant draw order, assigned on upload if absent. */
    mesh_order?: number;
    /** Captured height-blend duration for admitted geometry. */
    terrainTransitionDuration?: number;
    /** Worker-side terrain cost captured on this final mesh variant. */
    terrainStatistics?: import('../procedures/terrain-draping').TerrainMeshPreparation;
}

/** One transferred mesh variant; collision and ground query channels are optional. */
export interface TileMeshPayload {
    /** Completed interleaved vertex buffer. */
    vertex_data?: Uint8Array;
    /** Indexed or non-indexed draw topology. */
    vertex_elements?: MeshElementData;
    /** Per-variant shader values. */
    uniforms?: Record<string, unknown>;
    /** Captured immutable style/refinement policy. */
    variant: TileMeshVariant;
    /** Worker label identities and byte ranges. */
    labels?: Record<string, MeshLabel>;
    /** Exact ground query channels, when requested by the host. */
    terrain_surface?: DrapedTerrainQueryMesh;
}

/** Per-style worker output, including transferred texture references. */
export interface TileStylePayload extends MeshOptions {
    /** Variant names preserve deterministic worker draw order. */
    meshes: Record<string, TileMeshPayload>;
    /** Variant metadata supplied only to an individual uploaded mesh. */
    variant?: TileMeshVariant;
    /** Source detail passed to mesh refinement. */
    tileZoom?: number;
}

/** Worker-side build envelope; independent of the main-thread Tile class. */
export type DecodedTileFeature = Omit<StyleFeature, 'geometry'> & {geometry: StyleFeature['geometry'] | null};

/** Worker-side build envelope; independent of the main-thread Tile class. */
export interface WorkerBuildTile extends TileDataContext, StyleParseTile, Record<string, unknown> {
    /** Collision/task identity. */
    id: number | string;
    /** Normalized source/style key. */
    key: string;
    /** Authored source name, not a main-thread DataSource instance. */
    source: string;
    /** Mutable build counters. */
    debug: TileDebug;
    /** Normalized decoded feature collections. */
    source_data?: {layers?: Record<string, {features: DecodedTileFeature[]} | undefined>; request_id?: string | null; error?: string | null; url?: string};
    /** Transferred style payloads, absent after upload. */
    mesh_data?: Record<string, TileStylePayload>;
    /** Loading and generation state carried in replies. */
    loading?: boolean;
    loaded?: boolean;
    generation?: number | null;
    error?: string | null;
    /** Cancellation flag written before aborting pending source work. */
    canceled?: boolean;
}

/** Per-style lifecycle required by the geometry builder and GPU uploader. */
export interface TileBuildStyle {
    /** Style registry identity. */
    name: string;
    /** Collision work belongs to the deferred annotation batch. */
    collision?: boolean;
    /** External projection moves label collision to the host. */
    cpu_projection?: unknown;
    screen_space_labels?: boolean;
    /** Whether this tile owns unfinished geometry for the style. */
    hasDataForTile(tile: WorkerBuildTile): boolean;
    /** Normalize an authored draw group before feature evaluation. */
    preprocess(group: LayerDrawGroup): LayerDrawGroup | null;
    /** Append one normalized feature to this style's tile batch. */
    addFeature(feature: StyleFeature, group: LayerDrawGroup, context: PropertyContext): unknown;
    /** Complete worker geometry, including asynchronous collision and textures. */
    endData(tile: WorkerBuildTile): Promise<TileStylePayload | null | undefined>;
    /** Allocate a main-thread mesh owner from a completed worker variant. */
    makeMesh(vertices: Uint8Array, elements: MeshElementData, options: TileStylePayload): VBOMesh;
}

/** Incremental completion state shared by a tile's collision and non-collision batches. */
export interface TileBuildProgress {
    /** First worker batch resets main-thread geometry counters. */
    start?: boolean;
    /** All style batches completed. */
    done?: boolean;
    /** First build failure, serialized across worker boundaries. */
    error?: string;
}

/** Root scene layer capabilities used by geometry dispatch, not leaf-only tree nodes. */
export interface TileBuildLayer {
    /** Authored source selector, validated by the scene's layer parser. */
    config_data?: {source?: unknown; all_layers?: unknown; layer?: unknown} | null;
    /** Resolve all matching draw groups in their existing order. */
    buildDrawGroups(context: PropertyContext, build?: boolean): Record<string, LayerDrawGroup | null> | null | undefined;
}
