// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {
  collectAuthoredSourceFiles,
  getCoverageScopeDiagnostics
} from '../scripts/check-coverage-scope.mjs';

const rendererSourcePath = '/workspace/modules/tangram-renderer/src';
const firstSource = `${rendererSourcePath}/first.js`;
const secondSource = `${rendererSourcePath}/nested/second.ts`;

describe('coverage scope guard', () => {
  test('requires every authored renderer source file', () => {
    const diagnostics = getCoverageScopeDiagnostics({
      authoredSourceFiles: [firstSource, secondSource],
      coverageSummary: {total: {}, [firstSource]: {}},
      sourcePaths: [rendererSourcePath]
    });
    expect(diagnostics.invalidCoverageFiles).toEqual([]);
    expect(diagnostics.missingCoverageFiles).toEqual([secondSource]);
  });

  test('rejects files outside the renderer source tree', () => {
    const generatedFile = '/workspace/modules/tangram-renderer/dist/bundle.js';
    const diagnostics = getCoverageScopeDiagnostics({
      authoredSourceFiles: [firstSource],
      coverageSummary: {total: {}, [firstSource]: {}, [generatedFile]: {}},
      sourcePaths: [rendererSourcePath]
    });
    expect(diagnostics.invalidCoverageFiles).toEqual([generatedFile]);
    expect(diagnostics.missingCoverageFiles).toEqual([]);
  });

  test('accepts an exact renderer source inventory', () => {
    const diagnostics = getCoverageScopeDiagnostics({
      authoredSourceFiles: [firstSource, secondSource],
      coverageSummary: {total: {}, [firstSource]: {}, [secondSource]: {}},
      sourcePaths: [rendererSourcePath]
    });
    expect(diagnostics.invalidCoverageFiles).toEqual([]);
    expect(diagnostics.missingCoverageFiles).toEqual([]);
  });

  test('collects JavaScript and TypeScript sources but ignores declarations', () => {
    const sourceFiles = collectAuthoredSourceFiles('modules/tangram-renderer/src');
    expect(sourceFiles).toHaveLength(159);
    expect(sourceFiles.some(filePath => filePath.endsWith('experimental/projected-mesh.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('procedures/mesh-projector.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('builders/geometry-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('gl/vertex-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('gl/mesh-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('styles/geometry-style-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('labels/label-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('labels/main-pass-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('styles/text/text-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('styles/property-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('styles/layer-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('styles/style-mixing-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('labels/collision-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('scene/scene-resource-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('sources/tile_source_adapter.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('tile/tangram_tileset_2d.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('tile/tile_build_queue.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('tile/tile_resource_cache.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('tile/globe_tile_preload.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('lights/light-definitions.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('utils/worker-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('selection/selection-types.ts'))).toBe(true);
    expect(sourceFiles.some(filePath => filePath.endsWith('index.d.ts'))).toBe(false);
    const layerFiles = collectAuthoredSourceFiles('modules/tangram-layers/src');
    expect(layerFiles).toHaveLength(15);
    expect(layerFiles.some(filePath => filePath.endsWith('experimental/projected-basemaps.ts'))).toBe(true);
    expect(layerFiles.some(filePath => filePath.endsWith('experimental/webxr/grabbing.ts'))).toBe(true);
    expect(layerFiles.some(filePath => filePath.endsWith('.d.ts'))).toBe(false);
  });

  test('requires both modules including experimental WebXR and type-only sources', () => {
    const layersSourcePath = '/workspace/modules/tangram-layers/src';
    const grabbing = `${layersSourcePath}/experimental/webxr/grabbing.ts`;
    const types = `${layersSourcePath}/view_adapter_types.ts`;
    const diagnostics = getCoverageScopeDiagnostics({
      authoredSourceFiles: [firstSource, grabbing, types],
      coverageSummary: {total: {}, [firstSource]: {}, [grabbing]: {}},
      sourcePaths: [rendererSourcePath, layersSourcePath]
    });
    expect(diagnostics.invalidCoverageFiles).toEqual([]);
    expect(diagnostics.missingCoverageFiles).toEqual([types]);
  });

  test.each(['dist/bundle.js', 'src/vendor/library.js', 'src/index.d.ts', 'src-old/index.ts'])
    ('rejects generated, declaration, vendored, and sibling paths: %s', suffix => {
      const filePath = `/workspace/modules/tangram-layers/${suffix}`;
      const diagnostics = getCoverageScopeDiagnostics({
        authoredSourceFiles: [], coverageSummary: {total: {}, [filePath]: {}},
        sourcePaths: [rendererSourcePath, '/workspace/modules/tangram-layers/src']
      });
      expect(diagnostics.invalidCoverageFiles).toEqual([filePath]);
    });
});
