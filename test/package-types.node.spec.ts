// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {resolve} from 'node:path';
import ts from 'typescript';
import {expect, test} from 'vitest';

test.each([ts.ModuleKind.Node16, ts.ModuleKind.NodeNext])('public layer declarations work in module mode %s without the optional projection peer', module => {
  const fileName = resolve('test/package-types.consumer.mts');
  const source = `
    import {TangramLayer} from '@tangram.gl/tangram-layers';
    import {hillshade, triplanar, planar, sphereMap, heightDecode, globeHorizon} from '@tangram.gl/tangram-renderer/experimental/shader-modules';
    import type {ShaderModule} from '@luma.gl/shadertools';
    const shaderModule: ShaderModule = hillshade;
    const materialModules: ShaderModule[] = [triplanar, planar, sphereMap, heightDecode, globeHorizon];
    import {ProjectionBatchExecutor, Renderer, TerrainMeshSurface, TerrainSurfaceCollection, sampleTerrainElevation, resolveTerrainClearance} from '@tangram.gl/tangram-renderer/core';
    import type {TerrainCollectionHit, TerrainElevationProbe} from '@tangram.gl/tangram-renderer';
    const surface = new TerrainMeshSurface({projection: 'web-mercator', positions: [], indices: []});
    const collection = new TerrainSurfaceCollection('web-mercator', [{id: 'tile', surface}]);
    const terrainHit: TerrainCollectionHit | null = collection.intersectSegment([0, 0, 10], [0, 0, 0], {endInset: 0.001});
    const surfaceIdentity: string | undefined = terrainHit?.surfaceId;
    const elevationProbe: TerrainElevationProbe = {minimumAltitude: -12000, maximumAltitude: 50000};
    sampleTerrainElevation(collection, [0, 0], elevationProbe);
    resolveTerrainClearance(collection, [0, 0, 1], 2, elevationProbe);
    import {ProjectedBasemapNavigation} from '@tangram.gl/tangram-layers/experimental/projected-basemaps';
    import {GlobeTerrainLayer} from '@tangram.gl/tangram-layers/experimental/terrain';
    import type {TerrainHeightGrid} from '@tangram.gl/tangram-renderer/map-logic';
    const heightGrids: TerrainHeightGrid[] = [];
    const terrain = new GlobeTerrainLayer({data: heightGrids, globeTerrainExaggeration: 100});
    terrain.sampleElevation([0, 0]); terrain.intersectTerrainSegment([0, -400, 0], [0, 400, 0]);
    import type {RendererOptions, ProjectionEngine, ProjectionExecutionStatistics} from '@tangram.gl/tangram-renderer/core';
    import {resolveLabelPlacement, TileBuildQueue, TileCachePolicy, TileResidency} from '@tangram.gl/tangram-renderer/map-logic';
    import type {ScreenLabelCandidate, TileCacheRecord, TileCacheOptions, TileCacheStatistics} from '@tangram.gl/tangram-renderer/map-logic';
    const residency = new TileResidency<string>();
    residency.updateConsumer('eye', ['tile'], []);
    const cacheRecord: TileCacheRecord = {key: 'tile', bytes: 100, protected: residency.isProtected('tile')};
    const cacheOptions: TileCacheOptions = {maxCachedBytes: 0};
    const policy = new TileCachePolicy();
    policy.selectEvictions([cacheRecord], cacheOptions);
    const cacheStatistics: TileCacheStatistics = policy.getStatistics([cacheRecord]);
    const labels: ScreenLabelCandidate[] = [{id: 'city', boxes: new Map([['map', [0, 0, 20, 20]]])}];
    const visible: boolean | undefined = resolveLabelPlacement(labels, {
      viewports: new Map([['map', {width: 800, height: 600}]])
    }).get(labels[0]);
    new TileBuildQueue().setLimit(2);
    const options: RendererOptions = {};
    const engine: ProjectionEngine = {
      createProjection: () => ({projectFlatSync: positions => positions}),
      createProjectionAsync: async () => ({projectFlatSync: positions => positions})
    };
    new TangramLayer({scene: 'scene.yaml', projectionEngine: engine});
    new TangramLayer({scene: 'scene.yaml'});
    // @ts-expect-error A transform is not a factory; the optional-peer-free type must not become any.
    new TangramLayer({scene: 'scene.yaml', projectionEngine: {projectSync: () => []}});
    options.projectionEngine = engine;
    options.projectionEngineExecution = {maxBatchPositions: 256};
    new TangramLayer({scene: 'scene.yaml', projectionEngine: engine, projectionEngineExecution: options.projectionEngineExecution});
    const renderer = Renderer.create({}, options);
    const statistics: ProjectionExecutionStatistics | undefined = renderer.getProjectionEngineStatistics();
    const navigation = new ProjectedBasemapNavigation(engine, options.projectionEngineExecution);
    navigation.projectPositions(new Float64Array([0, 0]), 'equal-earth', {signal: new AbortController().signal});
    new ProjectionBatchExecutor(options.projectionEngineExecution).execute(new Float64Array([0, 0]),
      () => engine.createProjectionAsync(), {signal: new AbortController().signal});
  `;
  const options: ts.CompilerOptions = {module, moduleResolution: module === ts.ModuleKind.Node16 ?
    ts.ModuleResolutionKind.Node16 : ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, skipLibCheck: true};
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => path === fileName ?
    ts.createSourceFile(path, source, languageVersion, true) : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const optionalPeerRequests: string[] = [];
  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, compilerOptions, containingSourceFile) => literals.map(literal => {
    if (literal.text.startsWith('@math.gl/geospatial/projection')) {
      optionalPeerRequests.push(literal.text);
      return {resolvedModule: undefined};
    }
    return {resolvedModule: ts.resolveModuleName(literal.text, containingFile, compilerOptions, host,
      undefined, redirectedReference, ts.getModeForUsageLocation(containingSourceFile, literal, compilerOptions)).resolvedModule};
  });
  const program = ts.createProgram([fileName], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  expect(diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  expect(optionalPeerRequests).toEqual([]);
  const entry = program.getSourceFiles().find(file => file.fileName.endsWith('/tangram-layers/dist/types/index.d.ts'));
  expect(entry).toBeDefined();
});
