// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, expectTypeOf, test} from 'vitest';
import SceneLoader from '../src/scene/scene_loader';
import {SceneBundle} from '../src/scene/scene_bundle';
import {isGlobalSubstitution} from '../src/scene/globals';
import {setPropertyPath} from '../src/utils/props';
import {addBaseURL, pathForURL} from '../src/utils/urls';
import type {SceneDefinition, SceneSourceDefinition} from '../src/scene/scene-resource-types';

describe('typed scene resource contracts', () => {
    test('distinguishes missing subtrees from finalized scenes without losing bundle identity', async () => {
        const missing = await SceneLoader.loadSceneRecursive({}, null);
        expectTypeOf(missing.config).toEqualTypeOf<SceneDefinition | undefined>();
        expect(missing).toEqual({});

        const bundle = new SceneBundle({}, 'https://scenes.test/');
        const finalized = SceneLoader.finalize({config: {custom: {enabled: true}}, bundle}, {cameraMode: 'external'});
        expectTypeOf(finalized.bundle).toEqualTypeOf<SceneBundle>();
        expectTypeOf(finalized.config.cameras).toEqualTypeOf<Record<string, Record<string, unknown>>>();
        expect(finalized.bundle).toBe(bundle);
        expect(finalized.config.custom).toEqual({enabled: true});
        expect(finalized.config.cameras).toEqual({});
    });

    test('preserves omitted URLs and object scene directories', () => {
        const bundle = new SceneBundle({custom: true});
        expectTypeOf(bundle.urlFor(undefined)).toEqualTypeOf<string | undefined>();
        expectTypeOf(addBaseURL('icon.png', 'https://scenes.test/')).toEqualTypeOf<string>();
        expect(bundle.path).toBe('');
        expect(bundle.urlFor(undefined)).toBeUndefined();
        expect(bundle.urlFor('global.image')).toBe('global.image');
        expect(addBaseURL(undefined, 'https://scenes.test/')).toBeUndefined();
        expect(pathForURL({custom: true})).toBe('');
    });

    test('normalizes typed metadata, composite resources and legacy script lists independently', () => {
        const source: SceneSourceDefinition = {
            type: 'Raster', tilejson: 'tiles.json',
            composite: [{url: 'first.png'}, {url: 'second.png'}],
            scripts: ['decode.js'], customOption: {enabled: true}
        };
        const bundle = new SceneBundle({}, 'https://scenes.test/styles/');
        const normalized = SceneLoader.normalizeDataSource(source, bundle);
        expectTypeOf(normalized).toEqualTypeOf<SceneSourceDefinition>();
        expect(normalized).toBe(source);
        expect(normalized.url).toBeUndefined();
        expect(normalized.tilejson).toBe('https://scenes.test/styles/tiles.json');
        expect(normalized.composite).toEqual([
            {url: 'https://scenes.test/styles/first.png'}, {url: 'https://scenes.test/styles/second.png'}
        ]);
        expect(normalized.scripts).toEqual({'decode.js': 'https://scenes.test/styles/decode.js'});
        expect(normalized.customOption).toEqual({enabled: true});
    });

    test('tracks numeric uniform paths through global texture hoisting and explicit overrides', () => {
        const config = {
            global: {left: 'images/left.png', right: 'images/right.png'},
            textures: {},
            styles: {sample: {shaders: {uniforms: {images: ['global.left', 'global.right']}}}}
        };
        const bundle = new SceneBundle({}, 'https://scenes.test/');
        const nodes = {};
        SceneLoader.normalize(config, bundle, nodes);
        SceneLoader.applyGlobalProperties(config);
        const path = ['styles', 'sample', 'shaders', 'uniforms', 'images', 0];
        expect(isGlobalSubstitution(config, path)).toBe(true);
        SceneLoader.hoistTextureNodes(config, bundle, nodes);
        expect(config.textures).toEqual({
            'images/left.png': {url: 'https://scenes.test/images/left.png'},
            'images/right.png': {url: 'https://scenes.test/images/right.png'}
        });
        setPropertyPath(config, path, 'named-override');
        expect(isGlobalSubstitution(config, path)).toBe(false);
        config.global.left = 'new.png';
        config.global.right = 'other.png';
        SceneLoader.applyGlobalProperties(config);
        expect(config.styles.sample.shaders.uniforms.images).toEqual(['named-override', 'other.png']);
    });
});
