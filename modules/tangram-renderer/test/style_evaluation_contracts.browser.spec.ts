// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import StyleParser from '../src/styles/style_parser';
import {buildFilter} from '../src/styles/filter';
import {LayerTree, layerCache, parseLayers, mergeTrees} from '../src/styles/layer';
import {StyleManager} from '../src/styles/style_manager';
import type {PropertyContext, PropertyCache} from '../src/styles/property-types';
import type {LayerMatchContext, SceneLayerDefinition} from '../src/styles/layer-types';
import type {StyleDefinition, StyleManagerTile} from '../src/styles/style-mixing-types';
import Geo from '../src/utils/geo';

/** Complete feature context for checked parser/layer entry points. */
function createContext(zoom = 12): LayerMatchContext {
    return {zoom, feature: {id: 'ab', geometry: {type: 'LineString'},
        properties: {kind: 'major', rank: 4, tags: ['bridge', 'paved']}},
    layers: ['roads'], meters_per_pixel_sq: 4};
}

/** Assert the root-tree contract without hiding it behind a fixture assertion. */
function createRoot(definition: SceneLayerDefinition): LayerTree {
    const root = parseLayers({roads: definition}, {}).roads;
    expect(root).toBeInstanceOf(LayerTree);
    if (!(root instanceof LayerTree)) throw new Error('Expected a root tree');
    return root;
}

/** Build/cache fixtures are required for every non-null raw property. */
function createCache(value: unknown): PropertyCache {
    const cache = StyleParser.createPropertyCache(value);
    if (!cache) throw new Error('Expected a property cache');
    return cache;
}

describe('checked property evaluation contracts', () => {
    test.each([
        ['4px', 4], ['-4px', -4], ['no number', 0], [false, 0], [Infinity, Infinity]
    ])('retains legacy numeric coercion for %s', (value, expected) => {
        expect(StyleParser.parseNumber(value)).toBe(expected);
    });

    test('retains array normalization and positive clamping', () => {
        expect(StyleParser.parsePositiveNumber(['-5', '12px', 'invalid'])).toEqual([0, 12, 0]);
    });

    test('retains clamping coercion for nested numeric arrays', () => {
        const rawValue: unknown = [[-5], [12], [2, 3]];
        expect(StyleParser.parseNumber(rawValue)).toEqual([-5, 12, 2]);
        expect(StyleParser.parsePositiveNumber(rawValue)).toEqual([0, 12, NaN]);
    });

    test('normalizes each zoom stop once, retaining its original index', () => {
        const transform = vi.fn((value: unknown, index: number) => Number(value) + index);
        const cache = StyleParser.createPropertyCache([[10, 2], [14, 5]], transform);
        expect(StyleParser.evalCachedProperty(cache, createContext())).toBe(4);
        expect(StyleParser.evalCachedProperty(cache, createContext())).toBe(4);
        expect(transform.mock.calls).toEqual([[2, 0], [5, 1]]);
    });

    test('cloned zoom caches share authored stops but not evaluated values', () => {
        const original = createCache([[10, 2], [14, 6]]);
        StyleParser.evalCachedProperty(original, createContext());
        const clone = StyleParser.createPropertyCache(original)!;
        expect(clone.value).toBe(original.value);
        expect(clone.zoom).toEqual({});
        expect(clone.zoom).not.toBe(original.zoom);
        expect(StyleParser.evalCachedProperty(clone, createContext(14))).toBe(6);
        expect(original.zoom).toEqual({12: 4});
    });

    test('dynamic transforms run per feature, not per zoom', () => {
        const expression = vi.fn((context: PropertyContext) => context.feature?.properties.rank);
        const transform = vi.fn((value: unknown) => Number(value) * 2);
        const cache = StyleParser.createPropertyCache(expression, null, transform);
        const context = createContext();
        expect(StyleParser.evalCachedProperty(cache, context)).toBe(8);
        context.feature.properties.rank = 9;
        expect(StyleParser.evalCachedProperty(cache, context)).toBe(18);
        expect(expression).toHaveBeenCalledTimes(2);
        expect(transform).toHaveBeenCalledTimes(2);
    });

    test('pixel units remain zoom-relative while meter values remain absolute', () => {
        const cache = createCache([[10, '2px'], [14, '6px']]);
        expect(StyleParser.evalCachedDistanceProperty(cache, createContext()))
            .toBeCloseTo(4 * Geo.metersPerPixel(12));
        expect(StyleParser.convertUnits(23, createContext())).toBe(23);
        expect(StyleParser.convertUnits(['2px', 23], createContext()))
            .toEqual([2 * Geo.metersPerPixel(12), 23]);
    });

    test('sprite-relative caches isolate metadata for identical authored sizes', () => {
        const cache = StyleParser.createPointSizePropertyCache(['50%', 'auto'], 'icons')!;
        expect(StyleParser.evalCachedPointSizeProperty(cache,
            {sprite: 'wide', css_size: [80, 20], aspect: 4}, null, createContext())).toEqual([40, 10]);
        expect(StyleParser.evalCachedPointSizeProperty(cache,
            {sprite: 'square', css_size: [30, 30], aspect: 1}, null, createContext())).toEqual([15, 15]);
        expect(cache.sprites?.wide).not.toBe(cache.sprites?.square);
    });

    test('null and missing property caches retain the no-value result', () => {
        expect(StyleParser.evalCachedProperty(null, createContext())).toBeUndefined();
        expect(StyleParser.evalCachedDistanceProperty(undefined, createContext())).toBeUndefined();
        expect(StyleParser.evalCachedPointSizeProperty(null, null, null, createContext())).toBeUndefined();
    });
});

