// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {resolve} from 'node:path';
import ts from 'typescript';
import {expect, test} from 'vitest';

test.each([ts.ModuleKind.Node16, ts.ModuleKind.NodeNext])('public layer declarations work in module mode %s without the optional projection peer', module => {
  const fileName = resolve('test/package-types.consumer.mts');
  const source = `
    import {TangramLayer} from '@vis.gl/tangram-layers';
    import type {RendererOptions, ProjectionEngine} from '@vis.gl/tangram-renderer/core';
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
    if (literal.text.startsWith('@math.gl/projection')) {
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
