// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import CoreScene from './scene';
import Camera from './camera';
import type {RendererOptions, SceneDefinition} from '../types';

/** Standalone Scene with classic camera construction; host renderers use CoreScene. */
export default class Scene extends CoreScene {
    /** Constructs a standalone scene without changing explicitly external camera mode. */
    constructor(config: SceneDefinition, options: RendererOptions = {}) {
        super(config, {...options, cameraFactory: Camera.create});
    }

    /** Creates a scene with Tangram's perspective, isometric, and flat cameras. */
    static create(config: SceneDefinition, options: RendererOptions = {}): Scene {
        return new Scene(config, options);
    }
}
