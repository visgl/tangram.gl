// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {PMTilesSourceLoader} from '@loaders.gl/pmtiles';
import type {MvtTileIndex} from './mvt-tile-provider';

type PMTilesTileSource = ReturnType<typeof PMTilesSourceLoader.createDataSource>;

const pmtilesSources = new Map<string, PMTilesTileSource>();

/** Load raw MVT or MLT tile bytes from a PMTiles archive with loaders.gl. */
export function getPMTilesTile(url: string, tileIndex: MvtTileIndex): Promise<ArrayBuffer | null> {
    let source = pmtilesSources.get(url);
    if (!source) {
        source = PMTilesSourceLoader.createDataSource(url, {pmtiles: {shape: 'geojson-table'}});
        pmtilesSources.set(url, source);
    }
    return source.getTile(tileIndex);
}
