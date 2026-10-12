// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {SceneDefinition} from '@vis.gl/tangram-renderer/core';

/** Lightweight OpenMapTiles styling; source parsing and displacement remain renderer-owned. */
export function createDrapedBasemap(): SceneDefinition {
    const ground = document.createElement('canvas');
    ground.width = ground.height = 1;
    const context = ground.getContext('2d');
    if (!context) throw new Error('Terrain ground texture requires a canvas context');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1, 1);
    return {
        scene: {background: {color: '#101d25'}, lighting: 'configured'},
        sources: {
            ground: {type: 'Raster', url: `${ground.toDataURL()}#/{z}/{x}/{y}`, max_zoom: 14},
            streets: {type: 'MVT', tilejson: 'https://tiles.openfreemap.org/planet', max_zoom: 14,
                attribution: '<a href="https://openfreemap.org">OpenFreeMap</a> <a href="https://www.openmaptiles.org/">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}
        },
        lights: {ambient: {type: 'ambient', ambient: 0.55}, sun: {type: 'directional', direction: [-1, -2, -3], diffuse: 0.75}},
        styles: {ground: {base: 'raster', lighting: 'fragment'}},
        layers: {
            ground: {data: {source: 'ground'}, draw: {ground: {order: 0, color: '#6a7960'}}},
            landcover: {data: {source: 'streets', layer: 'landcover'}, draw: {polygons: {order: 1, color: '#496445', z: 1}}},
            water: {data: {source: 'streets', layer: 'water'}, draw: {polygons: {order: 2, color: '#4e9ca8', z: 2}}},
            buildings: {data: {source: 'streets', layer: 'building'}, draw: {polygons: {order: 3, color: '#b4a48c', extrude: true, z: 2, interactive: true}}},
            roads: {data: {source: 'streets', layer: 'transportation'}, draw: {lines: {order: 4, color: '#eed4a1', width: '5px', z: 3}}},
            places: {data: {source: 'streets', layer: 'place'}, filter: {name: true}, draw: {text: {order: 5, z: 10, font: {family: 'sans-serif', size: '12px', fill: '#ffffff', stroke: {color: '#20382e', width: 2}}}}}
        }
    };
}
