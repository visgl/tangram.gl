// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type GLSL from '../gl/glsl';
import type {SceneBundle} from './scene_bundle';
import type {SubscriptionMethods} from '../utils/subscribe';

/** URL-backed or in-memory scene input, including class-backed editor definitions. */
export type SceneInput = string | object;

/** A URL-bearing resource; omitted URLs remain omitted during normalization. */
export interface SceneResourceDefinition extends Record<string, unknown> {
    /** Relative, absolute, blob, or global-reference URL. */
    url?: string;
}

/** Source fields whose paths are normalized by the scene loader. */
export interface SceneSourceDefinition extends SceneResourceDefinition {
    /** Optional TileJSON metadata URL. */
    tilejson?: string;
    /** Legacy raster composite resources. */
    composite?: SceneResourceDefinition[];
    /** Named external scripts, or the legacy list form. */
    scripts?: string[] | Record<string, string | undefined>;
}

/** A CSS-provided font, one URL face, or multiple URL faces. */
export type SceneFontDefinition = 'external' | SceneResourceDefinition | SceneResourceDefinition[];

/** Material channels may contain an inline texture URL or a named texture reference. */
export type SceneMaterialChannel = number | string | number[] | {texture?: string; [key: string]: unknown};

/** Style fields used by resource discovery, without restricting custom shader blocks. */
export interface SceneStyleDefinition extends Record<string, unknown> {
    /** Named texture or inline texture URL. */
    texture?: string;
    /** Material channels understood by Tangram's texture collector. */
    material?: Record<string, SceneMaterialChannel | null>;
    /** Custom shader configuration; other shader block fields are retained. */
    shaders?: {uniforms?: Parameters<typeof GLSL.parseUniforms>[0]; [key: string]: unknown};
}

/** Draw-group fields relevant to texture discovery. */
export interface SceneDrawDefinition extends Record<string, unknown> {
    /** Named texture or inline texture URL. */
    texture?: string;
    /** Optional outline texture. */
    outline?: SceneDrawDefinition;
}

/** Recursive layers combine sublayers with reserved metadata and draw groups. */
export interface SceneLayerDefinition {
    /** Style-named draw groups at this level. */
    draw?: Record<string, SceneDrawDefinition>;
    /** Sublayers and reserved fields are interpreted separately by the loader. */
    [key: string]: unknown;
}

/** Loader-owned fields of an authored scene; extensions stay explicitly unknown. */
export interface SceneDefinition extends Record<string, unknown> {
    /** One import or an authored-order list of imports. */
    import?: SceneInput | SceneInput[];
    /** Data sources normalized relative to their declaring bundle. */
    sources?: Record<string, SceneSourceDefinition>;
    /** Fonts normalized relative to their declaring bundle. */
    fonts?: Record<string, SceneFontDefinition>;
    /** Named textures normalized relative to their declaring bundle. */
    textures?: Record<string, SceneResourceDefinition>;
    /** Custom and built-in style definitions. */
    styles?: Record<string, SceneStyleDefinition>;
    /** Hierarchical drawing rules. */
    layers?: SceneLayerDefinition;
    /** Authored globals; their values may include functions and opaque objects. */
    global?: Record<string, unknown>;
    /** Scene-wide settings, including explicit lighting mode. */
    scene?: Record<string, unknown>;
    /** Classic camera definitions; host-driven scenes retain but do not synthesize them. */
    cameras?: Record<string, Record<string, unknown>>;
    /** Legacy singular classic camera definition. */
    camera?: Record<string, unknown>;
    /** Legacy named or native luma.gl light definitions, normalized separately. */
    lights?: SceneNamedLights | unknown[];
}

/** Light data stays unresolved until globals and the native-light adapter have run. */
export type SceneNamedLights = Record<string, {visible?: boolean | string; type?: string; [key: string]: unknown}>;

/** Settings guaranteed by scene-wide finalization, including empty native-light arrays. */
export interface FinalizedSceneDefinition extends SceneDefinition {
    /** Always present global registry. */
    global: Record<string, unknown>;
    /** Always present scene-wide settings. */
    scene: Record<string, unknown>;
    /** Always present camera registry, possibly empty for host cameras. */
    cameras: Record<string, Record<string, unknown>>;
    /** Native arrays have become named wrappers; conversion remains deferred. */
    lights: SceneNamedLights;
    /** Always present style registry. */
    styles: Record<string, SceneStyleDefinition>;
    /** Always present layer hierarchy. */
    layers: SceneLayerDefinition;
}

