// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import log from '../utils/log';
import WorkerBroker from '../utils/worker_broker';
import debugSettings from '../utils/debug_settings';
import { debugSumLayerStats } from '../tile/tile';
import Texture from '../gl/texture';

// Debug config and functions
export default function setupSceneDebug (scene: any): void {
    scene.debug = {
        // Profile helpers, issues a profile on main thread & all workers
        profile(name: string): void {
            console.profile(`main thread: ${name}`); // eslint-disable-line no-console
            WorkerBroker.postMessage(scene.workers, 'self.profile', name);
        },

        profileEnd(name: string): void {
            console.profileEnd(`main thread: ${name}`); // eslint-disable-line no-console
            WorkerBroker.postMessage(scene.workers, 'self.profileEnd', name);
        },

        // Rebuild geometry a given # of times and print average, min, max timings
        timeRebuild (num = 1, options: any = {}): void {
            const times: number[] = [];
            const cycle = (): void => {
                let start = +new Date();
                scene.rebuild(options).then(() => {
                    times.push(+new Date() - start);

                    if (times.length < num) {
                        cycle();
                    }
                    else {
                        let avg = ~~(times.reduce((a, b) => a + b) / times.length);
                        log('info', `Profiled rebuild ${num} times: ${avg} avg (${Math.min(...times)} min, ${Math.max(...times)} max)`);
                    }
                });
            };
            cycle();
        },

        // Return geometry counts of visible tiles, grouped by style name
        geometryCountByStyle (): Record<string, number> {
            const counts: Record<string, number> = {};
            scene.tile_manager.getRenderableTiles().forEach((tile: any) => {
                for (let style in tile.meshes) {
                    counts[style] = counts[style] || 0;
                    tile.meshes[style].forEach((mesh: any) => {
                        counts[style] += mesh.geometry_count;
                    });
                }
            });
            return counts;
        },

        // Return geometry counts of visible tiles, grouped by base style name
        geometryCountByBaseStyle (): Record<string, number> {
            let style_counts = scene.debug.geometryCountByStyle();
            const counts: Record<string, number> = {};
            for (let style in style_counts) {
                let base = scene.styles[style].baseStyle();
                counts[base] = counts[base] || 0;
                counts[base] += style_counts[style];
            }
            return counts;
        },

        // Return sum of all geometry counts for visible tiles
        geometryCountTotal () {
            const styles = scene.debug.geometryCountByStyle();
            return Object.keys(styles).reduce((p, c) => styles[c] + p, 0);
        },

        // Return geometry GL buffer sizes for visible tiles, grouped by style name
        geometrySizeByStyle (): Record<string, number> {
            const sizes: Record<string, number> = {};
            scene.tile_manager.getRenderableTiles().forEach((tile: any) => {
                for (let style in tile.meshes) {
                    sizes[style] = sizes[style] || 0;
                    tile.meshes[style].forEach((mesh: any) => {
                        sizes[style] += mesh.buffer_size;
                    });
                }
            });
            return sizes;
        },

        // Return geometry GL buffer sizes for visible tiles, grouped by base style name
        geometrySizeByBaseStyle (): Record<string, number> {
            let style_sizes = scene.debug.geometrySizeByStyle();
            const sizes: Record<string, number> = {};
            for (let style in style_sizes) {
                let base = scene.styles[style].baseStyle();
                sizes[base] = sizes[base] || 0;
                sizes[base] += style_sizes[style];
            }
            return sizes;
        },

        // Return sum of all geometry GL buffer sizes for visible tiles
        geometrySizeTotal () {
            const styles = scene.debug.geometrySizeByStyle();
            return Object.keys(styles).reduce((p, c) => styles[c] + p, 0);
        },

        // Return sum of all texture memory usage
        textureSizeTotal() {
            return Object.values((Texture as any).textures).map((t: any) => t.byteSize()).reduce((p, c) => p + c);
        },

        layerStats (): Record<string, any> {
            if (debugSettings.layer_stats) {
                return debugSumLayerStats(scene.tile_manager.getRenderableTiles());
            }
            else {
                log('warn', 'Enable the \'layer_stats\' debug setting to collect layer stats');
                return {};
            }
        },

        renderableTilesCount (): number {
            return scene.tile_manager.getRenderableTiles().length;
        }
    };
}
