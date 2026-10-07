// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {CreateProjectionOptions, ProjectionEngine, ProjectionInstance} from '@math.gl/projection/types';
import {normalizeProjectedBasemapOptions} from './mesh-projector';
import type {ProjectedBasemapOptions} from './mesh-projector';

/** Tangram's projected common-space units per projected meter. */
export const PROJECTED_COMMON_SCALE = 256 / 6378137;

/** Compile the same geographic-degree to north-positive meter contract on either thread. */
export function getProjectedCoordinateOptions(type: ProjectedBasemapOptions['type']): CreateProjectionOptions {
    normalizeProjectedBasemapOptions({type});
    const parameters = type === 'equal-earth' ? '+proj=eqearth +lon_0=0' :
        type === 'albers' ? '+proj=aea +lon_0=-96 +lat_0=37.5 +lat_1=29.5 +lat_2=45.5' :
            type === 'mercator' || type === 'web-mercator' ? '+proj=merc +lon_0=0 +k_0=1 +over' :
                '+proj=eqc +lon_0=0 +lat_0=0 +lat_ts=0';
    const geometry = type === 'mercator' ? '+ellps=WGS84' : '+R=6378137';
    return {from: `+proj=longlat ${geometry}`, to: `${parameters} ${geometry} +units=m`};
}

/** Reject transform instances and malformed factories before allocating renderer resources. */
export function validateProjectionEngine(engine: ProjectionEngine | undefined): void {
    if (engine !== undefined && (!engine || typeof engine.createProjection !== 'function' ||
        typeof engine.createProjectionAsync !== 'function')) {
        throw new Error('projectionEngine must implement the math.gl ProjectionEngine factory contract');
    }
}

/** Scene-owned transforms; the caller owns the engine and its registrations/grids. */
export class HostProjectionEngineAdapter {
    /** Independent asynchronous compilation per CRS pair, shared across meshes and workers. */
    private readonly transforms = new Map<ProjectedBasemapOptions['type'], Promise<ProjectionInstance>>();
    /** Prevent late worker batches from publishing after scene teardown. */
    private disposed = false;

    /** Retain, but never mutate or dispose, the supplied factory. */
    constructor(private readonly engine: ProjectionEngine) {
        validateProjectionEngine(engine);
    }

    /** Project one packed longitude/latitude batch to common coordinates without modifying input. */
    async projectPositions(coordinates: Float64Array, type: ProjectedBasemapOptions['type']): Promise<Float64Array> {
        if (this.disposed) throw new Error('Projection engine adapter is disposed');
        const options = getProjectedCoordinateOptions(type);
        if (!(coordinates instanceof Float64Array) || coordinates.length % 2 !== 0 ||
            !coordinates.every((value, index) => Number.isFinite(value) && Math.abs(value) <=
                (index % 2 === 0 ? 180 : 85.0511287798066))) {
            throw new Error('Projection engine requires packed finite geographic degrees within the tile domain');
        }
        let pending = this.transforms.get(type);
        if (!pending) {
            pending = Promise.resolve().then(() => this.engine.createProjectionAsync(options));
            this.transforms.set(type, pending);
            pending.catch(() => {if (this.transforms.get(type) === pending) this.transforms.delete(type);});
        }
        const transform = await pending;
        if (this.disposed) throw new Error('Projection engine adapter is disposed');
        const projected = coordinates.slice();
        transform.projectFlatSync(projected, 2);
        for (let index = 0; index < projected.length; index++) {
            projected[index] *= PROJECTED_COMMON_SCALE;
            if (!Number.isFinite(projected[index]) || Math.abs(projected[index]) > 3.4028234663852886e38) {
                throw new Error('Projection engine produced an invalid Float32 common position');
            }
        }
        return projected;
    }

    /** Release scene-owned transforms without taking ownership of the injected factory. */
    dispose(): void {
        this.disposed = true;
        this.transforms.clear();
    }
}
