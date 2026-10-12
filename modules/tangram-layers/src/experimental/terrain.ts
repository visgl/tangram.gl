// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {CompositeLayer, COORDINATE_SYSTEM, type LayerProps, type UpdateParameters, type Viewport} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {Matrix4} from '@math.gl/core';
import {TerrainMeshSurface, type TerrainSurfaceHit} from '@vis.gl/tangram-renderer/core';
import {prepareGlobeTerrainMesh, getPreparedGlobeTerrainTemplate, scaleGlobeTerrainMesh, getGlobeTerrainExaggeration, type GlobeTerrainMesh, type GlobeTerrainMeshTemplate, type GlobeTerrainPreparationSnapshot, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';

/** Stable mesh object lets deck.gl retain unchanged attribute buffers. */
function getTerrainRenderMesh(mesh: GlobeTerrainMesh) {
    return {attributes: {POSITION: {size: 3, value: mesh.geographicPositions}, COLOR_0: {size: 3, value: mesh.colors}}, indices: {size: 1, value: mesh.indices}};
}

/** One current immutable neighborhood and its most recent displayed/query geometry. */
interface PreparedGlobeTerrainTile {
    grid: TerrainHeightGrid;
    neighbors: readonly TerrainHeightGrid[];
    template: GlobeTerrainMeshTemplate;
    exaggeration: number;
    mesh: ReturnType<typeof getTerrainRenderMesh>;
    surface: TerrainMeshSurface;
    queryLimit: number;
}

/** Exact retained display/query arrays and CPU timings, not total process/GPU memory. */
export interface GlobeTerrainLayerStatistics {
    /** Actual admitted tiles, which can differ from requested data after a failed replacement. */
    tileCount: number;
    /** Actual admitted display multiplier; zero before initial admission. */
    exaggeration: number;
    /** Packed geographic/color/index buffers plus immutable query geometry and physical heights. */
    displayBytes: number;
    /** Current lazy query hierarchy bytes, bounded independently from display storage. */
    queryIndexBytes: number;
    /** Current display-generation admission failure; previous geometry remains visible and pickable. */
    error?: string;
    /** Most recent synchronous update, including validation, rescaling and query snapshots. */
    updateMs: number;
    /** Most recent complete picking call, including any lazy index construction. */
    queryMs: number;
}

/** Non-instanced mesh input stays stable across camera and display updates. */
const terrainInstances = [{}];

/** Globe-only physical DEM input, without a loader, network request or source ownership. */
export type GlobeTerrainLayerProps = LayerProps & {
    /** Immutable non-overlapping grids with balanced 2:1 edges in EPSG:3857 meters; no-data stays holes. */
    data: readonly TerrainHeightGrid[];
    /** Maximum display multiplier; defaults to 100, range [0, 1000]. Zero keeps the globe flat. */
    globeTerrainExaggeration?: number;
    /** Uniform curved cells per tile axis, range [2, 256]; defaults to 64. */
    meshResolution?: number;
    /** Optional cooperatively prepared complete generation, matching data identities/order and meshResolution. */
    preparedTerrain?: GlobeTerrainPreparationSnapshot;
    /** Current plus replacement display/query geometry typed-array cap; defaults to 128 MiB. */
    maxDisplayBytes?: number;
    /** Total current lazy query hierarchy typed-array cap; defaults to 64 MiB. */
    maxQueryIndexBytes?: number;
    /** Show triangle edges rather than shaded terrain. */
    wireframe?: boolean;
};

/** Apparent spherical diameter divided by the shorter viewport dimension. */
export function getGlobeScreenRatio(viewport: Viewport): number {
    if (viewport.projectionMode !== 2 || viewport.width <= 0 || viewport.height <= 0) throw new Error('Globe terrain requires GlobeView');
    const distance = Math.hypot(...viewport.cameraPosition);
    const denominator = Math.sqrt(Math.max(Number.EPSILON, distance * distance - 256 * 256));
    return Math.abs(viewport.projectionMatrix[5]) * 256 * viewport.height / (denominator * Math.min(viewport.width, viewport.height));
}

/** Experimental displaced globe terrain. The normal TangramLayer entry does not import this layer. */
export class GlobeTerrainLayer extends CompositeLayer<GlobeTerrainLayerProps> {
    /** Stable deck.gl diagnostic name. */
    static layerName = 'GlobeTerrainLayer';
    /** Validated display controls; terrain data never changes unit convention. */
    static defaultProps = {
        globeTerrainExaggeration: {type: 'number', value: 100, min: 0, max: 1000},
        meshResolution: {type: 'number', value: 64, min: 2, max: 256},
        wireframe: false,
        maxDisplayBytes: {type: 'number', value: 128 * 1024 * 1024, min: 0},
        maxQueryIndexBytes: {type: 'number', value: 64 * 1024 * 1024, min: 0}
    };
    /** Immutable display meshes and their lazy triangle-query snapshots. */
    declare state: {layers: SimpleMeshLayer[]; surfaces: TerrainMeshSurface[]; exaggeration: number; prepared?: PreparedGlobeTerrainTile[]; resolution?: number; memoryError?: string; updateMs?: number; queryMs?: number};

    /** Detached current storage/timing diagnostics; index bytes may grow only on an intersecting query. */
    getStatistics(): GlobeTerrainLayerStatistics {
        const tiles = this.state?.prepared ?? [];
        return {tileCount: tiles.length, exaggeration: this.state?.exaggeration ?? 0, displayBytes: tiles.reduce((sum, tile) => sum + this.getDisplayBytes(tile.template), 0), queryIndexBytes: tiles.reduce((sum, tile) => sum + tile.surface.getStatistics().queryIndexBytes, 0), error: this.state?.memoryError, updateMs: this.state?.updateMs ?? 0, queryMs: this.state?.queryMs ?? 0};
    }

    /** Geographic/color buffers, render topology and one owned query snapshot; no duplicate index geometry. */
    private getDisplayBytes(template: GlobeTerrainMeshTemplate): number {return template.vertexCount * 56 + template.triangleCount * 24;}

    /** Recompute display geometry when the camera changes scale, not on every animation tick. */
    shouldUpdateState({changeFlags}: UpdateParameters<this>): boolean {
        return Boolean(changeFlags.propsOrDataChanged || changeFlags.viewportChanged);
    }

    /** Keep each eye's display multiplier tied to the active viewport; grids remain physically unchanged. */
    updateState({changeFlags}: UpdateParameters<this>): void {
        const started = performance.now();
        for (const limit of [this.props.maxDisplayBytes, this.props.maxQueryIndexBytes]) if (!Number.isSafeInteger(limit) || limit! < 0) throw new Error('Globe terrain byte limits must be non-negative integers');
        if (this.props.modelMatrix || this.props.extensions.length) throw new Error('Globe terrain does not support vertex transforms or layer extensions');
        if (this.props.data.some(grid => grid.verticalDatum !== this.props.data[0].verticalDatum)) throw new Error('Globe terrain grids require one compatible vertical datum');
        if (new Set(this.props.data.map(grid => grid.bounds.join(','))).size !== this.props.data.length) throw new Error('Globe terrain grids must have distinct footprints');
        const snapshot = this.props.preparedTerrain;
        if (snapshot && (snapshot.resolution !== this.props.meshResolution || snapshot.grids.length !== this.props.data.length || snapshot.grids.some((grid, index) => grid !== this.props.data[index]))) throw new Error('Prepared globe terrain must match data and meshResolution');
        const exaggeration = getGlobeTerrainExaggeration(getGlobeScreenRatio(this.context.viewport), this.props.globeTerrainExaggeration);
        if (!changeFlags.propsOrDataChanged && this.state.exaggeration === exaggeration) return;
        const circumference = 2 * Math.PI * 6378137;
        const previous = new Map(this.state.prepared?.map(tile => [tile.grid, tile]));
        const queryLimit = Math.floor(this.props.maxQueryIndexBytes! / Math.max(1, this.props.data.length));
        const candidates = this.props.data.map(grid => {
            // Sampling and stitching only depend on touching footprints, including wrapped corners.
            const neighbors = this.props.data.filter(candidate => candidate !== grid && [-circumference, 0, circumference].some(shift =>
                candidate.bounds[0] + shift <= grid.bounds[2] && candidate.bounds[2] + shift >= grid.bounds[0] && candidate.bounds[1] <= grid.bounds[3] && candidate.bounds[3] >= grid.bounds[1]));
            const retained = previous.get(grid);
            const sameNeighborhood = retained && this.state.resolution === this.props.meshResolution && retained.neighbors.length === neighbors.length && retained.neighbors.every((neighbor, index) => neighbor === neighbors[index]);
            const template = snapshot ? getPreparedGlobeTerrainTemplate(snapshot, grid) : sameNeighborhood ? retained.template : prepareGlobeTerrainMesh(grid, {resolution: this.props.meshResolution, neighbors});
            // A changed tile count must not churn warm geometry when the complete hierarchy still fits.
            const requiredBytes = retained ? retained.surface.getStatistics().requiredQueryIndexBytes : 0;
            const sameQueryPolicy = retained && (requiredBytes <= retained.queryLimit) === (requiredBytes <= queryLimit);
            const reuse = sameNeighborhood && retained.template === template && retained.exaggeration === exaggeration && sameQueryPolicy;
            return {grid, neighbors, template, retained: reuse ? retained : undefined};
        });
        // Preflight the peak retained current + new geometry, counting reused tiles only once.
        const retainedBytes = this.getStatistics().displayBytes;
        const replacementBytes = candidates.reduce((sum, tile) => sum + (tile.retained ? 0 : this.getDisplayBytes(tile.template)), 0);
        const displayedBytes = candidates.reduce((sum, tile) => sum + this.getDisplayBytes(tile.template), 0);
        if (displayedBytes > this.props.maxDisplayBytes! || replacementBytes > 0 && retainedBytes + replacementBytes > this.props.maxDisplayBytes!) {
            this.setState({memoryError: 'Globe terrain display-byte limit exceeded; previous terrain retained', updateMs: performance.now() - started});
            return;
        }
        const prepared = candidates.map(({grid, neighbors, template, retained}) => {
            if (retained) return retained;
            const mesh = scaleGlobeTerrainMesh(template, exaggeration);
            return {grid, neighbors, template, exaggeration, queryLimit, mesh: getTerrainRenderMesh(mesh),
                surface: new TerrainMeshSurface({projection: 'globe', positions: mesh.positions, indices: mesh.indices, physicalHeights: mesh.physicalHeights, cullBackfaces: true, maxQueryIndexBytes: queryLimit})};
        });
        this.setState({exaggeration, memoryError: undefined, updateMs: performance.now() - started,
            prepared, resolution: this.props.meshResolution,
            surfaces: prepared.map(tile => tile.surface),
            layers: prepared.map(tile => new SimpleMeshLayer(this.getSubLayerProps({id: `mesh-${tile.grid.bounds.join(',')}`}), {
                data: terrainInstances, mesh: tile.mesh,
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT, _instanced: false, getPosition: [0, 0, 0], getColor: [255, 255, 255],
                // Colors already contain spherical relief lighting; do not transform them as planar ENU normals.
                material: false, wireframe: this.props.wireframe, pickable: false, parameters: {...this.props.parameters, cullMode: 'back'}
            }))});
    }

    /** Draw curved physical terrain, independently of the basemap's styling/tile lifecycle. */
    renderLayers(): SimpleMeshLayer[] {return this.state.layers ?? [];}

    /** Query displayed triangles but return barycentrically interpolated physical source meters. */
    pickTerrain(viewport: Viewport, pixel: readonly [number, number]): TerrainSurfaceHit | null {
        const started = performance.now();
        getGlobeScreenRatio(viewport);
        if (pixel.length !== 2 || !pixel.every(Number.isFinite)) throw new Error('Globe terrain pixels must be finite');
        const inverse = new Matrix4(viewport.viewProjectionMatrix).invert();
        const points = [-1, 1].map(z => inverse.transform([2 * (pixel[0] - viewport.x) / viewport.width - 1, 1 - 2 * (pixel[1] - viewport.y) / viewport.height, z, 1]));
        const origin: [number, number, number] = [points[0][0] / points[0][3], points[0][1] / points[0][3], points[0][2] / points[0][3]];
        const direction: [number, number, number] = [points[1][0] / points[1][3] - origin[0], points[1][1] / points[1][3] - origin[1], points[1][2] / points[1][3] - origin[2]];
        let nearest: TerrainSurfaceHit | null = null;
        for (const surface of this.state?.surfaces ?? []) {
            const hit = surface.intersectRay({origin, direction}, Math.hypot(...direction));
            if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
        }
        if (this.state) this.state.queryMs = performance.now() - started;
        return nearest;
    }
}
