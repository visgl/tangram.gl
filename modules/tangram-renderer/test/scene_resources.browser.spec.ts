// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, describe, expect, test, vi} from 'vitest';
import JSZip from 'jszip';
import SceneLoader from '../src/scene/scene_loader';
import Utils from '../src/utils/utils';
import {getPropertyPath} from '../src/utils/props';
import type {SceneDefinition} from '../src/scene/scene-resource-types';

const BASE_URL = 'https://scenes.test/maps/';
const objectUrls: string[] = [];

afterEach(() => {
    vi.restoreAllMocks();
    for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
});

/** Serve deterministic YAML and archive fixtures, with native reads of ZIP blob URLs. */
function serveResources(resources: Record<string, string | ArrayBuffer | Error>) {
    const createObjectURL = URL.createObjectURL;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
        const url = createObjectURL(blob);
        objectUrls.push(url);
        return url;
    });
    return vi.spyOn(Utils, 'io').mockImplementation(async (url, _timeout, responseType) => {
        if (url.startsWith('blob:')) {
            const response = await fetch(url);
            return {body: responseType === 'arraybuffer' ? await response.arrayBuffer() : await response.text(), status: 200};
        }
        const body = resources[url];
        if (body instanceof Error) throw body;
        if (body === undefined) throw new Error(`Unexpected fixture request: ${url}`);
        return {body, status: 200};
    });
}

/** Load and hoist textures just as Scene does after applying global substitutions. */
async function loadResources(source: string | object, path?: string) {
    const result = await SceneLoader.loadScene(source, {path});
    SceneLoader.applyGlobalProperties(result.config);
    SceneLoader.hoistTextureNodes(result.config, result.bundle, result.texture_nodes);
    return result;
}

/** Inspect dynamic authored fields without pretending every scene has the same shape. */
function sceneValue(config: SceneDefinition, path: string): unknown {
    return getPropertyPath(config, path.split('.'));
}

/** Require the fixture's resolved URL before passing it to browser fetch. */
function sceneUrl(config: SceneDefinition, path: string): string {
    const value = sceneValue(config, path);
    expect(value, path).toBeTypeOf('string');
    if (typeof value !== 'string') throw new Error(`Missing fixture URL: ${path}`);
    return value;
}

