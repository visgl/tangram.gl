// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Require a live manager in fixtures before exercising initialized view behavior. */
export function requireTileManager<Manager extends object>(scene: {tile_manager: Manager | null}): Manager {
    if (!scene.tile_manager) throw new Error('Test scene tile manager has been destroyed');
    return scene.tile_manager;
}
