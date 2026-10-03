// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, expect, test} from 'vitest';
import {commands} from 'vitest/browser';
import type {Light} from '@luma.gl/shadertools';
import type {TangramLight} from '@vis.gl/tangram-renderer';
import {RenderingHarness, DEVICE_TYPE} from './harness';

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
function createSurfaceScene(sceneLights: unknown) {
    const source = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify({
        type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: {
            type: 'Polygon', coordinates: [[[-35, -35], [35, -35], [35, 35], [-35, 35], [-35, -35]]]
        }}]
    }))}`;
    return {
        sources: {surface: {type: 'GeoJSON', url: source, max_zoom: 2}},
        lights: sceneLights,
        styles: {surface: {base: 'polygons', lighting: 'fragment',
            material: {ambient: 1, diffuse: 1, specular: 0}}},
        layers: {surface: {data: {source: 'surface'}, draw: {surface: {order: 0, color: '#ffffff'}}}}
    };
}

// Configurable WGSL lighting is deliberately not advertised by the input adapter.
test.runIf(DEVICE_TYPE === 'webgl').each(lights)('native $type light renders through the packaged renderer and worker', async light => {
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

test.runIf(DEVICE_TYPE === 'webgl').each(['point', 'spot'] as const)('%s combines native coefficients with optional Tangram radius falloff', async type => {
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

test.runIf(DEVICE_TYPE === 'webgl').each([false, true])('mixed native/legacy falloff stays independent; reverse=%s', async reverse => {
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
