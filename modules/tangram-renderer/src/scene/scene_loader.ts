// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import log from '../utils/log';
import GLSL from '../gl/glsl';
import * as URLs from '../utils/urls';
import mergeObjects from '../utils/merge';
import subscribeMixin from '../utils/subscribe';
import { getPropertyPath, setPropertyPath } from '../utils/props';
import { flattenGlobalProperties, applyGlobalProperties, isGlobalSubstitution } from './globals';
import { createSceneBundle } from './scene_bundle';
import { isReserved } from '../styles/layer';
import {normalizeSceneLights} from '../lights/light-definitions';
import type {SubscriptionMethods} from '../utils/subscribe';
import type {SceneBundle} from './scene_bundle';
import type {
    SceneDefinition, SceneInput, SceneImportError, SceneLoadOptions, SceneLoadResult,
    SceneResourceDescriptor, SceneSourceDefinition, SceneTextureNodes, LoadedScene,
    SceneLayerDefinition, SceneMaterialChannel, SceneLoaderAPI, SceneStyleDefinition,
    FinalizedSceneDefinition, SceneNamedLights
} from './scene-resource-types';

const SceneLoader = subscribeMixin<Omit<SceneLoaderAPI, keyof SubscriptionMethods>>({

    // Load scenes definitions from URL & proprocess
    async loadScene(this: SceneLoaderAPI, url: SceneInput,
        { path, type, cameraMode }: SceneLoadOptions = {}): Promise<LoadedScene & {texture_nodes: SceneTextureNodes}> {
        const errors: SceneImportError[] = [];
        const texture_nodes: SceneTextureNodes = {};
        const scene = await this.loadSceneRecursive({ url, path, type }, null, texture_nodes, errors);
        const {config, bundle} = this.finalize(scene, { cameraMode });
        if (!config) {
            // root scene failed to load, reject with first error
            throw errors[0];
        }
        else if (errors.length > 0) {
            // scene loaded, but some imports had errors
            errors.forEach(error => {
                const message = `Failed to import scene: ${error.url}`;
                log('error', message, error);
                this.trigger('error', { type: 'scene_import', message, error, url: error.url });
            });
        }
        return { config, bundle, texture_nodes };
    },

    // Loads scene files from URL, recursively loading 'import' scenes
    // Optional *initial* path only (won't be passed to recursive 'import' calls)
    // Useful for loading resources in base scene file from a separate location
    // (e.g. in Tangram Play, when modified local scene should still refer to original resource URLs)
    async loadSceneRecursive({ url, path, type }: SceneResourceDescriptor, parent: SceneBundle | null,
        texture_nodes: SceneTextureNodes = {}, errors: SceneImportError[] = []): Promise<SceneLoadResult> {
        if (!url) {
            return {};
        }

        const bundle = createSceneBundle(url, path, parent, type);

        try {
            let config = await bundle.load();
            if (config.import == null) {
                this.normalize(config, bundle, texture_nodes);
                return { config, bundle };
            }

            // accept single entry or array
            if (!Array.isArray(config.import)) {
                config.import = [config.import]; // convert to array
            }

            // Collect URLs of scenes to import
            const imports: SceneResourceDescriptor[] = [];
            (config.import as SceneInput[]).forEach(url => {
                // Inline scene objects inherit this scene's resource directory.
                // Keep them as objects so functions survive and no blob URL
                // obscures their base (or leaks for each editor reload).
                if (typeof url === 'object') {
                    imports.push({url, path: bundle.container || bundle.isContainer() ? '' : bundle.path});
                }
                else {
                    const resource = bundle.resourceFor(url);
                    if (resource.url == null) {
                        const error: SceneImportError = new Error(`Scene import not found: ${url}`);
                        error.url = url; // Keep the authored archive path, not an undefined blob URL.
                        errors.push(error);
                    }
                    else {
                        imports.push(resource);
                    }
                }
            });
            delete config.import; // don't want to merge this property

            // load and normalize imports
            // Each subtree owns its texture provenance. Recursive loads already
            // normalize their local config; re-normalizing a merged import would
            // resolve descendant textures against the wrong bundle. Merge nodes
            // in authored order, never asynchronous completion order.
            const imported_nodes = imports.map((): SceneTextureNodes => ({}));
            const queue = imports.map((resource, index) =>
                this.loadSceneRecursive(resource, bundle, imported_nodes[index], errors));
            const scenes = await Promise.all(queue);
            const configs = scenes.filter(scene => scene.config).map(scene => scene.config);
            scenes.forEach((scene, index) => {
                if (scene.config) Object.assign(texture_nodes, imported_nodes[index]);
            });

            this.normalize(config, bundle, texture_nodes); // last normalize parent
            config = mergeObjects<SceneDefinition>({}, ...configs, config);
            return { config, bundle, texture_nodes };
        }
        catch (caught) {
            const error = caught as SceneImportError;
            // Collect scene load errors as we go
            error.url = url;
            errors.push(error);
            return {};
        }
    },

    // Normalize properties that should be adjust within each local scene file (usually by path)
    normalize(config: SceneDefinition, bundle: SceneBundle, texture_nodes: SceneTextureNodes = {}): LoadedScene {
        this.normalizeDataSources(config, bundle);
        this.normalizeFonts(config, bundle);
        this.normalizeTextures(config, bundle);
        this.collectTextures(config, bundle, texture_nodes);
        return { config, bundle, texture_nodes };
    },

    // Expand paths for data source
    normalizeDataSources(config: SceneDefinition, bundle: SceneBundle): SceneDefinition {
        config.sources = config.sources || {};

        for (const sn in config.sources) {
            this.normalizeDataSource(config.sources[sn], bundle);
        }

        return config;
    },

    normalizeDataSource(source: SceneSourceDefinition, bundle: SceneBundle): SceneSourceDefinition {
        source.url = bundle.urlFor(source.url);
        source.tilejson = bundle.urlFor(source.tilejson);

        // composite untiled raster sources
        if (Array.isArray(source.composite)) {
            source.composite.forEach(c => c.url = bundle.urlFor(c.url));
        }

        // custom scripts
        if (source.scripts) {
            // convert legacy array-style scripts to object format (script URL is used as both key and value)
            if (Array.isArray(source.scripts)) {
                source.scripts = source.scripts.reduce<Record<string, string | undefined>>((val, cur) => { val[cur] = cur; return val; }, {});
            }

            // resolve URLs for external scripts
            for (const s in source.scripts) {
                source.scripts[s] = bundle.urlFor(source.scripts[s]);
            }
        }

        return source;
    },

    // Expand paths for fonts
    normalizeFonts(config: SceneDefinition, bundle: SceneBundle): SceneDefinition {
        config.fonts = config.fonts || {};

        // Add scene base path for URL-based fonts (skip "external" fonts referencing CSS-loaded resources)
        const fonts = Object.values(config.fonts).filter(face => face !== 'external');
        for (const face of fonts) {
            const faces = (Array.isArray(face) ? face : [face]); // can be single value or array
            faces.forEach(face => face.url = bundle.urlFor(face.url));
        }

        return config;
    },

    // Expand paths and centralize texture definitions for a scene object
    normalizeTextures(config: SceneDefinition, bundle: SceneBundle): void {
        config.textures = config.textures || {};

        // Add current scene's base path to globally defined textures
        // Only adds path for textures with relative URLs, so textures in imported scenes get the base
        // path of their immediate scene file
        if (config.textures) {
            for (const tn in config.textures) {
                const texture = config.textures[tn];
                if (texture.url) {
                    texture.url = bundle.urlFor(texture.url);
                }
            }
        }
    },

    // Move inline (URL string) textures to the scene's top-level set of textures (config.textures).
    // There are 4 such cases of textures:
    // - in a style's `texture` property
    // - in a style's `material` properties
    // - in a style's custom uniforms (`shaders.uniforms`)
    // - in a draw groups `texture` property
    collectTextures(config: SceneDefinition, bundle: SceneBundle, texture_nodes: SceneTextureNodes): void {
        const textures = config.textures!; // normalizeTextures runs before collection.
        // Inline textures in styles
        if (config.styles) {
            for (const sn in config.styles) {
                const style: SceneStyleDefinition = config.styles[sn];

                // Style `texture`
                const tex = style.texture;
                if (typeof tex === 'string' && !textures[tex]) {
                    const path = ['styles', sn, 'texture'];
                    this.addTextureNode(path, bundle, texture_nodes);
                }

                // Material
                if (style.material) {
                    ['emission', 'ambient', 'diffuse', 'specular', 'normal'].forEach(prop => {
                        // Material property has a texture
                        const tex = style.material![prop] != null &&
                            (style.material![prop] as Exclude<SceneMaterialChannel, number | string | number[]>).texture;
                        if (typeof tex === 'string' && !textures[tex]) {
                            const path = ['styles', sn, 'material', prop, 'texture'];
                            this.addTextureNode(path, bundle, texture_nodes);
                        }
                    });
                }
            }
        }

        // Inline textures in shader uniforms
        if (config.styles) {
            for (const sn in config.styles) {
                const style = config.styles[sn];

                if (style.shaders && style.shaders.uniforms) {
                    GLSL.parseUniforms(style.shaders.uniforms).forEach(({ type, value, path }) => {
                        // Texture by URL (string-named texture not referencing existing texture definition)
                        if (type === 'sampler2D' && typeof value === 'string' && !textures[value]) {
                            const texture_path = ['styles', sn, 'shaders', 'uniforms', ...path];
                            this.addTextureNode(texture_path, bundle, texture_nodes);
                        }
                    });
                }
            }
        }

        // Inline textures in draw blocks
        if (config.layers) {
            const stack: unknown[] = [config.layers];
            const path_stack = [['layers']];
            while (stack.length > 0) {
                const layer = stack.pop();
                const layer_path = path_stack.pop()!;

                // only recurse into objects
                if (typeof layer !== 'object' || Array.isArray(layer)) {
                    continue;
                }

                const definition = layer as SceneLayerDefinition;
                for (const prop in definition) {
                    if (prop === 'draw') { // process draw groups for current layer
                        const draws = definition.draw!;
                        for (const group in draws) {
                            if (draws[group].texture) {
                                const tex = draws[group].texture;
                                if (typeof tex === 'string' && !textures[tex]) {
                                    const path = [...layer_path, prop, group, 'texture'];
                                    this.addTextureNode(path, bundle, texture_nodes);
                                }
                            }

                            // special handling for outlines :(
                            if (draws[group].outline && draws[group].outline.texture) {
                                const tex = draws[group].outline.texture;
                                if (typeof tex === 'string' && !textures[tex]) {
                                    const path = [...layer_path, prop, group, 'outline', 'texture'];
                                    this.addTextureNode(path, bundle, texture_nodes);
                                }
                            }
                        }

                    }
                    else if (isReserved(prop)) {
                        continue; // skip reserved keyword
                    }
                    else {
                        stack.push(definition[prop]); // traverse sublayer
                        path_stack.push([...layer_path, prop]);
                    }
                }
            }
        }
    },

    addTextureNode (path: (string | number)[], bundle: SceneBundle, texture_nodes: SceneTextureNodes): void {
        const pathKey = JSON.stringify(path);
        texture_nodes[pathKey] = {
            path,
            bundle
        };
    },

    // Hoist any remaining inline texture nodes that don't have a corresponding named texture
    // base_bundle is the bundle for the root scene, for resolving textures from global properties
    hoistTextureNodes (config: SceneDefinition, base_bundle: SceneBundle, texture_nodes: SceneTextureNodes = {}): void {
        const textures = config.textures!; // Normalized scene owns the texture registry.
        for(const { path, bundle } of Object.values(texture_nodes)) {
            const curValue = getPropertyPath(config, path);

            // Make sure current property values is a string to account for global property substitutions
            // e.g. shader uniforms are ambiguous, could be replaced with string value indicating texture,
            // but could also be a float, an array indicating vector, etc.
            if (typeof curValue === 'string' && textures[curValue] == null) {
                if (isGlobalSubstitution(config, path)) {
                    // global substituions are resolved against the base scene path, not the import they came from
                    const url = base_bundle.urlFor(curValue);
                    textures[curValue] = { url };
                }
                else {
                    // non-global textures are resolved against the import they came from
                    const url = bundle.urlFor(curValue);
                    textures[String(url)] = { url }; // Preserve legacy key coercion for a missing archive resource.
                    setPropertyPath(config, path, url);
                }
            }
        }
    },

    // Substitutes global scene properties (those defined in the `config.global` object) for any style values
    // of the form `global.`, for example `color: global.park_color` would be replaced with the value (if any)
    // defined for the `park_color` property in `config.global.park_color`.
    applyGlobalProperties(config: SceneDefinition): SceneDefinition {
        if (!config.global || Object.keys(config.global).length === 0) {
            return config; // no global properties to transform
        }

        const globals = flattenGlobalProperties(config.global); // flatten nested globals for simpler string look-ups
        return applyGlobalProperties(globals, config);
    },

    // Normalize some scene-wide settings that apply to the final, merged scene
    finalize: finalizeScene
});

