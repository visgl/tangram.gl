// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test, vi} from 'vitest';
import {createProjectionEngine, createProjectionDescriptor} from '@math.gl/projection/core';
import {equalEarth} from '@math.gl/projection/projections/eqearth';
import {albersEqualArea} from '@math.gl/projection/projections/aea';
import {equidistantCylindrical} from '@math.gl/projection/projections/eqc';
import {mercator} from '@math.gl/projection/projections/merc';
import {HostProjectionEngineAdapter, getProjectedCoordinateOptions, validateProjectionEngine,
    PROJECTED_COMMON_SCALE} from '../src/procedures/projected-coordinate-transform';

/** An explicitly registered, lightweight engine rather than the full projection catalog. */
function createEngine() {
    return createProjectionEngine({projections: [equalEarth, albersEqualArea, equidistantCylindrical, mercator]});
}

describe('injected host projection engine', () => {
    test('lazy factories preload only the requested algorithm before synchronous mesh batches', async () => {
        const loadEqualEarth = vi.fn(async () => equalEarth);
        const loadAlbers = vi.fn(async () => albersEqualArea);
        const adapter = new HostProjectionEngineAdapter(createProjectionEngine({projections: [
            createProjectionDescriptor(equalEarth, loadEqualEarth), createProjectionDescriptor(albersEqualArea, loadAlbers)
        ]}));
        await Promise.all([adapter.projectPositions(new Float64Array([20, 30]), 'equal-earth'),
            adapter.projectPositions(new Float64Array([20, 30]), 'equal-earth')]);
        expect(loadEqualEarth).toHaveBeenCalledOnce();
        expect(loadAlbers).not.toHaveBeenCalled();
    });
    test.each(['equal-earth', 'albers', 'equirectangular', 'mercator', 'web-mercator'] as const)(
        '%s compiles once across concurrent batches and preserves input and meter conventions', async type => {
            const engine = createEngine();
            const compile = vi.spyOn(engine, 'createProjectionAsync');
            const adapter = new HostProjectionEngineAdapter(engine);
            const input = new Float64Array([-120, 30, -75, 60, 0, 0]);
            const snapshot = input.slice();
            const [first, second] = await Promise.all([adapter.projectPositions(input, type), adapter.projectPositions(input, type)]);
            expect(compile).toHaveBeenCalledExactlyOnceWith(getProjectedCoordinateOptions(type));
            const oracle = engine.createProjection(getProjectedCoordinateOptions(type));
            for (let offset = 0; offset < input.length; offset += 2) {
                const expected = oracle.projectSync([input[offset], input[offset + 1]]);
                expect(first[offset]).toBeCloseTo(expected[0] * PROJECTED_COMMON_SCALE, 10);
                expect(first[offset + 1]).toBeCloseTo(expected[1] * PROJECTED_COMMON_SCALE, 10);
            }
            expect(first).toEqual(second);
            expect(input).toEqual(snapshot);
            adapter.dispose();
            expect(engine.createProjection(getProjectedCoordinateOptions(type)).projectSync([-120, 30])).toHaveLength(2);
            await expect(adapter.projectPositions(input, type)).rejects.toThrow('disposed');
        }
    );

    test.each([{values: [NaN, 0]}, {values: [0, Infinity]}, {values: [181, 0]}, {values: [0, 90]}, {values: [0]}])('rejects malformed degree batches $values before compiling', async ({values}) => {
        const engine = createEngine();
        const compile = vi.spyOn(engine, 'createProjectionAsync');
        await expect(new HostProjectionEngineAdapter(engine).projectPositions(new Float64Array(values), 'equal-earth')).rejects.toThrow('tile domain');
        expect(compile).not.toHaveBeenCalled();
    });

    test('failed asynchronous compilation can be retried without poisoning the cache', async () => {
        const engine = createEngine();
        const compile = vi.spyOn(engine, 'createProjectionAsync');
        compile.mockRejectedValueOnce(new Error('missing grid'));
        const adapter = new HostProjectionEngineAdapter(engine);
        await expect(adapter.projectPositions(new Float64Array([0, 0]), 'equal-earth')).rejects.toThrow('missing grid');
        expect(await adapter.projectPositions(new Float64Array([0, 0]), 'equal-earth')).toEqual(new Float64Array([0, 0]));
        expect(compile).toHaveBeenCalledTimes(2);
    });

    test('disposal rejects a late compilation without invoking the released transform', async () => {
        const engine = createEngine();
        const transform = engine.createProjection(getProjectedCoordinateOptions('equal-earth'));
        const project = vi.spyOn(transform, 'projectFlatSync');
        let finish!: (value: typeof transform) => void;
        vi.spyOn(engine, 'createProjectionAsync').mockReturnValue(new Promise(resolve => {finish = resolve;}));
        const adapter = new HostProjectionEngineAdapter(engine);
        const pending = adapter.projectPositions(new Float64Array([0, 0]), 'equal-earth');
        await Promise.resolve();
        adapter.dispose();
        finish(transform);
        await expect(pending).rejects.toThrow('disposed');
        expect(project).not.toHaveBeenCalled();
    });

    test.each([NaN, Infinity, 1e50])('rejects unrepresentable projected positions %s', async value => {
        const engine = createEngine();
        const transform = engine.createProjection(getProjectedCoordinateOptions('equal-earth'));
        vi.spyOn(transform, 'projectFlatSync').mockImplementation(coordinates => {coordinates[0] = value; return coordinates;});
        vi.spyOn(engine, 'createProjectionAsync').mockResolvedValue(transform);
        await expect(new HostProjectionEngineAdapter(engine).projectPositions(new Float64Array([0, 0]), 'equal-earth')).rejects.toThrow('Float32');
    });

    test('the optional factory contract accepts absence and rejects a single transform', () => {
        expect(() => validateProjectionEngine(undefined)).not.toThrow();
        // @ts-expect-error A transform is deliberately not a ProjectionEngine factory.
        expect(() => validateProjectionEngine(createEngine().createProjection())).toThrow('factory contract');
    });
});
