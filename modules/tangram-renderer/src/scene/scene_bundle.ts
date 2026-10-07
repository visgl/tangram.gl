// Tangram
// SPDX-License-Identifier: MIT
// Copyright (c) 2013-2016 Brett Camper and Mapzen
// Copyright (c) 2026 vis.gl contributors

import Utils from '../utils/utils';
import * as URLs from '../utils/urls';
import { isGlobalReference } from './globals';

import JSZip from 'jszip';
import {parseSceneYamlLegacy} from '../procedures/scene-yaml-legacy';
import type {SceneDefinition, SceneInput, SceneResourceDescriptor} from './scene-resource-types';

/** Extracted archive member and its lazily created browser URL. */
type SceneBundleFile = {data: ArrayBuffer; type: string | undefined; depth: number; url?: string};
type SceneBundleParent = SceneBundle | ZipSceneBundle | null;

/** Resolve resources relative to an authored scene, including nested archive imports. */
export class SceneBundle {

    /** Scene URL or reusable in-memory definition. */
    url: SceneInput;
    /** Resource directory for this scene. */
    path: string;
    /** Authored directory used to resolve within an ancestor archive. */
    path_for_parent: string;
    /** Importing scene, if present. */
    parent: SceneBundleParent;
    /** Archive ancestor responsible for relative resources. */
    container: SceneBundle | ZipSceneBundle | null;

    /** Create a resource resolver without loading or validating its scene. */
    constructor (url: SceneInput, path?: string | null, parent: SceneBundleParent = null) {
        this.url = url;

        // If a base path was provided, use it for resolving local bundle resources only if
        // the base path is absolute, or this bundle's path is relative
        if (path && (!URLs.isRelativeURL(path) || URLs.isRelativeURL(this.url))) {
            this.path = path;
        }
        else {
            this.path = URLs.pathForURL(this.url);
        }

        this.path_for_parent = path || this.path; // for resolving paths relative to a parent bundle
        this.parent = parent;

        // An ancestor bundle may be a container (e.g. zip file) that needs to resolve relative paths
        // for any scenes it contains, e.g. `root.zip` has a `root.yaml` that includes a `folder/child.yaml`:
        // resources within `child.yaml` must be resolved through the bundle for `root.zip`
        this.container = null;
        // Absolute imports leave the archive. Their own relative resources must
        // resolve on the network, not through the importing ZIP container.
        if (this.parent && URLs.isRelativeURL(this.path_for_parent)) {
            if (this.parent.container) {
                this.container = this.parent.container;
            }
            else if (this.parent.isContainer()) {
                this.container = this.parent;
            }
        }
    }

    /** Load and parse URL data, or snapshot reusable object scene data. */
    load (): Promise<SceneDefinition> {
        return loadResource(this.url);
    }

    // Info for retrieving a specific resource from this bundle
    // url: fully qualified URL to retrieve the content of the resource (e.g. zips will transform this to blob URL)
    // path: original path of the resource within the bundle (for resolving paths up the bundle tree)
    // type: file extension (used for determining bundle type, `yaml` or `zip`)
    /** Return the network/blob URL and authored directory/format for an import. */
    resourceFor (url: string): SceneResourceDescriptor {
        return {
            url: this.urlFor(url),
            path: this.pathFor(url),
            type: this.typeFor(url)
        };
    }

    /** Resolve a resource URL, retaining globals and omitted URLs. */
    urlFor (url: string | undefined): string | undefined {
        if (isGlobalReference(url)) {
            return url;
        }

        if (URLs.isRelativeURL(url) && this.container) {
            return this.parent!.urlFor(this.path_for_parent + url);
        }
        return URLs.addBaseURL(url, this.path);
    }

    /** Return the authored directory before archive resolution changes the URL. */
    pathFor (url: string): string {
        return URLs.pathForURL(url);
    }

    /** Infer the resource format from its authored extension. */
    typeFor (url: string): string | undefined {
        return URLs.extensionForURL(url);
    }

    /** Ordinary scene files do not own an archive of resources. */
    isContainer (): boolean {
        return false;
    }

}

/** ZIP scene with one root YAML member and lazy blob URLs for its resources. */
export class ZipSceneBundle extends SceneBundle {

    /** Archive parser, initialized only when loading starts. */
    zip: JSZip | null;
    /** Non-directory members indexed by authored archive path. */
    files: Record<string, SceneBundleFile>;
    /** Root YAML path selected after archive inspection. */
    root: string | null;

    /** Create an archive resolver; loading remains explicit. */
    constructor (url: SceneInput, path?: string | null, parent: SceneBundleParent = null) {
        super(url, path, parent);
        this.zip = null;
        this.files = {};
        this.root = null;
        this.path = '';
    }

    /** Archive scenes own their relative resources. */
    isContainer (): boolean {
        return true;
    }

    /** Extract an URL-backed archive, retaining the legacy object-input fallback. */
    async load (): Promise<SceneDefinition> {
        this.zip = new JSZip();

        if (typeof this.url === 'string') {
            const { body } = await Utils.io(this.url, 60000, 'arraybuffer');
            await this.zip.loadAsync(body as ArrayBuffer);
            await this.parseZipFiles();
            return this.loadRoot();
        } else {
            return this as unknown as SceneDefinition;
        }
    }

