// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Device} from '@luma.gl/core';
import {WebMercatorViewport} from '@deck.gl/core';
import {vi} from 'vitest';
import type {TangramBridgeRenderer, TangramBridgeDevice, TangramLayerContext, TangramLayerOwner, TangramRecord} from '../../src/tangram-layer-lifecycle';

/** Complete bridge mock; individual tests override only the behavior under inspection. */
export function createRendererFixture<Overrides extends Partial<TangramBridgeRenderer>>(overrides: Overrides) {
    return {scene: {}, subscribe: vi.fn(), load: vi.fn(async () => undefined), render: vi.fn(() => true),
        destroy: vi.fn(), setFrame: vi.fn(), setTerrain: vi.fn(async () => undefined), setTerrainExaggeration: vi.fn(),
        setProjectedBasemapProjection: vi.fn(async () => undefined), getFeatureAt: vi.fn(), getTerrainAt: vi.fn(() => null),
        getDrapedTerrainSurface: vi.fn(() => null), getAttributions: vi.fn(async () => []),
        getTerrainDrapingStatistics: vi.fn(() => ({enabled: true, gridBytes: 0, meshes: 0, vertices: 0, triangles: 0,
            suppressedTriangles: 0, meshBytes: 0, maximumPreparationMs: 0, detailLimitedMeshes: 0, queryBytes: 0, stagedMeshBytes: 0})),
        ...overrides};
}

/** No native GPU allocation: only the capabilities read by the bridge are populated on the device prototype. */
export function createDeviceFixture(): TangramBridgeDevice {
    return Object.assign(Object.create(Device.prototype), {type: 'webgpu', createBuffer: vi.fn(), createShader: vi.fn(),
        createTexture: vi.fn(), createRenderPipeline: vi.fn(), createVertexArray: vi.fn()});
}

/** A complete context keeps focused fixtures from pretending partial records are full lifecycle owners. */
export function createContextFixture(overrides: Omit<Partial<TangramLayerContext>, 'deck'> & {deck?: Partial<NonNullable<TangramLayerContext['deck']>>} = {}): TangramLayerContext & {deck: NonNullable<TangramLayerContext['deck']>} {
    const canvas = document.createElement('canvas');
    const viewport = new WebMercatorViewport({width: 800, height: 400, longitude: 0, latitude: 0, zoom: 4});
    return {device: createDeviceFixture(), viewport, ...overrides,
        deck: {getCanvas: () => canvas, getViewports: () => [viewport], ...overrides.deck}};
}

/** Construct an admitted record with complete lifecycle defaults and a known current owner. */
export function createRecordFixture(owner: TangramLayerOwner, overrides: Partial<TangramRecord>): TangramRecord {
    return {owner, renderer: createRendererFixture({}), scene: {}, device: createDeviceFixture(), gl: null,
        deckCanvas: document.createElement('canvas'), sceneSource: {}, terrainPendingRevision: 0,
        canvasWidth: null, canvasHeight: null, disposed: false, destroyed: false, loadSettled: true,
        loadFailed: false, loaded: true, loadPromise: null, lastSceneError: null, lastViewportError: null,
        reportedViewportError: null, webglScopeDepth: 0, ...overrides};
}

/** Fail clearly when a test expecting successful initialization has no live record. */
export function getLiveRecord(layer: {state?: {tangramRecord?: TangramRecord | null}}): TangramRecord {
    const record = layer.state?.tangramRecord;
    if (!record) throw new Error('Expected a live Tangram renderer record');
    return record;
}