describe('checked layer/filter contracts', () => {
    test('function filters retain their authored result without adding boolean coercion', () => {
        expect(buildFilter(() => 7)(createContext())).toBe(7);
        expect(buildFilter(() => undefined)(createContext())).toBeUndefined();
    });

    test.each([
        [{kind: 'major'}, true], [{kind: 'minor'}, false],
        [{tags: {includes_all: ['bridge', 'paved']}}, true],
        [{none: [{kind: 'major'}]}, false],
        [{any: [{kind: 'minor'}, {rank: {min: 3, max: 5}}]}, true],
        [{kind: true}, true]
    ])('evaluates authored filter %j', (filter, expected) => {
        expect(buildFilter(filter)(createContext())).toBe(expected);
    });

    test('does not build children until their parent matches', () => {
        const root = createRoot({filter: {kind: 'minor'}, child: {draw: {lines: {width: 2}}}});
        expect(root.layers).toEqual([]);
        expect(root.buildDrawGroups(createContext())).toBeUndefined();
        expect(root.layers).toEqual([]);
        const context = createContext();
        context.feature.properties.kind = 'minor';
        expect(root.buildDrawGroups(context)?.lines?.width).toBe(2);
        expect(root.layers).toHaveLength(1);
        expect(root.children_to_parse).toBeUndefined();
    });

    test('reuses a draw-group combination until parseLayers resets the cache', () => {
        const root = createRoot({draw: {lines: {width: 2}}});
        const groups = root.buildDrawGroups(createContext());
        expect(root.buildDrawGroups(createContext())).toBe(groups);
        expect(Object.values(layerCache())).toContain(groups);
        parseLayers({}, {});
        expect(layerCache()).toEqual({});
    });

    test('exclusive siblings choose the lowest priority value before ordinary siblings', () => {
        const root = createRoot({draw: {lines: {width: 1}},
            ordinary: {priority: 0, draw: {lines: {width: 99}}},
            second: {exclusive: true, priority: 2, draw: {lines: {width: 20}}},
            first: {exclusive: true, priority: 1, draw: {lines: {width: 10}}}});
        const groups = root.buildDrawGroups(createContext());
        expect(groups?.lines?.width).toBe(10);
        expect(groups?.lines?.layers).toEqual(['roads:first']);
    });

    test('pixel-squared bounds use the context conversion at match time', () => {
        const root = createRoot({filter: {area: {min: '2px2', max: '5px2'}}, draw: {polygons: {order: 1}}});
        const context = createContext();
        context.feature.properties.area = 9;
        expect(root.buildDrawGroups(context)?.polygons?.order).toBe(1);
        context.meters_per_pixel_sq = 10;
        expect(root.buildDrawGroups(context)).toBeUndefined();
    });

    test('hidden draw stacks remain absent without disrupting visible siblings', () => {
        const inherited = {lines: {width: 1}};
        expect(mergeTrees([[inherited], [inherited, {lines: {visible: false}}]], 'lines')).toBeNull();
        expect(mergeTrees([false, [inherited]], 'lines')).toEqual({visible: true, width: 1});
        expect(mergeTrees([], 'lines')).toBeNull();
    });

    test('invalid draw scalars are discarded but null draw groups are normalized', () => {
        const root = createRoot({draw: {invalid: 42, lines: null}});
        expect(root.draw).toEqual({lines: {}});
    });
});