/** Input descriptor passed between recursive scene loads. */
export interface SceneResourceDescriptor {
    /** Resource to load; missing archive members have no URL. */
    url?: SceneInput;
    /** Original resource directory, before archive URLs become blob URLs. */
    path?: string | null;
    /** Explicit or inferred bundle format. */
    type?: string | null;
}

/** Texture provenance tracked before global substitution and hoisting. */
export type SceneTextureNodes = Record<string, {path: (string | number)[]; bundle: SceneBundle}>;

/** Successful load with normalized local resources and authored texture provenance. */
export interface LoadedScene {
    /** Merged scene data. */
    config: SceneDefinition;
    /** Root resource resolver. */
    bundle: SceneBundle;
    /** Original declaring bundle for every inline texture property. */
    texture_nodes?: SceneTextureNodes;
}

/** A rejected subtree contributes no config, bundle, or texture provenance. */
export type SceneLoadResult = LoadedScene | {config?: never; bundle?: never; texture_nodes?: never};

/** Scene import failure with its authored URL or object attached. */
export type SceneImportError = Error & {url?: SceneInput};

/** Options shared by root loading and final camera normalization. */
export interface SceneLoadOptions {
    /** Override the root resource directory, such as for an edited scene. */
    path?: string | null;
    /** Explicit root bundle format. */
    type?: string | null;
    /** Leave camera ownership to Tangram or its host. */
    cameraMode?: 'scene' | 'external';
}

/** Typed loader operations shared by scene startup, editor reloads, and resource tests. */
export interface SceneLoaderAPI extends SubscriptionMethods {
    /** Load a root scene, report failed imports, and return successful merged data. */
    loadScene(url: SceneInput, options?: SceneLoadOptions): Promise<LoadedScene & {texture_nodes: SceneTextureNodes}>;
    /** Load an import subtree without rejecting valid sibling imports. */
    loadSceneRecursive(resource: SceneResourceDescriptor, parent: SceneBundle | null,
        nodes?: SceneTextureNodes, errors?: SceneImportError[]): Promise<SceneLoadResult>;
    /** Normalize one declaring scene before merging it with other scenes. */
    normalize(config: SceneDefinition, bundle: SceneBundle, nodes?: SceneTextureNodes): LoadedScene;
    /** Resolve source resource paths. */
    normalizeDataSources(config: SceneDefinition, bundle: SceneBundle): SceneDefinition;
    /** Resolve one source's data, metadata, composite, and script paths. */
    normalizeDataSource(source: SceneSourceDefinition, bundle: SceneBundle): SceneSourceDefinition;
    /** Resolve URL font faces, preserving CSS-provided fonts. */
    normalizeFonts(config: SceneDefinition, bundle: SceneBundle): SceneDefinition;
    /** Resolve named texture definitions. */
    normalizeTextures(config: SceneDefinition, bundle: SceneBundle): void;
    /** Collect inline texture provenance after named textures have been normalized. */
    collectTextures(config: SceneDefinition, bundle: SceneBundle, nodes: SceneTextureNodes): void;
    /** Record the declaring bundle for a nested texture property. */
    addTextureNode(path: (string | number)[], bundle: SceneBundle, nodes: SceneTextureNodes): void;
    /** Hoist inline texture URLs after global substitution; named textures must exist. */
    hoistTextureNodes(config: SceneDefinition, bundle: SceneBundle, nodes?: SceneTextureNodes): void;
    /** Substitute authored globals in merged scene data. */
    applyGlobalProperties(config: SceneDefinition): SceneDefinition;
    /** Apply scene-wide defaults without synthesizing host-owned cameras. */
    finalize<Bundle>(scene: {config: SceneDefinition; bundle: Bundle}, options?: SceneLoadOptions):
        {config: FinalizedSceneDefinition; bundle: Bundle};
    /** Failed subtrees have no finalizable scene data. */
    finalize(scene: SceneLoadResult, options?: SceneLoadOptions): SceneLoadResult;
}
