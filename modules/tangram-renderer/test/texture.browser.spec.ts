// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import Texture, {type TextureInfo, type TextureOptions, type TextureResource} from '../src/gl/texture';
import Context from '../src/gl/context';
import type {TangramTextureOptions} from '../src/gpu/tangram_gpu_backend';

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
