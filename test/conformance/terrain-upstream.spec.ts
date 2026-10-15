// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {beforeAll, expect, test} from 'vitest';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import type {TerrainHeightGrid} from '../../modules/tangram-renderer/src/map-logic/terrain-data';
import type {TerrainQuerySource} from '../../modules/tangram-renderer/src/map-logic/terrain-query';

/** Explicit built working copies keep this optional cross-repo lane offline and release-independent. */
const loadersRoot = process.env.TANGRAM_TERRAIN_LOADERS_ROOT;
const communityRoot = process.env.TANGRAM_TERRAIN_COMMUNITY_ROOT;
const mathRoot = process.env.TANGRAM_TERRAIN_MATH_ROOT;
const rendererRoot = resolve('modules/tangram-renderer/dist');
let shared: {
    createTerrainHeightGrid(heightmap: {width: number; height: number; heights: Float32Array}, metadata: Pick<TerrainHeightGrid, 'bounds' | 'registration' | 'verticalDatum'>, valid?: Uint8Array): TerrainHeightGrid;
    sampleTerrainHeightGrid(grid: TerrainHeightGrid, position: readonly [number, number]): number | null;
    TerrainHeightField: new(grids: readonly TerrainHeightGrid[], options?: {maxMaskBytes: number}) => {sampleHeight(position: readonly [number, number]): number | null; coversBounds(bounds: readonly [number, number, number, number]): boolean};
    resampleTerrainNodes(grid: TerrainHeightGrid, neighbors?: readonly TerrainHeightGrid[]): TerrainHeightGrid;
};
let retained: {
    sampleTerrainHeight(grid: TerrainHeightGrid, position: readonly [number, number]): number | null;
    TerrainHeightField: new(grids: readonly TerrainHeightGrid[]) => {sampleHeight(position: readonly [number, number]): number | null};
    adaptTerrainQuerySource(source: TerrainQuerySource): TerrainQuerySource;
    resampleTerrainNodes(grid: TerrainHeightGrid, neighbors?: readonly TerrainHeightGrid[]): TerrainHeightGrid;
    TriangleQueryIndex: new(positions: ArrayLike<number>, indices: ArrayLike<number>, leafSize: number, options: {maxHierarchyBytes: number}) => {queryRay(origin: readonly [number, number, number], direction: readonly [number, number, number], maximum: number, accept: (hit: {triangleIndex: number; barycentric: readonly [number, number, number]}) => boolean): {hit: {triangleIndex: number; parameter: number; barycentric: readonly [number, number, number]} | null}};
};
let community: {
    pickTerrainSurface(viewport: {x: number; y: number; width: number; height: number; viewProjectionMatrix: number[]}, pixel: readonly [number, number], source: TerrainQuerySource, transform: number[]): ReturnType<TerrainQuerySource['intersectRay']>;
};
let math: {
    TriangleBVH: new(options: {positions: number[]; indices: number[]; leafSize: number}) => {intersectRay(origin: readonly [number, number, number], direction: readonly [number, number, number], options: {maxDistance: number; acceptHit: (hit: {index: number; barycentric: readonly [number, number, number]}) => boolean}): {index: number; distance: number; barycentric: readonly [number, number, number]} | null};
};

beforeAll(async () => {
    if (!loadersRoot || !communityRoot || !mathRoot) throw new Error('Set TANGRAM_TERRAIN_LOADERS_ROOT, TANGRAM_TERRAIN_COMMUNITY_ROOT and TANGRAM_TERRAIN_MATH_ROOT to built candidate working copies');
    const entries = [resolve(loadersRoot, 'modules/terrain/dist/heightmap.js'), resolve(rendererRoot, 'map-logic.js'), resolve(communityRoot, 'modules/geo-layers/dist/terrain/terrain-query.js'), resolve(mathRoot, 'modules/spatial-index/dist/index.js')];
    for (const entry of entries) if (!existsSync(entry)) throw new Error(`Build the candidate repository first: ${entry}`);
    [shared, retained, community, math] = await Promise.all(entries.map(entry => import(/* @vite-ignore */ pathToFileURL(entry).href)));
});

test.each(['pixel-center', 'grid-node'] as const)('upstream %s fields and seam nodes agree with retained terrain procedures', registration => {
    const grids = [0, 2, 4].map(west => shared.createTerrainHeightGrid({width: 2, height: 2, heights: new Float32Array([west, west + 10, west + 20, west + 30])}, {bounds: [west, 0, west + 2, 2], registration, verticalDatum: 'unknown'}));
    const legacy = new retained.TerrainHeightField(grids);
    for (const maxMaskBytes of [0, 1024]) {
        const field = new shared.TerrainHeightField(grids, {maxMaskBytes});
        for (let horizontal = -2; horizontal <= 50; horizontal++) for (let vertical = -2; vertical <= 18; vertical++) {
            const point: [number, number] = [horizontal / 8, vertical / 8];
            expect(field.sampleHeight(point)).toBe(legacy.sampleHeight(point));
        }
        expect(field.coversBounds([0, 0, 6, 2])).toBe(true);
        expect(field.coversBounds([0, 0, 7, 2])).toBe(false);
    }
    expect(shared.resampleTerrainNodes(grids[1], [grids[0], grids[2]])).toEqual(retained.resampleTerrainNodes(grids[1], [grids[0], grids[2]]));
});

