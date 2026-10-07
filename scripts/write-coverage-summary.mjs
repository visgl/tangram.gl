// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import {COVERAGE_MODULES, summarizeModuleCoverage} from './coverage-modules.mjs';

/** Formats the merged Vitest summary as a GitHub Actions job summary table. */
export function formatCoverageTable(summary) {
  const metrics = [
    ['Statements', summary.statements],
    ['Branches', summary.branches],
    ['Functions', summary.functions],
    ['Lines', summary.lines]
  ];
  const rows = metrics.map(([name, metric]) => `| ${name} | ${metric.pct}% | ${metric.covered}/${metric.total} |`);
  return [
    '| Metric | Coverage | Covered |',
    '| --- | ---: | ---: |',
    ...rows,
    ''
  ].join('\n');
}

/** Report each package separately so a combined total cannot conceal a regression. */
export function formatCoverageSummary(coverageSummary) {
  return [
    '## Module coverage', '',
    'Merged Node and Chromium coverage. Each module has an independent coverage gate.', '',
    ...COVERAGE_MODULES.flatMap(module => {
      const summary = summarizeModuleCoverage(coverageSummary, module.sourcePath);
      return [`### ${module.name}`, '', `Source: \`${module.sourcePath}\` (including experimental subpaths).`, '',
        summary ? formatCoverageTable(summary) : 'Coverage data is missing for this module.', ''];
    }),
    '### Combined', '',
    coverageSummary.total ? formatCoverageTable(coverageSummary.total) : 'Combined coverage data is missing.', ''
  ].join('\n');
}

const summaryPath = 'coverage/coverage-summary.json';
const outputPath = process.env.GITHUB_STEP_SUMMARY;
if (outputPath && existsSync(summaryPath)) {
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  appendFileSync(outputPath, formatCoverageSummary(summary));
}
