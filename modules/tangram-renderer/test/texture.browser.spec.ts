// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import Texture, {type TextureInfo, type TextureOptions, type TextureResource} from '../src/gl/texture';
import Context from '../src/gl/context';
import type {TangramTextureOptions} from '../src/gpu/tangram_gpu_backend';
import WorkerBroker from '../src/utils/worker_broker';

/** A portable resource needs disposal, never a raw WebGL handle. */
function createResource(): TextureResource & {destroyed: boolean; readonly handle: never} {
    return {destroyed: false, get handle(): never {throw new Error('Portable texture handles must stay opaque');}, destroy() {this.destroyed = true;}};
}

test('texture factory preserves placeholder/upload order and retires each replaced owner', async () => {
    const gl = {}, resources: ReturnType<typeof createResource>[] = [], options: TangramTextureOptions[] = [];
    Texture.setResourceFactory(gl, request => {options.push(request); const resource = createResource(); resources.push(resource); return resource;});
    const data = new Uint8Array(16);
    const texture = Texture.create(gl, '__resource_texture_test', {width: 2, height: 2, data, filtering: 'linear'});
    try {
        await texture.loading;
        expect(resources).toHaveLength(2); expect(resources[0].destroyed).toBe(true);
        expect(texture.getResource()).toBe(resources[1]); expect(texture.texture).toBe(resources[1]);
        expect(options[0]).toMatchObject({id: texture.name, width: 1, height: 1, filtering: 'nearest'});
        expect(options[1]).toMatchObject({width: 2, height: 2, filtering: 'linear'});
        expect(options[1].data).toBe(data);
    } finally {texture.destroy({force: true}); Texture.clearResourceFactory(gl);}
    expect(resources[1].destroyed).toBe(true); expect(texture.texture).toBeNull();
});

test('portable null contexts and handle-free resources bypass raw GL scopes', () => {
    const resources: ReturnType<typeof createResource>[] = [];
    const scope = vi.spyOn(Context, 'withContext').mockImplementation(() => {throw new Error('portable resources must bypass WebGL scopes');});
    let texture: Texture | undefined;
    try {
        texture = Texture.create(null, '__portable_texture_test', {width: 1, height: 1, data: new Uint8Array(4),
            textureFactory() {const resource = createResource(); resources.push(resource); return resource;}});
        texture.update(new Uint8Array(4)); texture.setFiltering({filtering: 'nearest'}); texture.destroy({force: true});
        expect(resources).toHaveLength(3); expect(resources.every(resource => resource.destroyed)).toBe(true);
        expect(texture.texture).toBeNull();
    } finally {texture?.destroy({force: true}); scope.mockRestore();}
});

test('detached worker metadata supports dimensions/sprites without pretending to own GPU methods', async () => {
    const metadata: TextureInfo = {name: '__worker_texture', width: 8, height: 4, density: 2, valid: true,
        texcoords: {icon: [0, 0, 1, 1]}, sizes: {icon: [8, 4]}, css_sizes: {icon: [4, 2]}, aspects: {icon: 2}};
    Texture.textures[metadata.name] = metadata;
    try {
        expect(await Texture.getInfo(metadata.name)).toMatchObject(metadata);
        expect(await Texture.getInfo([metadata.name, '__missing'])).toEqual([expect.objectContaining(metadata), null]);
        expect(await Texture.getInfo('')).toEqual(expect.arrayContaining([expect.objectContaining(metadata)]));
        expect(await Texture.getInfo(['', metadata.name])).toEqual([expect.arrayContaining([expect.objectContaining(metadata)]), expect.objectContaining(metadata)]);
        expect(Texture.getSpriteInfo(metadata.name, 'icon')).toEqual({size: [8, 4], css_size: [4, 2], aspect: 2, texcoords: [0, 0, 1, 1]});
        expect(() => {Texture.retain(metadata.name); Texture.release(metadata.name); Texture.destroy({});}).not.toThrow();
        expect(Texture.textures[metadata.name]).toBe(metadata);
    } finally {delete Texture.textures[metadata.name];}
});