describe('checked style mixin ownership', () => {
    test('deduplicates diamond shader blocks and retains their ancestor scopes', () => {
        const manager = new StyleManager();
        const styles: Record<string, StyleDefinition> = {
            shared: {name: 'shared', shaders: {blocks: {color: 'shared();'}}},
            left: {name: 'left', mix: 'shared', shaders: {blocks: {color: 'left();'}}},
            right: {name: 'right', mix: 'shared', shaders: {blocks: {color: 'right();'}}},
            final: {name: 'final', mix: ['left', 'right'], shaders: {blocks: {color: 'final();'}}}
        };
        for (const name of ['shared', 'left', 'right', 'final']) manager.mix(styles[name], styles);
        expect(styles.final.shaders?.blocks?.color).toEqual(['shared();', 'left();', 'right();', 'final();']);
        expect(styles.final.shaders?.block_scopes?.color).toEqual(['shared', 'left', 'right', 'final']);
        const shaderIdentity = styles.final.shaders;
        expect(manager.mix(styles.final, styles).shaders).toBe(shaderIdentity);
    });

    test('uniforms forward ancestor writes until a child owns the value', () => {
        const manager = new StyleManager();
        const styles: Record<string, StyleDefinition> = {
            parent: {name: 'parent', shaders: {uniforms: {speed: 1}}},
            child: {name: 'child', mix: 'parent'}
        };
        manager.mix(styles.parent, styles);
        manager.mix(styles.child, styles);
        const parentUniforms = styles.parent.shaders!.uniforms!;
        const childUniforms = styles.child.shaders!.uniforms!;
        parentUniforms.speed = 2;
        expect(childUniforms.speed).toBe(2);
        childUniforms.speed = 3;
        expect(parentUniforms.speed).toBe(2);
        expect(childUniforms.speed).toBe(3);
        childUniforms.speed = undefined;
        expect(childUniforms.speed).toBe(2);
        parentUniforms.speed = undefined;
        expect(childUniforms.speed).toBeUndefined();
    });

    test('shader extensions and nested draw defaults merge without mutating ancestors', () => {
        const manager = new StyleManager();
        const styles: Record<string, StyleDefinition> = {
            parent: {name: 'parent', animated: true, draw: {outline: {width: 2, color: 'red'}},
                shaders: {extensions: ['EXT_one', 'EXT_two']}},
            child: {name: 'child', mix: ['missing', 'parent'], draw: {outline: {color: 'blue'}},
                shaders: {extensions: 'EXT_one'}}
        };
        manager.mix(styles.parent, styles);
        manager.mix(styles.child, styles);
        expect(styles.child.draw).toEqual({outline: {width: 2, color: 'blue'}});
        expect(styles.parent.draw).toEqual({outline: {width: 2, color: 'red'}});
        expect(styles.child.shaders?.extensions).toEqual(['EXT_one', 'EXT_two']);
        expect(styles.child.animated).toBe(true);
    });

    test('active mesh passes deduplicate styles and sort numeric blend orders', () => {
        const manager = new StyleManager();
        const tiles: StyleManagerTile[] = [
            {meshes: {roads: [{variant: {blend_order: 10}}, {variant: {blend_order: -1}}]}},
            {meshes: {roads: [{variant: {blend_order: 10}}], buildings: [{variant: {blend_order: 10}}]}}
        ];
        expect(manager.updateActiveStyles(tiles)).toEqual(['roads', 'buildings']);
        manager.updateActiveBlendOrders(tiles);
        expect(manager.getActiveBlendOrders()).toEqual([
            {blend_order: -1, styles: ['roads']}, {blend_order: 10, styles: ['roads', 'buildings']}
        ]);
    });

    test('abstract style definitions never enter the render-style registry', () => {
        const manager = new StyleManager();
        expect(manager.create('abstract', {shaders: {defines: {CUSTOM: true}}}).base).toBeNull();
        expect(manager.styles.abstract).toBeUndefined();
        const definition = {base: 'lines', draw: {outline: {width: 2}}};
        const style = manager.create('road', definition);
        expect(manager.styles.road).toBe(style);
        expect(Object.getPrototypeOf(style)).toBe(manager.base_styles.lines);
        expect(definition).toEqual({base: 'lines', draw: {outline: {width: 2}}});
    });

    test('inheritance traversal preserves missing and direct self references', () => {
        const manager = new StyleManager();
        expect(manager.inheritanceDepth('missing', {})).toBe(0);
        expect(manager.inheritanceDepth('self', {self: {mix: 'self'}})).toBe(1);
        expect(manager.inheritanceDepth('child', {child: {mix: ['base', 'middle']},
            middle: {mix: 'base'}, base: {}})).toBe(2);
    });
});
