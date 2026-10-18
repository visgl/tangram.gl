// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Device, RenderPass} from '@luma.gl/core';
import type {Scene} from '@vis.gl/tangram-renderer';
import type {Renderer, RendererOptions, SceneDefinition, SceneListeners, SceneLoadOptions, RenderOptions} from '@vis.gl/tangram-renderer/core';
import type {TangramLayerProps} from './tangram-layer';
import type {FirstPersonViewport} from './view_adapter_types';

/** Geographic viewport capabilities read by the existing view dispatch. */
export interface TangramLayerViewport extends FirstPersonViewport {
    /** Camera bearing in degrees. */
    bearing?: number;
    /** Class metadata used by deck.gl's existing experimental globe/first-person adapters. */
    constructor: Function & {displayName?: string};
    /** Optional globe eye and visible-boundary capabilities. */
    cameraPosition?: ArrayLike<number>;
    getBounds?: (options: {z: number}) => unknown;
}

/** Device state tracked only on the WebGL branch of the bridge. */
export interface TangramBridgeDevice extends Device {
    /** Optional WebGL state stack, validated before constructing a WebGL record. */
    pushState?: () => void;
    popState?: () => void;
}

/** Renderer scene capabilities needed by the bridge, without exposing scene implementation state. */
export interface TangramBridgeScene {
    /** Normalized animation policy, absent before loading. */
    config?: {scene?: {animated?: boolean}} | null;
    /** Main-thread context ownership used only for WebGL submission. */
    withWebGLContext?<Value>(operation: () => Value): Value;
}

/** Narrow injected renderer API; GPU resources and workers remain renderer-owned. */
export interface TangramBridgeRenderer extends Pick<Renderer,
    'setFrame' | 'setTerrain' | 'setTerrainExaggeration' | 'getFeatureAt' | 'getTerrainAt' |
    'getDrapedTerrainSurface' | 'getTerrainDrapingStatistics' | 'getAttributions' | 'destroy' | 'setProjectedBasemapProjection'> {
    /** Scene owned by this renderer instance. */
    scene: Scene;
    /** Scene event registration. */
    subscribe(listeners: SceneListeners): unknown;
    /** Asynchronous scene load; synchronous legacy returns remain supported. */
    load(scene: SceneDefinition, options: SceneLoadOptions): unknown;
    /** Submit one host frame through the caller's active render pass. */
    render(options: RenderOptions): boolean;
}

/** Factory injection preserves both the current and legacy renderer argument names. */
export interface TangramRendererFactory {
    /** Construct one independently owned renderer; missing factories still fail through the existing catch path. */
    create?: (scene: SceneDefinition, options: RendererOptions & {requestRedraw: () => void}) => TangramBridgeRenderer;
}

/** deck lifecycle capabilities inherited from the injected superclass. */
export interface TangramLayerOwner {
    /** Resolved deck properties, including callback defaults. */
    props: Partial<TangramLayerProps>;
    /** Notify deck that asynchronous scene work needs another frame. */
    setNeedsRedraw(): void;
    /** Forward existing error reporting to deck. */
    raiseError(error: Error, message: string): void;
    /** Existing error callback used by the opt-in projected subclass. */
    _reportSceneError(record: TangramRecord, error: Error, isFatal?: boolean): void;
}

/** Scene ownership shared by callbacks when deck replaces its layer instance. */
export interface TangramRecord {
    /** Latest layer instance holding the logical scene. */
    owner: TangramLayerOwner;
    /** Assigned renderer and scene, after successful factory construction. */
    renderer: TangramBridgeRenderer;
    scene: Scene;
    /** Device and optional native WebGL context. */
    device: TangramBridgeDevice;
    gl: (WebGLRenderingContext & {lumaState?: {program?: WebGLProgram | null}}) | null;
    /** Host canvas never replaced by Tangram. */
    deckCanvas: HTMLCanvasElement;
    /** Immutable constructor input identities. */
    sceneSource: SceneDefinition;
    sceneBasePath?: string | null;
    apiKey?: string | null;
    projectionEngine?: TangramLayerProps['projectionEngine'];
    projectionEngineExecution?: TangramLayerProps['projectionEngineExecution'];
    maxConcurrentTileLoadsPerWorker?: number;
    /** Current asynchronous terrain request and latest relief policy. */
    terrain?: TangramLayerProps['terrain'];
    /** Immutable borrowed admission-pool identity. */
    terrainResourceBudget?: TangramLayerProps['terrainResourceBudget'];
    terrainRevision?: number;
    terrainPendingRevision: number;
    /** Current canvas CSS size, assigned during view synchronization. */
    canvasWidth: number | null;
    canvasHeight: number | null;
    /** Disposal waits for an in-flight load, and releases the renderer once. */
    disposed: boolean;
    destroyed: boolean;
    loadSettled: boolean;
    loadFailed: boolean;
    loaded: boolean;
    loadPromise: Promise<unknown> | null;
    /** Deduplicated scene/viewport errors and attribution request generation. */
    lastSceneError: string | null;
    lastViewportError: string | null;
    reportedViewportError: string | null;
    attributionGeneration?: number;
    /** Latest opt-in projected mesh generation requested by the projected subclass. */
    projectedProjectionKey?: string | null;
    /** Reentrant WebGL state-scope depth. */
    webglScopeDepth: number;
}

/** Record initialization happens before the factory is called so redraw callbacks can close over it. */
export type PendingTangramRecord = Omit<TangramRecord, 'renderer' | 'scene'> & {
    renderer: TangramBridgeRenderer | null;
    scene: TangramBridgeScene | null;
};

/** Required host context capabilities, with no dependency on a concrete deck.gl subclass. */
export interface TangramLayerContext {
    /** Host device validated by the existing creation path. */
    device: TangramBridgeDevice;
    /** Current viewport plus the complete view inventory. */
    viewport: TangramLayerViewport;
    deck?: {getCanvas(): HTMLCanvasElement | null; getViewports?(): readonly TangramLayerViewport[]};
    /** Caller-owned pass; undefined keeps the existing renderer fallback. */
    renderPass?: RenderPass;
}