/** Normalize a known scene while preserving the caller's resource resolver identity. */
function finalizeScene<Bundle>(scene: {config: SceneDefinition; bundle: Bundle}, options?: SceneLoadOptions):
    {config: FinalizedSceneDefinition; bundle: Bundle};
/** Preserve an empty result when the root or import subtree failed to load. */
function finalizeScene(scene: SceneLoadResult, options?: SceneLoadOptions): SceneLoadResult;
function finalizeScene({config, bundle}: {config?: SceneDefinition; bundle?: unknown},
    {cameraMode}: SceneLoadOptions = {}): {config?: SceneDefinition; bundle?: unknown} {
        if (!config) {
            return {};
        }

        // Ensure top-level properties
        config.global = config.global || {};
        config.scene = config.scene || {};
        // Internal worker policy: host cameras, not tile zoom, own billboard collision.
        config.scene._host_screen_space_labels = cameraMode === 'external';
        config.cameras = config.cameras || {};
        const native_lights = Array.isArray(config.lights);
        const lights = normalizeSceneLights(config.lights || {}) as SceneNamedLights;
        config.lights = lights;
        if (native_lights && Object.keys(lights).length === 0) {
            config.scene.lighting = 'configured'; // Explicit empty arrays still select the configurable WGSL path.
        }
        config.styles = config.styles || {};
        config.layers = config.layers || {};

        // Host-driven scenes do not need Tangram camera configuration. Keep
        // authored cameras intact, but do not synthesize a default camera.
        if (cameraMode !== 'external') {
            // If only one camera specified, set it as default
            if (config.camera) {
                config.cameras.default = config.camera;
            }

            // If no cameras specified, create one
            if (Object.keys(config.cameras).length === 0) {
                config.cameras.default = {};
            }
        }

        // If no lights specified, create default
        if (!native_lights && (Object.keys(lights).length === 0 ||
            Object.keys(lights).every(i => lights[i].visible === false))) {
            lights.default_light = {
                type: 'directional'
            };
        }

        return { config: config as FinalizedSceneDefinition, bundle };
}

export default SceneLoader;
