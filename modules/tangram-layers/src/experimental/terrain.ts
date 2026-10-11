// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {CompositeLayer, COORDINATE_SYSTEM, type LayerProps, type UpdateParameters, type Viewport} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {Matrix4} from '@math.gl/core';
import {TerrainMeshSurface, type TerrainSurfaceHit} from '@vis.gl/tangram-renderer/core';
import {buildGlobeTerrainMesh, getGlobeTerrainExaggeration, type TerrainHeightGrid} from '@vis.gl/tangram-renderer/map-logic';

/** Globe-only physical DEM input, without a loader, network request or source ownership. */
export type GlobeTerrainLayerProps = LayerProps & {
    /** Immutable same-LOD grids in absolute EPSG:3857 meters; no-data cells remain holes. */
    data: readonly TerrainHeightGrid[];
    /** Maximum display multiplier; defaults to 100, range [0, 1000]. Zero keeps the globe flat. */
    globeTerrainExaggeration?: number;
    /** Uniform curved cells per tile axis, range [2, 256]; defaults to 64. */
    meshResolution?: number;
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
        wireframe: false
    };
    /** Immutable display meshes and their lazy triangle-query snapshots. */
    declare state: {layers: SimpleMeshLayer[]; surfaces: TerrainMeshSurface[]; exaggeration: number};

    /** Recompute display geometry when the camera changes scale, not on every animation tick. */
    shouldUpdateState({changeFlags}: UpdateParameters<this>): boolean {
        return Boolean(changeFlags.propsOrDataChanged || changeFlags.viewportChanged);
    }

    /** Keep each eye's display multiplier tied to the active viewport; grids remain physically unchanged. */
    updateState({changeFlags}: UpdateParameters<this>): void {
        if (this.props.modelMatrix || this.props.extensions.length) throw new Error('Globe terrain does not support vertex transforms or layer extensions');
        const exaggeration = getGlobeTerrainExaggeration(getGlobeScreenRatio(this.context.viewport), this.props.globeTerrainExaggeration);
        if (!changeFlags.propsOrDataChanged && this.state.exaggeration === exaggeration) return;
        const meshes = this.props.data.map(grid => buildGlobeTerrainMesh(grid, {exaggeration, resolution: this.props.meshResolution, neighbors: this.props.data.filter(candidate => candidate !== grid)}));
        this.setState({exaggeration,
            surfaces: meshes.map(mesh => new TerrainMeshSurface({projection: 'globe', positions: mesh.positions, indices: mesh.indices, physicalHeights: mesh.physicalHeights, cullBackfaces: true})),
            layers: meshes.map((mesh, index) => new SimpleMeshLayer(this.getSubLayerProps({id: `mesh-${index}`}), {
                data: [{}], mesh: {attributes: {POSITION: {size: 3, value: mesh.geographicPositions}, COLOR_0: {size: 3, value: mesh.colors}}, indices: {size: 1, value: mesh.indices}},
                coordinateSystem: COORDINATE_SYSTEM.LNGLAT, _instanced: false, getPosition: [0, 0, 0], getColor: [255, 255, 255],
                // Colors already contain spherical relief lighting; do not transform them as planar ENU normals.
                material: false, wireframe: this.props.wireframe, pickable: false, parameters: {...this.props.parameters, cullMode: 'back'}
            }))});
    }

    /** Draw curved physical terrain, independently of the basemap's styling/tile lifecycle. */
    renderLayers(): SimpleMeshLayer[] {return this.state.layers;}

    /** Query displayed triangles but return barycentrically interpolated physical source meters. */
    pickTerrain(viewport: Viewport, pixel: readonly [number, number]): TerrainSurfaceHit | null {
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
        return nearest;
    }
}