describe('scene import resource ownership', () => {
    test('retains nested ZIP resources through YAML wrappers and child imports', async () => {
        const archive = new JSZip();
        archive.file('root.yaml', 'import: folder/child.yaml');
        archive.file('folder/child.yaml', `
sources:
  local: {type: GeoJSON, url: ../data/features.json}
fonts:
  local: {url: ../fonts/local.woff}
textures:
  named: {url: ../images/named.png}
styles:
  sample:
    texture: ../images/style.png
    material:
      diffuse: {texture: ../images/material.png}
    shaders:
      uniforms:
        image: ../images/uniform.png
layers:
  roads:
    draw:
      sample:
        texture: ../images/draw.png
        outline: {texture: ../images/outline.png}
`);
        const contents: Record<string, string> = {
            'data/features.json': '{"type":"FeatureCollection","features":[]}',
            'fonts/local.woff': 'font',
            'images/named.png': 'named',
            'images/style.png': 'style',
            'images/material.png': 'material',
            'images/uniform.png': 'uniform',
            'images/draw.png': 'draw',
            'images/outline.png': 'outline'
        };
        for (const [path, value] of Object.entries(contents)) archive.file(path, value);
        serveResources({
            [`${BASE_URL}root.yaml`]: 'import: styles/wrapper.yaml',
            [`${BASE_URL}styles/wrapper.yaml`]: 'import: bundle.zip',
            [`${BASE_URL}styles/bundle.zip`]: await archive.generateAsync({type: 'arraybuffer'})
        });
        const {config} = await loadResources(`${BASE_URL}root.yaml`);
        const urls = {
            'data/features.json': sceneUrl(config, 'sources.local.url'),
            'fonts/local.woff': sceneUrl(config, 'fonts.local.url'),
            'images/named.png': sceneUrl(config, 'textures.named.url'),
            'images/style.png': sceneUrl(config, 'styles.sample.texture'),
            'images/material.png': sceneUrl(config, 'styles.sample.material.diffuse.texture'),
            'images/uniform.png': sceneUrl(config, 'styles.sample.shaders.uniforms.image'),
            'images/draw.png': sceneUrl(config, 'layers.roads.draw.sample.texture'),
            'images/outline.png': sceneUrl(config, 'layers.roads.draw.sample.outline.texture')
        };
        for (const [path, url] of Object.entries(urls)) {
            expect(url, path).toMatch(/^blob:/);
            expect(await (await fetch(url)).text(), path).toBe(contents[path]);
        }
    });

    test('resolves external imports from an archive against their own network directory', async () => {
        const archive = new JSZip();
        archive.file('root.yaml', 'import: https://external.test/styles/child.yaml');
        serveResources({
            [`${BASE_URL}bundle.zip`]: await archive.generateAsync({type: 'arraybuffer'}),
            'https://external.test/styles/child.yaml': 'styles: {sample: {texture: images/icon.png}}'
        });
        const {config} = await loadResources(`${BASE_URL}bundle.zip`);
        expect(sceneValue(config, 'styles.sample.texture')).toBe('https://external.test/styles/images/icon.png');
    });

    test('inline scene imports inherit HTTP and archive bases without serializing functions', async () => {
        const color = () => 'red';
        const {config} = await loadResources({
            import: {styles: {sample: {texture: 'images/local.png'}},
                layers: {land: {draw: {polygons: {color}}}}}
        }, BASE_URL);
        expect(sceneValue(config, 'styles.sample.texture')).toBe(`${BASE_URL}images/local.png`);
        expect(sceneValue(config, 'layers.land.draw.polygons.color')).toBe(color);

        const archive = new JSZip();
        archive.file('root.yaml', 'import: folder/child.yaml');
        archive.file('folder/child.yaml', 'import: {styles: {sample: {texture: ../images/local.png}}}');
        archive.file('images/local.png', 'local image');
        serveResources({[`${BASE_URL}bundle.zip`]: await archive.generateAsync({type: 'arraybuffer'})});
        const archived = await loadResources(`${BASE_URL}bundle.zip`);
        expect(sceneValue(archived.config, 'styles.sample.texture')).toMatch(/^blob:/);
        expect(await (await fetch(sceneUrl(archived.config, 'styles.sample.texture'))).text()).toBe('local image');
    });

    test('keeps import precedence independent of completion order and preserves root overrides', async () => {
        const resources = serveResources({
            [`${BASE_URL}root.yaml`]: 'import: [early/style.yaml, late/style.yaml]',
            [`${BASE_URL}late/style.yaml`]: 'styles: {sample: {texture: late.png}, override: {texture: late.png}}'
        });
        const implementation = resources.getMockImplementation()!;
        let release!: () => void;
        const delayed = new Promise<void>(resolve => {release = resolve;});
        resources.mockImplementation(async (url, ...args) => {
            if (url === `${BASE_URL}early/style.yaml`) {
                await delayed;
                return {body: 'styles: {sample: {texture: early.png}, override: {texture: early.png}}', status: 200};
            }
            return implementation(url, ...args);
        });
        const loading = loadResources({
            import: [`${BASE_URL}early/style.yaml`, `${BASE_URL}late/style.yaml`],
            styles: {override: {texture: 'root.png'}}
        }, BASE_URL);
        await vi.waitFor(() => expect(resources).toHaveBeenCalledWith(`${BASE_URL}late/style.yaml`));
        release();
        const {config} = await loading;
        expect(sceneValue(config, 'styles.sample.texture')).toBe(`${BASE_URL}late/late.png`);
        expect(sceneValue(config, 'styles.override.texture')).toBe(`${BASE_URL}root.png`);
    });

    test('retains valid imports when a sibling fails and reports its own URL', async () => {
        serveResources({
            [`${BASE_URL}root.yaml`]: 'import: [missing.yaml, styles/good.yaml]',
            [`${BASE_URL}missing.yaml`]: new Error('Missing fixture'),
            [`${BASE_URL}styles/good.yaml`]: 'styles: {sample: {texture: icon.png}}'
        });
        const trigger = vi.spyOn(SceneLoader, 'trigger');
        const {config} = await loadResources(`${BASE_URL}root.yaml`);
        expect(sceneValue(config, 'styles.sample.texture')).toBe(`${BASE_URL}styles/icon.png`);
        expect(trigger).toHaveBeenCalledWith('error', expect.objectContaining({
            type: 'scene_import', url: `${BASE_URL}missing.yaml`
        }));
    });

    test('rejects a failed root rather than accepting an empty scene', async () => {
        serveResources({[`${BASE_URL}root.yaml`]: new Error('Root unavailable')});
        await expect(loadResources(`${BASE_URL}root.yaml`)).rejects.toThrow('Root unavailable');
    });

    test('reports missing ZIP members by their authored path without discarding valid siblings', async () => {
        const archive = new JSZip();
        archive.file('root.yaml', 'import: [folder/missing.yaml, folder/good.yaml]');
        archive.file('folder/good.yaml', 'styles: {sample: {texture: icon.png}}');
        archive.file('folder/icon.png', 'archive image');
        serveResources({[`${BASE_URL}bundle.zip`]: await archive.generateAsync({type: 'arraybuffer'})});
        const trigger = vi.spyOn(SceneLoader, 'trigger');
        const {config} = await loadResources(`${BASE_URL}bundle.zip`);
        expect(await (await fetch(sceneUrl(config, 'styles.sample.texture'))).text()).toBe('archive image');
        expect(trigger).toHaveBeenCalledWith('error', expect.objectContaining({
            type: 'scene_import', url: 'folder/missing.yaml',
            error: expect.objectContaining({message: 'Scene import not found: folder/missing.yaml'})
        }));
    });

    test('discards partial texture provenance from an import that fails normalization', async () => {
        serveResources({
            [`${BASE_URL}root.yaml`]: 'import: [good/style.yaml, broken/style.yaml]',
            [`${BASE_URL}good/style.yaml`]: 'styles: {sample: {texture: icon.png}}',
            [`${BASE_URL}broken/style.yaml`]: 'styles: {sample: {texture: broken.png}, invalid: null}'
        });
        const {config} = await loadResources(`${BASE_URL}root.yaml`);
        expect(sceneValue(config, 'styles.sample.texture')).toBe(`${BASE_URL}good/icon.png`);
        expect(sceneValue(config, 'styles.invalid')).toBeUndefined();
    });

    test('global substitutions use the root base and named texture overrides remain named', async () => {
        serveResources({[`${BASE_URL}styles/child.yaml`]: `
styles:
  global-image: {texture: global.image}
  named-image: {texture: named}
textures:
  named: {url: child.png}
`});
        const {config} = await loadResources({
            import: `${BASE_URL}styles/child.yaml`,
            global: {image: 'images/global.png'},
            textures: {named: {url: 'images/root.png'}}
        }, BASE_URL);
        expect(config.textures!['images/global.png'].url).toBe(`${BASE_URL}images/global.png`);
        expect(sceneValue(config, 'styles.named-image.texture')).toBe('named');
        expect(sceneValue(config, 'textures.named.url')).toBe(`${BASE_URL}images/root.png`);
    });

    test('reloads an object document at different bases without mutating arrays, URLs or functions', async () => {
        const color = () => 'red';
        const document = {
            import: [],
            sources: {local: {url: 'data.json', scripts: ['transform.js']}},
            fonts: {local: [{url: 'font.woff'}]},
            styles: {sample: {texture: 'icon.png'}},
            layers: {land: {draw: {polygons: {color}}}}
        };
        const original = {sources: document.sources, fonts: document.fonts, styles: document.styles};
        const first = await loadResources(document, BASE_URL);
        const second = await loadResources(document, 'https://other.test/');
        expect(sceneValue(first.config, 'sources.local.url')).toBe(`${BASE_URL}data.json`);
        expect(sceneValue(second.config, 'sources.local.url')).toBe('https://other.test/data.json');
        expect(sceneValue(second.config, 'styles.sample.texture')).toBe('https://other.test/icon.png');
        expect(document.sources.local.url).toBe('data.json');
        expect(document.sources.local.scripts).toEqual(['transform.js']);
        expect(document.fonts.local).toEqual([{url: 'font.woff'}]);
        expect(document.styles.sample.texture).toBe('icon.png');
        expect(document.import).toEqual([]);
        expect(document).toMatchObject(original);
        expect(sceneValue(second.config, 'layers.land.draw.polygons.color')).toBe(color);
    });

    test('copies class and null-prototype resource definitions before normalization', async () => {
        /** Resource records may come from application classes, not just YAML. */
        class ResourceDefinition {
            /** Relative URL supplied by the application. */
            constructor(public url: string) {}
        }
        const source = new ResourceDefinition('data.json');
        const texture = new ResourceDefinition('image.png');
        const font = Object.create(null);
        font.url = 'font.woff';
        const document = {sources: {local: source}, fonts: {local: font}, textures: {local: texture}};
        const first = await loadResources(document, BASE_URL);
        const second = await loadResources(document, 'https://other.test/');
        expect(source.url).toBe('data.json');
        expect(texture.url).toBe('image.png');
        expect(font.url).toBe('font.woff');
        expect(sceneValue(first.config, 'sources.local')).toEqual({url: `${BASE_URL}data.json`});
        expect(sceneValue(first.config, 'sources.local')).not.toBe(source);
        expect(Object.getPrototypeOf(sceneValue(first.config, 'fonts.local'))).toBeNull();
        expect(sceneValue(second.config, 'sources.local.url')).toBe('https://other.test/data.json');
        expect(sceneValue(second.config, 'textures.local.url')).toBe('https://other.test/image.png');
        expect(sceneValue(second.config, 'fonts.local.url')).toBe('https://other.test/font.woff');
    });

    test('snapshots private-backed accessors on original class instances without invoking setters', async () => {
        /** Application definitions may expose non-enumerable, inherited accessors. */
        class ResourceDefinition {
            /** URL state that cannot be copied by creating an empty class instance. */
            #url: string;
            /** Capture the application's relative resource URL. */
            constructor(url: string) {this.#url = url;}
            /** Read the original private state when materializing scene data. */
            get url() {return this.#url;}
            /** Normalization must not invoke this setter on the application object. */
            set url(_value: string) {throw new Error('Original URL must not be rewritten');}
        }
        /** Verify inherited accessors, not just accessors on the immediate prototype. */
        class SourceDefinition extends ResourceDefinition {
            /** Keep the public source format in the data snapshot. */
            type = 'GeoJSON';
        }
        const source = new SourceDefinition('data.json');
        const font = new ResourceDefinition('font.woff');
        const texture = new ResourceDefinition('image.png');
        const document = {sources: {local: source}, fonts: {local: [font]}, textures: {local: texture}};
        for (const base of [BASE_URL, 'https://other.test/']) {
            const {config} = await loadResources(document, base);
            expect(sceneValue(config, 'sources.local')).toEqual({url: `${base}data.json`, type: 'GeoJSON'});
            expect(sceneValue(config, 'fonts.local.0.url')).toBe(`${base}font.woff`);
            expect(sceneValue(config, 'textures.local.url')).toBe(`${base}image.png`);
        }
        expect(source.url).toBe('data.json');
        expect(font.url).toBe('font.woff');
        expect(texture.url).toBe('image.png');
    });
});
