// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import type {Light} from '@luma.gl/shadertools';
import type {TangramLight} from '@vis.gl/tangram-renderer';
import {RenderingHarness} from './harness';

let harness: RenderingHarness | undefined;
afterEach(async () => {
    try {
        expect(harness?.errors || []).toEqual([]);
        expect(await commands.renderingDiagnostics()).toEqual([]);
    } finally {
        harness?.destroy();
        harness = undefined;
    }
});

/** Native lights probe the near-side surface in globe common coordinates. */
const lights: Light[] = [
    {type: 'ambient', color: [255, 0, 0], intensity: 0.5},
    {type: 'directional', color: [255, 0, 0], direction: [0, 1, 0], intensity: 0.5},
    {type: 'point', color: [255, 0, 0], position: [0, -300, 0], attenuation: [2, 0, 0]},
    {type: 'spot', color: [255, 0, 0], position: [0, -300, 0], direction: [0, 1, 0],
        attenuation: [2, 0, 0], innerConeAngle: 0.2, outerConeAngle: 0.4}
];

/** Small curved surface used to compare actual light/falloff pixels without external tiles. */
function createSurfaceScene(sceneLights: unknown, extent = 35, material: {
    emission?: number | number[];
    ambient: number | number[];
    diffuse: number | number[];
    specular: number | number[];
} = {ambient: 1, diffuse: 1, specular: 0}) {
    const source = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({
        type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
            type: 'Polygon', coordinates: [[[-extent, -extent], [extent, -extent],
                [extent, extent], [-extent, extent], [-extent, -extent]]]
        }}]
    }))}`;
    return {
        sources: {surface: {type: 'GeoJSON', url: source, max_zoom: extent < 1 ? 16 : 2}},
        lights: sceneLights,
        styles: {surface: {base: 'polygons', lighting: 'fragment',
            material}},
        layers: {surface: {data: {source: 'surface'}, draw: {surface: {order: 0, color: '#ffffff'}}}}
    };
}

test.each(lights)('native $type light renders through the packaged renderer and worker', async light => {
    harness = new RenderingHarness('globe');
    harness.presentation.setViewState({zoom: 0});
    await harness.initialize(createSurfaceScene([light]));
    for (const bearing of [0, 90]) {
        harness.presentation.setViewState({bearing});
        await harness.settle();
        const image = await harness.pixels();
        const pixel = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
        expect(image.data[pixel]).toBeGreaterThan(120);
        expect(image.data[pixel]).toBeLessThan(135);
        expect(image.data[pixel + 1]).toBe(0);
        expect(image.data[pixel + 2]).toBe(0);
        const definitions = harness.renderer.getLumaLightDefinitions();
        expect(definitions[0].light.type).toBe(light.type);
    }
});

test.each([
    {name: 'linear distance', type: 'point', attenuation: [1, 1 / 44, 0], angle: 0, inner: 0.2, outer: 0.4, expected: 127.5},
    {name: 'quadratic distance', type: 'point', attenuation: [1, 0, 1 / (44 * 44)], angle: 0, inner: 0.2, outer: 0.4, expected: 127.5},
    {name: 'equal cone inside', type: 'spot', attenuation: [2, 0, 0], angle: 0, inner: 0.2, outer: 0.2, expected: 127.5},
    {name: 'equal cone outside', type: 'spot', attenuation: [2, 0, 0], angle: 0.6, inner: 0.2, outer: 0.2, expected: 0},
    {name: 'outside cone floor', type: 'spot', attenuation: [2, 0, 0], angle: 0.6, inner: 0.2, outer: 0.4, expected: 0}
] as const)('native attenuation boundary: $name', async sample => {
    harness = new RenderingHarness('globe');
    harness.presentation.setViewState({zoom: 0});
    const common = {color: [255, 0, 0], position: [0, -300, 0], attenuation: sample.attenuation} as const;
    const light: Light = sample.type === 'point' ? {type: 'point', ...common} : {
        type: 'spot', ...common, direction: [Math.sin(sample.angle), Math.cos(sample.angle), 0],
        innerConeAngle: sample.inner, outerConeAngle: sample.outer
    };
    await harness.initialize(createSurfaceScene([light]));
    await harness.settle();
    const image = await harness.pixels();
    const pixel = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    expect(Math.abs(image.data[pixel] - sample.expected)).toBeLessThan(3);
    expect(image.data[pixel + 1]).toBe(0);
    expect(image.data[pixel + 2]).toBe(0);
});

test.each([
    {view: 'flat', type: 'point'}, {view: 'flat', type: 'spot'},
    {view: 'globe', type: 'point'}, {view: 'globe', type: 'spot'}
] as const)('geographic $type illuminates $view surfaces in both preview eyes', async ({view, type}) => {
    harness = new RenderingHarness(view);
    harness.presentation.setMode('stereo-preview');
    if (view === 'globe') harness.presentation.setViewState({zoom: 0});
    const altitude = view === 'globe' ? 44 * 6370972 / 256 : 1000;
    const lamp: TangramLight = type === 'point'
        ? {type, position: [0, 0, altitude], positionSpace: 'geographic', color: [255, 0, 0], attenuation: [2, 0, 0]}
        : {type, position: [0, 0, altitude], positionSpace: 'geographic', direction: [0, 0, -1],
            color: [255, 0, 0], attenuation: [2, 0, 0], innerConeAngle: 0.2, outerConeAngle: 0.4};
    await harness.initialize(createSurfaceScene([lamp], view === 'globe' ? 35 : 0.002));
    await harness.settle();
    const image = await harness.pixels();
    for (const horizontalFraction of [0.25, 0.75]) {
        const pixel = (Math.floor(image.height / 2) * image.width + Math.floor(image.width * horizontalFraction)) * 4;
        expect(image.data[pixel]).toBeGreaterThan(120);
        expect(image.data[pixel]).toBeLessThan(135);
        expect(image.data[pixel + 1]).toBe(0);
        expect(image.data[pixel + 2]).toBe(0);
    }
});

test.each(['vertex', 'fragment'] as const)('configured legacy %s lighting survives scene reload and explicit no-lights', async lighting => {
    harness = new RenderingHarness('globe');
    harness.presentation.setViewState({zoom: 0});
    const definition = {...createSurfaceScene({sky: {type: 'ambient', ambient: [0, 0.5, 0]}}),
        scene: {lighting: 'configured'}};
    definition.styles.surface.lighting = lighting;
    await harness.initialize(definition);
    await harness.settle();
    let image = await harness.pixels();
    const pixel = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    expect(image.data[pixel + 1]).toBeGreaterThan(120);
    expect(image.data[pixel + 1]).toBeLessThan(135);
    expect(image.data[pixel]).toBe(0);
    await harness.renderer.load(createSurfaceScene([]));
    await harness.settle();
    image = await harness.pixels();
    expect(Array.from(image.data.slice(pixel, pixel + 3))).toEqual([0, 0, 0]);
    await harness.renderer.load(createSurfaceScene([{type: 'ambient', color: [255, 0, 0], intensity: 0.5}]));
    await harness.settle();
    image = await harness.pixels();
    expect(image.data[pixel]).toBeGreaterThan(120);
    expect(image.data[pixel + 1]).toBe(0);
});

test.each(['vertex', 'fragment'] as const)('%s material keeps separate emission and ambient responses', async lighting => {
    harness = new RenderingHarness('globe');
    harness.presentation.setViewState({zoom: 0});
    const definition = createSurfaceScene([{type: 'ambient', color: [255, 255, 255], intensity: 0.5}]);
    definition.styles.surface = {base: 'polygons', lighting,
        material: {emission: [0.1, 0.2, 0.3, 1], ambient: [0.2, 0.4, 0.6, 1], diffuse: 0, specular: 0}};
    await harness.initialize(definition);
    await harness.settle();
    const image = await harness.pixels();
    const pixel = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    for (const [index, expected] of [51, 102, 153].entries()) {
        expect(Math.abs(image.data[pixel + index] - expected)).toBeLessThan(3);
    }
});

test.each(['point', 'spot'] as const)('%s combines native coefficients with optional Tangram radius falloff', async type => {
    harness = new RenderingHarness('globe');
    harness.presentation.setViewState({zoom: 0});
    const light: TangramLight = type === 'point' ? {
        type, color: [255, 0, 0], position: [0, -300, 0], attenuation: [2, 0, 0], radius: [0, 88], attenuationExponent: 2
    } : {
        type, color: [255, 0, 0], position: [0, -300, 0], direction: [0, 1, 0],
        attenuation: [2, 0, 0], radius: [0, 88], attenuationExponent: 2, spotExponent: 2
    };
    await harness.initialize(createSurfaceScene([light]));
    await harness.settle();
    const image = await harness.pixels();
    const pixel = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    // The surface is 44 common-space units from the lamp: (1 - (44 / 88)^2) / 2 = 0.375.
    expect(image.data[pixel]).toBeGreaterThan(90);
    expect(image.data[pixel]).toBeLessThan(100);
    expect(image.data[pixel + 1]).toBe(0);
    expect(image.data[pixel + 2]).toBe(0);
});

test.each([false, true])('mixed native/legacy falloff stays independent; reverse=%s', async reverse => {
    harness = new RenderingHarness('globe');
    harness.presentation.setViewState({zoom: 0});
    const sceneLights = {
        native: {luma: lights[2]},
        // A dark legacy lamp still requires a different radius/exponent uniform layout.
        legacy: {type: 'point', origin: 'camera', position: [0, 0, 100],
            ambient: 0, diffuse: 0, specular: 0, radius: [0, 88], attenuation: 2}
    };
    await harness.initialize(createSurfaceScene(reverse ? {legacy: sceneLights.legacy, native: sceneLights.native} : sceneLights));
    await harness.settle();
    const image = await harness.pixels();
    const pixel = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    expect(image.data[pixel]).toBeGreaterThan(120);
    expect(image.data[pixel]).toBeLessThan(135);
    expect(image.data[pixel + 1]).toBe(0);
    expect(image.data[pixel + 2]).toBe(0);
});
