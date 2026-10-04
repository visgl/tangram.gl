// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {expect, test, vi} from 'vitest';
import {commands} from 'vitest/browser';
import {RenderingHarness, coloredPixels} from './harness';

test('scene reload retires real GPU caches without replacing the backend or losing rendering', async () => {
    await commands.startRenderingDiagnostics();
    const harness = new RenderingHarness('perspective', 'stereo-preview');
    try {
        await harness.initialize();
        const backend = harness.renderer.gpuBackend;
        const pipelines = vi.spyOn(harness.device, 'createRenderPipeline');
        const vertexArrays = vi.spyOn(harness.device, 'createVertexArray');
        const buffers = vi.spyOn(harness.device, 'createBuffer');
        // WebGPU pipelines/vertex arrays do not currently update Resource.destroyed.
        // Observe the public lifecycle method rather than backend-specific handles.
        const observeLiveResources = (resources: {id: string; destroyed: boolean; destroy(): void}[]) => resources
            .map(resource => ({resource, destroy: vi.spyOn(resource, 'destroy')}))
            .filter(entry => entry.destroy.mock.calls.length === 0);
        await harness.settle();
        for (const color of ['#ff4020', '#20d0b0']) {
            const previousPipelines = observeLiveResources(pipelines.mock.results.flatMap(result =>
                result.type === 'return' && !result.value.id.endsWith('-validation') ? [result.value] : []));
            const previousArrays = observeLiveResources(vertexArrays.mock.results.flatMap(result =>
                result.type === 'return' ? [result.value] : []));
            const previousSnapshots = observeLiveResources(buffers.mock.results.flatMap(result =>
                result.type === 'return' && result.value.id.endsWith('-uniforms') &&
                    result.value.id.startsWith('tangram-mesh-') ? [result.value] : []));
            expect(previousPipelines.length).toBeGreaterThan(0);
            expect(previousArrays.length).toBeGreaterThan(0);
            expect(previousSnapshots.length).toBeGreaterThan(0);
            await harness.reload(color);
            expect(harness.renderer.gpuBackend).toBe(backend);
            for (const entry of [...previousPipelines, ...previousArrays, ...previousSnapshots]) {
                expect(entry.destroy, entry.resource.id).toHaveBeenCalledTimes(1);
            }
            for (const entry of previousSnapshots) expect(entry.resource.destroyed).toBe(true);
            const pixels = await harness.pixels();
            expect(coloredPixels(pixels, 0, pixels.width / 2)).toBeGreaterThan(50);
            expect(coloredPixels(pixels, pixels.width / 2)).toBeGreaterThan(50);
        }
        expect(harness.errors).toEqual([]);
        expect(await commands.renderingDiagnostics()).toEqual([]);
    }
    finally {
        harness.destroy();
        vi.restoreAllMocks();
    }
});
