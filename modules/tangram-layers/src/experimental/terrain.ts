// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {CompositeLayer, COORDINATE_SYSTEM, type LayerProps, type UpdateParameters, type Viewport} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {Matrix4} from '@math.gl/core';
import {TerrainMeshSurface, TerrainSurfaceCollection, sampleTerrainElevation, PROJECTION_CONSTANTS, type TerrainSurfaceHit, type TerrainCollectionHit} from '@tangram.gl/tangram-renderer/core';
import {prepareGlobeTerrainMesh, getPreparedGlobeTerrainTemplate, scaleGlobeTerrainMesh, getGlobeTerrainExaggeration, type GlobeTerrainMeshTemplate, type GlobeTerrainPreparationSnapshot, type TerrainHeightGrid} from '@tangram.gl/tangram-renderer/map-logic';
import {getTerrainRenderMesh, resolveGlobeTerrainDisplay, type GlobeTerrainDisplaySnapshot} from './terrain-display';

export {GlobeTerrainDisplayPreparation} from './terrain-display';
export type {GlobeTerrainDisplaySnapshot, GlobeTerrainDisplayStatistics} from './terrain-display';

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
    /** Most recent complete screen, elevation or segment query, including any lazy index construction. */
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
    /** Optional complete draw/query generation; its effective multiplier overrides automatic camera rescaling. */
    preparedDisplay?: GlobeTerrainDisplaySnapshot;
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
    declare state: {layers: SimpleMeshLayer[]; surfaces: TerrainMeshSurface[]; exaggeration: number; prepared?: PreparedGlobeTerrainTile[]; resolution?: number; memoryError?: string; updateMs?: number; queryMs?: number;
        /** One cached admitted-membership/radial-bound snapshot; owns no additional geometry buffers. */
        queryGeometry?: {
            /** Identity used to invalidate membership after publication. */
            surfaces: TerrainMeshSurface[];
            /** Shared nearest-hit/sightline router over the existing query owners. */
            collection: TerrainSurfaceCollection;
            /** Conservative radius enclosing every current triangle, in globe common units. */
            radius: number;
        }};

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
        const maxDisplayBytes = this.props.maxDisplayBytes ?? 128 * 1024 * 1024, maxQueryIndexBytes = this.props.maxQueryIndexBytes ?? 64 * 1024 * 1024;
        for (const limit of [maxDisplayBytes, maxQueryIndexBytes]) if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Globe terrain byte limits must be non-negative integers');
        if (this.props.modelMatrix || this.props.extensions.length) throw new Error('Globe terrain does not support vertex transforms or layer extensions');
        if (this.props.data.some(grid => grid.verticalDatum !== this.props.data[0].verticalDatum)) throw new Error('Globe terrain grids require one compatible vertical datum');
        if (new Set(this.props.data.map(grid => grid.bounds.join(','))).size !== this.props.data.length) throw new Error('Globe terrain grids must have distinct footprints');
        const snapshot = this.props.preparedTerrain;
        if (snapshot && (snapshot.resolution !== this.props.meshResolution || snapshot.grids.length !== this.props.data.length || snapshot.grids.some((grid, index) => grid !== this.props.data[index]))) throw new Error('Prepared globe terrain must match data and meshResolution');
        const requestedExaggeration = getGlobeTerrainExaggeration(getGlobeScreenRatio(this.context.viewport), this.props.globeTerrainExaggeration);
        const display = this.props.preparedDisplay;
        if (display) {
            const tiles = resolveGlobeTerrainDisplay(display), terrain = display.terrain;
            if (terrain.resolution !== this.props.meshResolution || terrain.grids.length !== this.props.data.length || terrain.grids.some((grid, index) => grid !== this.props.data[index]) || snapshot && snapshot !== terrain) throw new Error('Prepared globe display must match data, terrain and meshResolution');
            if (display.maxDisplayBytes !== maxDisplayBytes || display.maxQueryIndexBytes !== maxQueryIndexBytes) throw new Error('Prepared globe display budgets must match the layer');
            if (!changeFlags.propsOrDataChanged && this.state.exaggeration === display.exaggeration) return;
            const existingSurfaces = new Set(this.state.surfaces ?? []);
            const newBytes = tiles.reduce((sum, tile) => sum + (existingSurfaces.has(tile.surface) ? 0 : this.getDisplayBytes(tile.template)), 0);
            if (newBytes > 0 && this.getStatistics().displayBytes + newBytes > maxDisplayBytes) {this.setState({memoryError: 'Globe terrain display-byte limit exceeded; previous terrain retained', updateMs: performance.now() - started}); return;}
            const circumference = 2 * Math.PI * 6378137;
            const prepared = tiles.map(tile => ({...tile, neighbors: this.props.data.filter(candidate => candidate !== tile.grid && [-circumference, 0, circumference].some(shift => candidate.bounds[0] + shift <= tile.grid.bounds[2] && candidate.bounds[2] + shift >= tile.grid.bounds[0] && candidate.bounds[1] <= tile.grid.bounds[3] && candidate.bounds[3] >= tile.grid.bounds[1]))}));
            this.publishTiles(prepared, display.exaggeration, started);
            return;
        }
        const exaggeration = requestedExaggeration;
        if (!changeFlags.propsOrDataChanged && this.state.exaggeration === exaggeration) return;
        const circumference = 2 * Math.PI * 6378137;
        const previous = new Map(this.state.prepared?.map(tile => [tile.grid, tile]));
        const queryLimit = Math.floor(maxQueryIndexBytes / Math.max(1, this.props.data.length));
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
        if (displayedBytes > maxDisplayBytes || replacementBytes > 0 && retainedBytes + replacementBytes > maxDisplayBytes) {
            this.setState({memoryError: 'Globe terrain display-byte limit exceeded; previous terrain retained', updateMs: performance.now() - started});
            return;
        }
        const prepared = candidates.map(({grid, neighbors, template, retained}) => {
            if (retained) return retained;
            const mesh = scaleGlobeTerrainMesh(template, exaggeration);
            return {grid, neighbors, template, exaggeration, queryLimit, mesh: getTerrainRenderMesh(mesh),
                surface: new TerrainMeshSurface({projection: 'globe', positions: mesh.positions, indices: mesh.indices, physicalHeights: mesh.physicalHeights, cullBackfaces: true, maxQueryIndexBytes: queryLimit})};
        });
        this.publishTiles(prepared, exaggeration, started);
    }

    /** Publish one complete draw/query generation and measure layer assembly as well as geometry work. */
    private publishTiles(prepared: PreparedGlobeTerrainTile[], exaggeration: number, started: number): void {
        this.setState({exaggeration, memoryError: undefined, queryGeometry: undefined,
            prepared, resolution: this.props.meshResolution,
            surfaces: prepared.map(tile => tile.surface),
            layers: prepared.map(tile => new SimpleMeshLayer(this.getSubLayerProps({id: `mesh-${tile.grid.bounds.join(',')}`}), {
                data: terrainInstances, mesh: tile.mesh,
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT, _instanced: false, getPosition: [0, 0, 0], getColor: [255, 255, 255],
                // Colors already contain spherical relief lighting; do not transform them as planar ENU normals.
                material: false, wireframe: this.props.wireframe, pickable: false, parameters: {...this.props.parameters, cullMode: 'back'}
            })), updateMs: performance.now() - started});
    }

    /** Draw curved physical terrain, independently of the basemap's styling/tile lifecycle. */
    renderLayers(): SimpleMeshLayer[] {return this.state.layers ?? [];}

    /** Cache membership and a conservative radial bracket for the admitted generation, without copying geometry. */
    private getQueryGeometry(): {collection: TerrainSurfaceCollection; radius: number} {
        const surfaces = this.state?.surfaces ?? [], cached = this.state?.queryGeometry;
        if (cached?.surfaces === surfaces) return cached;
        const collection = new TerrainSurfaceCollection('globe', surfaces.map((surface, index) => ({id: String(index), surface})));
        const radius = Math.max(0, ...surfaces.map(surface => {
            const bounds = surface.getBounds();
            return bounds ? Math.hypot(...bounds.minimum.map((value, axis) => Math.max(Math.abs(value), Math.abs(bounds.maximum[axis])))) : 0;
        }));
        if (this.state) this.state.queryGeometry = {surfaces, collection, radius};
        return {collection, radius};
    }

    /** Probe the currently displayed top triangles radially, returning physical source elevation rather than relief. */
    sampleElevation(coordinate: readonly [number, number]): TerrainSurfaceHit | null {
        const started = performance.now();
        // Conservative XYZ bounds bracket every displaced triangle, even when relief exceeds ordinary DEM heights.
        const {collection, radius} = this.getQueryGeometry();
        const hit = sampleTerrainElevation(collection, coordinate, {
            minimumAltitude: -PROJECTION_CONSTANTS.earthRadius * (1 - Number.EPSILON),
            maximumAltitude: ((radius + 1) / PROJECTION_CONSTANTS.globeRadius - 1) * PROJECTION_CONSTANTS.earthRadius
        });
        if (this.state) this.state.queryMs = performance.now() - started;
        return hit;
    }

    /** Return the nearest loaded terrain blocker on a finite radius-256 common-space segment; null is not certified visibility. */
    intersectTerrainSegment(start: readonly [number, number, number], end: readonly [number, number, number], options?: {
        /** Origin self-intersection trim, in globe common units; defaults to zero. */
        startInset?: number;
        /** Target self-intersection trim, in globe common units; defaults to zero. */
        endInset?: number;
    }): TerrainCollectionHit | null {
        const started = performance.now(), hit = this.getQueryGeometry().collection.intersectSegment(start, end, options);
        if (this.state) this.state.queryMs = performance.now() - started;
        return hit;
    }

    /** Query displayed triangles but return barycentrically interpolated physical source meters. */
    pickTerrain(viewport: Viewport, pixel: readonly [number, number]): TerrainSurfaceHit | null {
        const started = performance.now();
        getGlobeScreenRatio(viewport);
        if (pixel.length !== 2 || !pixel.every(Number.isFinite)) throw new Error('Globe terrain pixels must be finite');
        const inverse = new Matrix4(viewport.viewProjectionMatrix).invert();
        const points = [-1, 1].map(z => inverse.transform([2 * (pixel[0] - viewport.x) / viewport.width - 1, 1 - 2 * (pixel[1] - viewport.y) / viewport.height, z, 1]));
        const origin: [number, number, number] = [points[0][0] / points[0][3], points[0][1] / points[0][3], points[0][2] / points[0][3]];
        const direction: [number, number, number] = [points[1][0] / points[1][3] - origin[0], points[1][1] / points[1][3] - origin[1], points[1][2] / points[1][3] - origin[2]];
        const nearest = this.getQueryGeometry().collection.intersectRay({origin, direction}, Math.hypot(...direction));
        if (this.state) this.state.queryMs = performance.now() - started;
        return nearest;
    }
}
