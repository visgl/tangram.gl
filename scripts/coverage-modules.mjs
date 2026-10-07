// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {isAbsolute, relative, resolve, sep} from 'node:path';

/** Independent package coverage gates; one package cannot hide another's regression. */
export const COVERAGE_MODULES = [
  {
    name: 'tangram-renderer',
    sourcePath: 'modules/tangram-renderer/src',
    sourceGlob: 'modules/tangram-renderer/src/**/*.{js,ts}',
    thresholds: {statements: 78, branches: 69, functions: 82, lines: 78}
  },
  {
    name: 'tangram-layers',
    sourcePath: 'modules/tangram-layers/src',
    sourceGlob: 'modules/tangram-layers/src/**/*.{js,ts}',
    thresholds: {statements: 92, branches: 90, functions: 95, lines: 94}
  }
];

/** Whether a reported file is inside a source directory, not a similarly named sibling. */
export function isWithinSourcePath(filePath, sourcePath) {
  const relativePath = relative(resolve(sourcePath), resolve(filePath));
  return Boolean(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

/** Sum file counters rather than averaging percentages, preserving uncovered source. */
export function summarizeModuleCoverage(coverageSummary, sourcePath) {
  const summaries = Object.entries(coverageSummary)
    .filter(([filePath]) => filePath !== 'total' && isWithinSourcePath(filePath, sourcePath))
    .map(([, summary]) => summary);
  if (!summaries.length) return null;
  return Object.fromEntries(['statements', 'branches', 'functions', 'lines'].map(metric => {
    const counters = summaries.reduce((result, summary) => ({
      total: result.total + summary[metric].total,
      covered: result.covered + summary[metric].covered,
      skipped: result.skipped + summary[metric].skipped
    }), {total: 0, covered: 0, skipped: 0});
    // Istanbul truncates percentages to two decimal places; empty metrics are fully covered.
    const pct = counters.total ? Math.floor(10000 * counters.covered / counters.total) / 100 : 100;
    return [metric, {...counters, pct}];
  }));
}
