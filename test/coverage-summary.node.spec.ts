// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, expect, test} from 'vitest';
import {resolve} from 'node:path';
import {COVERAGE_MODULES, summarizeModuleCoverage} from '../scripts/coverage-modules.mjs';
import {formatCoverageSummary} from '../scripts/write-coverage-summary.mjs';

/** Synthetic Istanbul summary with deliberately uneven file sizes. */
function metrics(covered: number, total: number) {
  return Object.fromEntries(['statements', 'branches', 'functions', 'lines'].map(metric =>
    [metric, {covered, total, skipped: 0, pct: total ? covered * 100 / total : 100}]));
}

describe('independent module coverage reports', () => {
  test('preserves the existing renderer gates independently of the layers package', () => {
    expect(COVERAGE_MODULES[0]).toMatchObject({name: 'tangram-renderer',
      thresholds: {statements: 78, branches: 69, functions: 82, lines: 78}});
    expect(new Set(COVERAGE_MODULES.map(module => module.sourceGlob)).size).toBe(2);
    expect(COVERAGE_MODULES.every(module => Object.keys(module.thresholds).length === 4)).toBe(true);
  });

  test('sums covered counters, includes zero-hit files, and isolates sibling packages', () => {
    const sourcePath = COVERAGE_MODULES[1].sourcePath;
    const summary = {
      total: metrics(999, 999),
      [resolve(sourcePath, 'small.ts')]: metrics(1, 1),
      [resolve(sourcePath, 'experimental/webxr/large.ts')]: metrics(0, 9),
      [resolve(`${sourcePath}-old`, 'ignored.ts')]: metrics(100, 100),
      [resolve(COVERAGE_MODULES[0].sourcePath, 'ignored.ts')]: metrics(100, 100)
    };
    expect(summarizeModuleCoverage(summary, sourcePath)).toEqual(metrics(1, 10));
  });

  test('distinguishes absent module coverage from empty type-only metrics', () => {
    const sourcePath = COVERAGE_MODULES[1].sourcePath;
    expect(summarizeModuleCoverage({total: metrics(10, 10)}, sourcePath)).toBeNull();
    expect(summarizeModuleCoverage({[resolve(sourcePath, 'types.ts')]: metrics(0, 0)}, sourcePath))
      .toEqual(metrics(0, 0));
    expect(summarizeModuleCoverage({[resolve(sourcePath, 'partial.ts')]: metrics(1, 3)}, sourcePath)
      ?.lines.pct).toBe(33.33);
  });

  test('renders real Markdown with separate package tables and an honest missing-data notice', () => {
    const report = formatCoverageSummary({total: metrics(1, 10),
      [resolve(COVERAGE_MODULES[1].sourcePath, 'layer.ts')]: metrics(1, 10)});
    expect(report).toContain('### tangram-renderer\n');
    expect(report).toContain('Coverage data is missing for this module.');
    expect(report).toContain('### tangram-layers\n');
    expect(report).toContain('| Lines | 10% | 1/10 |');
    expect(report).toContain('### Combined\n');
    expect(report).not.toContain('\\n');
  });
});