test('live replacements preserve retain counts, computed sprite metadata and unchanged-config reuse', async () => {
    const context = {}, options: TextureOptions = {width: 8, height: 4, data: new Uint8Array(128), density: 2,
        sprites: {icon: [0, 0, 4, 2]}, textureFactory: createResource};
    const first = Texture.create(context, '__sprite_texture', options); first.retain();
    const second = Texture.create(context, first.name, options);
    try {
        await second.loading;
        expect(first.valid).toBe(false); expect(second.retain_count).toBe(1);
        expect(Texture.changed(second.name, options)).toBe(false);
        expect(Texture.getSpriteInfo(second.name, 'icon')).toMatchObject({size: [4, 2], css_size: [2, 1], aspect: 2});
        expect(await Texture.createFromObject(context, {[second.name]: options})).toEqual([]);
        const info = await Texture.getInfo(second.name);
        expect(!Array.isArray(info) && info?.css_size).toEqual([4, 2]);
        Texture.release(second.name); expect(second.valid).toBe(false);
    } finally {first.destroy({force: true}); second.destroy({force: true});}
});

test('classic texture guard rejects missing contexts without touching portable resource ownership', () => {
    expect(() => Texture.create(null, '__invalid_classic')).toThrow('WebGL context');
    expect(() => Texture.getMaxTextureSize({})).toThrow('WebGL context');
});

test('resolved canvas selectors upload the DOM source and apply filtering without claiming an arbitrary Element is an image', async () => {
    const canvas = document.createElement('canvas');
    canvas.id = 'typed-texture-canvas'; canvas.width = 4; canvas.height = 2; document.body.appendChild(canvas);
    const requests: TangramTextureOptions[] = [];
    const texture = Texture.create(null, '__canvas_selector', {element: '#typed-texture-canvas', filtering: 'nearest',
        textureFactory(options) {requests.push(options); return createResource();}});
    try {
        await texture.loading;
        expect(requests).toHaveLength(2); expect(requests[1].data).toBe(canvas);
        expect(texture.width).toBe(4); expect(texture.height).toBe(2);
        expect(texture.filtering).toBe('nearest'); expect(texture.config_type).toBe('element');
        expect(await Texture.getInfo(texture.name)).toMatchObject({width: 4, height: 2, filtering: 'nearest'});
        expect(Texture.changed(texture.name, {element: canvas})).toBe(true);
    } finally {texture.destroy({force: true}); canvas.remove();}
});

test('context scopes preserve generic callback results, identities and exception propagation', () => {
    const context = {}, values = {answer: 42}, entered: string[] = [];
    const configured = Context.configure(context, callback => {entered.push('scope'); return callback();});
    expect(Context.configure(configured)._tangram_id).toBe(configured._tangram_id);
    expect(Context.hasContextScope(configured)).toBe(true);
    expect(Context.withContext(configured, () => values)).toBe(values);
    expect(Context.withContext(null, () => values)).toBe(values);
    expect(() => Context.withContext(configured, () => {throw new Error('callback failure');})).toThrow('callback failure');
    expect(entered).toEqual(['scope', 'scope']); expect(Context.hasContextScope(null)).toBe(false);
});

test('worker texture replies preserve only detached metadata, with null and malformed records rejected', async () => {
    const metadata: TextureInfo = {name: '__worker_reply', width: 2, height: 2, density: 1, valid: true,
        texcoords: {}, sizes: {}, css_sizes: {}, aspects: {}};
    const postMessage = vi.spyOn(WorkerBroker, 'postMessage').mockResolvedValue([metadata, null, 42, {},
        {...metadata, name: 1}, {...metadata, width: 'bad'}, {...metadata, height: 'bad'},
        {...metadata, density: 'bad'}, {...metadata, valid: 'bad'}, {...metadata, sizes: null}]);
    try {
        const table = await Texture.syncTexturesToWorker([metadata.name]);
        expect(table[metadata.name]).toBe(metadata);
        expect(postMessage).toHaveBeenCalledWith('Texture.getInfo', [metadata.name]);
        expect(await Texture.getInfo(metadata.name)).toMatchObject(metadata);
        postMessage.mockResolvedValue(null);
        expect(await Texture.syncTexturesToWorker(null)).toBe(table);
    } finally {postMessage.mockRestore(); delete Texture.textures[metadata.name];}
});

