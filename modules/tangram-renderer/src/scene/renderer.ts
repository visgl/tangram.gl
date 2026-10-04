// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Scene from './scene';
import HostFrame from './host_frame';
import LumaDeviceRenderer from '../gpu/luma_device_renderer';
import type View from './view';
import type {RendererOptions, RenderOptions, SceneDefinition, SceneListeners, SceneLoadOptions, TileResourceStatistics} from '../types';
import type {TangramLightMapping} from '../lights/light-definitions';


interface FrameOptions {renderViewId?: string}

/** Minimal scene surface needed by the host-driven renderer. */
interface RendererScene {
    /** Shared source/style tile ownership across every eye. */
    tile_manager: {getResourceStatistics(): TileResourceStatistics};
    view: View;
    config: {animated?: boolean} | null;
    animated: boolean;
    dirty: boolean;
    start_time: number;
    host_animation_time: number | null;
    subscribe(listeners: SceneListeners): unknown;
    load(config: SceneDefinition | null, options: SceneLoadOptions): unknown;
    /** Retrieves current source and TileJSON provider credits for the host UI. */
    getAttributions(): Promise<string[]>;
    /** Returns detached lighting descriptors for the currently active eye. */
    getLumaLightDefinitions(): TangramLightMapping[];
    resizeMap(width: number, height: number): void;
    setCameraMatrices(camera: import('../types').HostCamera): void;
    updateScene(options: {renderPass?: import('@luma.gl/core').RenderPass | null}): boolean;
    processTasks(): void;
    requestRedraw(): void;
    destroy(): unknown;
}

/**
 * Embeddable Tangram renderer driven by a host-provided frame.
 *
 * Unlike the standalone Scene path, Renderer does not create an animation loop
 * or derive camera matrices. The host owns frame scheduling and supplies an
 * active render pass together with geographic view and camera state.
 */
export default class Renderer {

    gpuBackend: LumaDeviceRenderer | null;
    device_renderer: LumaDeviceRenderer | null;
    scene: RendererScene;
    host_frame: HostFrame | null;
    active_render_view_id: string | null;
    private animationFrame: unknown = null;
    private readonly submittedViews = new Set<string>();

    constructor(config: SceneDefinition, options: RendererOptions = {}) {
        this.gpuBackend = options.device ? new LumaDeviceRenderer(options.device) : null;
        // Retain the historical field while integrations migrate to gpuBackend.
        this.device_renderer = this.gpuBackend;
        const device_options = this.gpuBackend ? this.gpuBackend.getSceneOptions() : {};
        this.scene = Scene.create(config, Object.assign({}, options, device_options, {
            device: this.gpuBackend ? this.gpuBackend.device : options.device,
            disableRenderLoop: true,
            cameraMode: 'external'
        }));
        this.host_frame = null;
        this.active_render_view_id = null;
    }

    static create(config: SceneDefinition, options: RendererOptions = {}): Renderer {
        return new Renderer(config, options);
    }

    subscribe(listeners: SceneListeners): unknown {
        return this.scene.subscribe(listeners);
    }

    load(config: SceneDefinition | null = null, options: SceneLoadOptions = {}): unknown {
        return this.scene.load(config, options);
    }

    /** Returns source credits without coupling the renderer to DOM, deck.gl or Leaflet controls. */
    getAttributions(): Promise<string[]> {
        return this.scene.getAttributions();
    }

    /** Resolve Tangram lights into luma.gl definitions, retaining non-equivalent Tangram extensions. */
    getLumaLightDefinitions(): TangramLightMapping[] {
        return this.scene.getLumaLightDefinitions();
    }

    /** Current build queue and completed-cache mesh residency; does not include textures or driver memory. */
    getTileResourceStatistics(): TileResourceStatistics {
        return this.scene.tile_manager.getResourceStatistics();
    }

    /**
     * Applies host-owned viewport, geographic, and camera state.
     */
    setFrame(frame: unknown, {renderViewId}: FrameOptions = {}): HostFrame {
        const host_frame = HostFrame.from(frame);
        const render_view = host_frame.getRenderView(renderViewId);
        const viewport = render_view.viewport;
        const render_view_changed = this.active_render_view_id !== render_view.id;

        this.scene.view.applyHostFrame(host_frame, () => {
            if (this.scene.view.size.css.width !== viewport.width || this.scene.view.size.css.height !== viewport.height) {
                this.scene.resizeMap(viewport.width, viewport.height);
            }
        }, () => {
            this.scene.setCameraMatrices(render_view.camera);
            this.host_frame = host_frame;
            this.active_render_view_id = render_view.id;
        });
        if (host_frame !== this.animationFrame) {
            this.animationFrame = host_frame;
            this.submittedViews.clear();
            this.scene.host_animation_time = host_frame.animationTime ?? Math.max(0, (Date.now() - this.scene.start_time) / 1000);
        }
        if (render_view_changed) {
            this.scene.dirty = true;
        }
        return host_frame;
    }

    /**
     * Updates and draws Tangram into a host-owned render pass.
     */
    render({frame, renderPass = null, renderViewId, force = false}: Omit<RenderOptions, 'frame'> & {frame?: HostFrame | RenderOptions['frame']} = {}): boolean {
        if (frame) {
            this.setFrame(frame, { renderViewId });
        }
        else if (renderViewId) {
            if (!this.host_frame) {
                throw new Error('Renderer requires a HostFrame before selecting a render view');
            }
            this.setFrame(this.host_frame, { renderViewId });
        }
        if (force) {
            this.scene.dirty = true;
        }
        // Submitting an eye again starts the next logical frame, even when its previous draw was skipped.
        if (this.active_render_view_id && this.submittedViews.has(this.active_render_view_id)) {
            this.submittedViews.clear();
            if (this.host_frame) {
                this.scene.host_animation_time = this.host_frame.animationTime ?? Math.max(0, (Date.now() - this.scene.start_time) / 1000);
            }
        }
        const rendered = this.scene.updateScene({ renderPass });
        if (this.submittedViews.size === 0) {
            this.scene.processTasks();
        }
        if (this.active_render_view_id) {
            this.submittedViews.add(this.active_render_view_id);
        }
        if (rendered && this.scene.config && this.scene.animated) {
            this.scene.requestRedraw();
        }
        return rendered;
    }

    destroy() {
        try {
            return this.scene.destroy();
        }
        finally {
            if (this.gpuBackend) {
                this.gpuBackend.destroy();
            }
        }
    }

}