test('upstream accepted-hit rays agree with retained accelerated and exact fallback queries', () => {
    const positions = [0, 0, 3, 2, 0, 3, 0, 2, 3, 0, 0, 1, 2, 0, 1, 0, 2, 1];
    const indices = [0, 1, 2, 3, 4, 5, 0, 1, 2];
    const upstream = new math.TriangleBVH({positions, indices, leafSize: 1});
    for (const maxHierarchyBytes of [0, 1024]) {
        const legacy = new retained.TriangleQueryIndex(positions, indices, 1, {maxHierarchyBytes});
        for (const maximum of [0, 2, 4, Infinity]) for (const rejected of [-1, 0, 1, 2]) for (const horizontal of [0, 0.5, 2, 3]) {
            const origin: [number, number, number] = [horizontal, 0.5, 5], direction: [number, number, number] = [0, 0, -7];
            const hit = legacy.queryRay(origin, direction, maximum / 7, candidate => candidate.triangleIndex !== rejected).hit;
            const candidate = upstream.intersectRay(origin, direction, {maxDistance: maximum, acceptHit: value => value.index !== rejected});
            expect(candidate?.index ?? null).toBe(hit?.triangleIndex ?? null);
            if (hit && candidate) {
                expect(candidate.distance).toBeCloseTo(hit.parameter * 7, 12);
                expect(candidate.barycentric).toEqual(hit.barycentric);
            }
        }
    }
});

test.each(['pixel-center', 'grid-node'] as const)('actual upstream %s grids agree with retained sampling and field behavior', registration => {
    for (const valid of [undefined, new Uint8Array([1, 0, 1, 1]), new Uint8Array(4)]) {
        const grid = shared.createTerrainHeightGrid({width: 2, height: 2, heights: new Float32Array([0, 10, 20, 30])}, {bounds: [0, 0, 2, 2], registration, verticalDatum: 'unknown'}, valid);
        const field = new retained.TerrainHeightField([grid]);
        for (let horizontal = -2; horizontal <= 18; horizontal++) for (let vertical = -2; vertical <= 18; vertical++) {
            const point: [number, number] = [horizontal / 8, vertical / 8];
            const expected = shared.sampleTerrainHeightGrid(grid, point);
            expect(retained.sampleTerrainHeight(grid, point)).toBe(expected);
            expect(field.sampleHeight(point)).toBe(expected);
        }
    }
});

test('actual community routing and Tangram adaptation preserve the same shared provider hit', () => {
    const hit = {position: [0, 0, 0] as const, coordinate: [0, 0, 10] as const, distance: 1, normal: [0, 0, 1] as const, triangleIndex: 7, barycentric: [1, 0, 0] as const};
    const source: TerrainQuerySource = {projection: 'web-mercator', intersectRay(ray, limit = Infinity) {
        expect(ray).toEqual({origin: [0, 0, -1], direction: [0, 0, 2]}); expect(limit).toBe(2); return hit;
    }};
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(community.pickTerrainSurface({x: 200, y: 0, width: 200, height: 100, viewProjectionMatrix: identity}, [300, 50], retained.adaptTerrainQuerySource(source), identity)).toEqual(hit);
});

test('emitted public declarations remain mutually structurally assignable', () => {
    const filename = resolve('test/conformance/virtual-terrain-contract.ts');
    const loaders = JSON.stringify(resolve(loadersRoot!, 'modules/terrain/dist/heightmap.js'));
    const tangram = JSON.stringify(resolve(rendererRoot, 'types/map-logic/index.js'));
    const layer = JSON.stringify(resolve(communityRoot!, 'modules/geo-layers/dist/terrain/terrain-query.js'));
    const source = `import type {TerrainHeightGrid as A, TerrainSurface as S} from ${loaders};
      import type {TerrainHeightGrid as B, TerrainQuerySource as T} from ${tangram};
      import type {TerrainSurface as U} from ${layer};
      export function grids(a:A,b:B):[B,A]{return[a,b]}
      export function queries(s:S,t:T,u:U):[T,U,S,S]{return[s,s,t,u]}`;
    const options: ts.CompilerOptions = {noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler};
    const host = ts.createCompilerHost(options), getSourceFile = host.getSourceFile;
    host.getSourceFile = (path, ...arguments_) => path === filename ? ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true) : getSourceFile(path, ...arguments_);
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
    expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
}, 30000);
