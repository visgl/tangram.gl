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
const rendererRoot = resolve('modules/tangram-renderer/dist');
let shared: {
    createTerrainHeightGrid(heightmap: {width: number; height: number; heights: Float32Array}, metadata: Pick<TerrainHeightGrid, 'bounds' | 'registration' | 'verticalDatum'>, valid?: Uint8Array): TerrainHeightGrid;
    sampleTerrainHeightGrid(grid: TerrainHeightGrid, position: readonly [number, number]): number | null;
};
let retained: {
    sampleTerrainHeight(grid: TerrainHeightGrid, position: readonly [number, number]): number | null;
    TerrainHeightField: new(grids: readonly TerrainHeightGrid[]) => {sampleHeight(position: readonly [number, number]): number | null};
    adaptTerrainQuerySource(source: TerrainQuerySource): TerrainQuerySource;
};
let community: {
    pickTerrainSurface(viewport: {x: number; y: number; width: number; height: number; viewProjectionMatrix: number[]}, pixel: readonly [number, number], source: TerrainQuerySource, transform: number[]): ReturnType<TerrainQuerySource['intersectRay']>;
};

beforeAll(async () => {
    if (!loadersRoot || !communityRoot) throw new Error('Set TANGRAM_TERRAIN_LOADERS_ROOT and TANGRAM_TERRAIN_COMMUNITY_ROOT to built candidate working copies');
    const entries = [resolve(loadersRoot, 'modules/terrain/dist/heightmap.js'), resolve(rendererRoot, 'map-logic.js'), resolve(communityRoot, 'modules/geo-layers/dist/terrain/terrain-query.js')];
    for (const entry of entries) if (!existsSync(entry)) throw new Error(`Build the candidate repository first: ${entry}`);
    [shared, retained, community] = await Promise.all(entries.map(entry => import(/* @vite-ignore */ pathToFileURL(entry).href)));
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