/** Chromium provides the canonical legacy context; no live assets or GPU draws are needed here. */
function createClassicContext(): WebGLRenderingContext {
    const canvas = document.createElement('canvas'), context = canvas.getContext('webgl');
    if (!context) throw new Error('Chromium WebGL fixture is unavailable');
    return context;
}

test('classic raw pixels and DOM uploads preserve filtering and reject incomplete images at the typed boundary', () => {
    const context = createClassicContext(), canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 2;
    const texture = Texture.create(context, '__classic_upload', {width: 2, height: 2, data: new Uint8Array(16), filtering: 'nearest'});
    try {
        expect(texture.loaded).toBe(true); expect(texture.texture_resource).toBeNull();
        expect(context.getTexParameter(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER)).toBe(context.NEAREST);
        texture.setElement(canvas, {filtering: 'linear'});
        expect(texture.filtering).toBe('linear'); expect(texture.width).toBe(2);
        const image = document.createElement('img'); Object.defineProperty(image, 'complete', {value: false});
        expect(() => texture.update(image)).toThrow('finish loading');
        expect(context.getError()).toBe(context.NO_ERROR);
    } finally {texture.destroy({force: true}); context.getExtension('WEBGL_lose_context')?.loseContext();}
});

test('classic context creation preserves experimental fallback, sizing and numeric identity', () => {
    const context = createClassicContext(), canvas = document.createElement('canvas');
    canvas.style.width = '30px'; canvas.style.height = '20px';
    const getContext = vi.spyOn(canvas, 'getContext').mockImplementation(type => type === 'experimental-webgl' ? context : null);
    const resize = vi.spyOn(Context, 'resize');
    try {
        expect(Context.getContext(canvas, {device_pixel_ratio: 2})).toBe(context);
        expect(getContext.mock.calls.map(call => call[0])).toEqual(['webgl', 'experimental-webgl']);
        expect(resize).toHaveBeenCalledWith(context, 30, 20, 2);
        expect(context.canvas.width).toBe(60); expect(context.canvas.height).toBe(40);
        expect(Context.hasContextScope(context)).toBe(false);
    } finally {getContext.mockRestore(); resize.mockRestore(); context.getExtension('WEBGL_lose_context')?.loseContext();}
});

test('unsupported and non-WebGL context results reject explicitly without resizing another canvas', () => {
    const canvas = document.createElement('canvas'), wrongContext = document.createElement('canvas').getContext('2d');
    const getContext = vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    try {
        expect(() => Context.getContext(canvas)).toThrow("Couldn't create WebGL context");
        getContext.mockReturnValue(wrongContext);
        expect(() => Context.getContext(canvas)).toThrow("Couldn't create WebGL context");
    } finally {getContext.mockRestore();}
});

test('fullscreen contexts attach their canvas and retain resize hooks without taking device ownership', () => {
    const context = createClassicContext(), originalCanvas = context.canvas;
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const addListener = vi.spyOn(window, 'addEventListener'), resize = vi.spyOn(Context, 'resize');
    let inserted: HTMLCanvasElement | undefined;
    try {
        expect(Context.getContext()).toBe(context);
        const candidate = getContext.mock.contexts[0];
        if (!(candidate instanceof HTMLCanvasElement)) throw new Error('Fullscreen fixture did not create a canvas');
        inserted = candidate;
        expect(inserted.style).toMatchObject({position: 'absolute', top: '0px', left: '0px', zIndex: '-1'});
        expect(inserted.isConnected).toBe(true);
        expect(resize).toHaveBeenCalledWith(context, window.innerWidth, window.innerHeight, undefined);
        window.dispatchEvent(new Event('resize')); expect(resize).toHaveBeenCalledTimes(2);
        expect(context.canvas).toBe(originalCanvas);
    } finally {
        for (const [event, listener] of addListener.mock.calls) if (String(event) === 'resize') window.removeEventListener('resize', listener);
        inserted?.remove(); getContext.mockRestore(); addListener.mockRestore(); resize.mockRestore();
        context.getExtension('WEBGL_lose_context')?.loseContext();
    }
});
