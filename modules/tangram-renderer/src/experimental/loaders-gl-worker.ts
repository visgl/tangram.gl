// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {pmtilesTileProvider} from '../procedures/pmtiles-loader';
import {parseMltWithLoaders} from '../procedures/mlt-loaders';
import {parseMvtWithLoaders} from '../procedures/mvt-loaders';
import type {MvtDecoder} from '../procedures/mvt-parser';
import type {MvtTileProviderRegistration} from '../procedures/mvt-tile-provider';

type TangramWorker = typeof self & {
    registerMvtDecoder: (name: string, decoder: MvtDecoder) => void;
    registerMvtTileProvider: (name: string, provider: MvtTileProviderRegistration) => void;
};

const tangramWorker = self as TangramWorker;
tangramWorker.registerMvtDecoder('loaders-mvt', parseMvtWithLoaders);
tangramWorker.registerMvtDecoder('loaders-mlt', parseMltWithLoaders);
tangramWorker.registerMvtTileProvider('loaders-pmtiles', pmtilesTileProvider);
