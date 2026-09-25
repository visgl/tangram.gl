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
      rendererSourcePath
    });
    expect(diagnostics.invalidCoverageFiles).toEqual([]);
    expect(diagnostics.missingCoverageFiles).toEqual([secondSource]);
  });

  test('rejects files outside the renderer source tree', () => {
    const generatedFile = '/workspace/modules/tangram-renderer/dist/bundle.js';
    const diagnostics = getCoverageScopeDiagnostics({
      authoredSourceFiles: [firstSource],
      coverageSummary: {total: {}, [firstSource]: {}, [generatedFile]: {}},
      rendererSourcePath
    });
    expect(diagnostics.invalidCoverageFiles).toEqual([generatedFile]);
    expect(diagnostics.missingCoverageFiles).toEqual([]);
  });

  test('accepts an exact renderer source inventory', () => {
    const diagnostics = getCoverageScopeDiagnostics({
      authoredSourceFiles: [firstSource, secondSource],
      coverageSummary: {total: {}, [firstSource]: {}, [secondSource]: {}},
      rendererSourcePath
    });
    expect(diagnostics.invalidCoverageFiles).toEqual([]);
    expect(diagnostics.missingCoverageFiles).toEqual([]);
  });

  test('collects JavaScript and TypeScript sources but ignores declarations', () => {
    const sourceFiles = collectAuthoredSourceFiles('modules/tangram-renderer/src');
    expect(sourceFiles).toHaveLength(107);
    expect(sourceFiles.some(filePath => filePath.endsWith('index.d.ts'))).toBe(false);
  });
});