    /** Resolve relative resources within the archive, or delegate external URLs. */
    urlFor (url: string | undefined): string | undefined {
        if (isGlobalReference(url)) {
            return url;
        }

        if (URLs.isRelativeURL(url)) {
            return this.urlForZipFile(URLs.flattenRelativeURL(url!));
        }
        return super.urlFor(url);
    }

    /** Infer an archive member's format without opening its blob URL. */
    typeFor (url: string): string | undefined {
        if (URLs.isRelativeURL(url)) {
            return this.typeForZipFile(url);
        }
        return super.typeFor(url);
    }

    /** Load the unique root YAML file selected by findRoot. */
    loadRoot (): Promise<SceneDefinition> {
        this.findRoot();
        return loadResource(this.urlForZipFile(this.root as string));
    }

    /** Select the unique root YAML file, rejecting missing or ambiguous roots. */
    findRoot (): void {
        // There must be a single YAML file at the top level of the zip
        const yamls = Object.keys(this.files)
            .filter(path => this.files[path].depth === 0)
            .filter(path => URLs.extensionForURL(path) === 'yaml');

        if (yamls.length === 1) {
            this.root = yamls[0];
        }

        // No root found
        if (!this.root) {
            let msg = `Could not find root scene for bundle '${this.url}': `;
            msg += 'The zip archive\'s root level must contain a single scene file with the \'.yaml\' extension. ';
            if (yamls.length > 0) {
                msg += `Found multiple YAML files at the root level: ${yamls.map(r => '\'' + r + '\'' ).join(', ')}.`;
            }
            else {
                msg += 'Found NO YAML files at the root level.';
            }
            throw Error(msg);
        }
    }

    /** Extract non-directory members while retaining depth and format metadata. */
    async parseZipFiles (): Promise<void> {
        let paths: string[] = [];
        let queue: Promise<ArrayBuffer>[] = [];
        this.zip!.forEach((path, file) => {
            if (!file.dir) {
                paths.push(path);
                queue.push(file.async('arraybuffer'));
            }
        });

        const data = await Promise.all(queue);
        for (let i = 0; i < data.length; i++) {
            let path = paths[i];
            let depth = path.split('/').length - 1;
            this.files[path] = {
                data: data[i],
                type: URLs.extensionForURL(path),
                depth
            };
        }
    }

    /** Create or reuse a member's blob URL; missing members return undefined. */
    urlForZipFile (file: string): string | undefined {
        if (this.files[file]) {
            if (!this.files[file].url) {
                this.files[file].url = URLs.createObjectURL(new Blob([this.files[file].data])) as string;
            }

            return this.files[file].url;
        }
    }

    /** Return a member's format, or undefined when the member is absent. */
    typeForZipFile (file: string): string | undefined {
        return this.files[file] && this.files[file].type;
    }

}

/** Create a scene or zip bundle, inferring its path and parent when omitted. */
export function createSceneBundle (url: SceneInput, path?: string | null, parent: SceneBundleParent = null, type: string | null = null): SceneBundle | ZipSceneBundle {
    if ((type != null && type === 'zip') ||
        (typeof url === 'string' && !URLs.isLocalURL(url) && URLs.extensionForURL(url) === 'zip')) {
        return new ZipSceneBundle(url, path, parent);
    }
    return new SceneBundle(url, path, parent);
}

/** Interpret parser output as scene data; this boundary does not add schema validation. */
function parseResource (body: string): SceneDefinition {
    return parseSceneYamlLegacy(body) as SceneDefinition;
}

/** Load authored YAML or snapshot object definitions before mutating their resource paths. */
function loadResource (source: SceneInput | undefined): Promise<SceneDefinition> {
    return new Promise((resolve, reject) => {
        if (typeof source === 'string') {
            Utils.io(source).then(({ body }) => {
                try {
                    resolve(parseResource(body as string));
                }
                catch(e) {
                    reject(e);
                }
            }, reject);
        } else {
            // Normalization changes nested URLs and globals, not just the root.
            // Keep editor documents reusable across loads with different bases.
            resolve(cloneSceneValue(source) as SceneDefinition);
        }
    });
}

/** Snapshot enumerable scene data and URL accessors, leaving unrelated class internals alone. */
function cloneSceneValue(value: unknown, copies = new WeakMap<object, object>()): unknown {
    if (!value || (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]')) {
        return value;
    }
    const original = value as object; // Arrays and object-tag records passed the snapshot boundary above.
    if (copies.has(original)) return copies.get(original);

    // Class definitions become writable scene data. Keeping their prototype
    // would attach getters to an instance with no private fields. Read scene
    // accessors on the original without invoking its setters. URL getters are
    // supported even when non-enumerable; arbitrary non-enumerable accessors
    // are application internals, not scene data, and must not be evaluated.
    const copy: object = Array.isArray(value) ? new Array<unknown>(value.length) :
        Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
    copies.set(original, copy);
    const keys = new Set<string>();
    for (const key in original) keys.add(key);
    for (let owner = original; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(owner))) {
            if (descriptor.get && (descriptor.enumerable || key === 'url')) keys.add(key);
        }
    }
    for (const key of keys) {
        Object.defineProperty(copy, key, {
            value: cloneSceneValue((value as Record<string, unknown>)[key], copies), enumerable: true, writable: true, configurable: true
        });
    }
    return copy;
}
