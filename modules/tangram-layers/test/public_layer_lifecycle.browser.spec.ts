// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {Layer} from '@deck.gl/core';
import {TangramLayer} from '../src/index';

test('the typed public layer preserves deck inheritance, metadata and disabled lifecycle forwarding', () => {
    const layer = new TangramLayer({id: 'public-layer', scene: {}});
    expect(layer).toBeInstanceOf(Layer);
    expect(TangramLayer.componentName).toBe('TangramLayer');
    layer.state = {};
    const create = vi.spyOn(layer, '_createTangramRecord').mockReturnValue(null);
    // A headless, uninitialized layer has no LayerContext or RenderPass yet.
    // Exercise the guarded lifecycle through JavaScript, without inventing a GPU fixture.
    Reflect.apply(layer.initializeState, layer, [undefined]);
    expect(layer.state.tangramRecord).toBeNull();
    Reflect.apply(layer.updateState, layer, [{props: layer.props}]);
    expect(create).toHaveBeenCalledExactlyOnceWith(layer.props);
    Reflect.apply(layer.draw, layer, [{}]);
    Reflect.apply(layer.finalizeState, layer, [undefined]);
    expect(layer.state.tangramRecord).toBeNull();
    expect(layer.getTerrainDrapingStatistics()).toBeUndefined();
});
