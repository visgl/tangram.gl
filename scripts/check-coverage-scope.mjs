// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {COVERAGE_MODULES, isWithinSourcePath} from './coverage-modules.mjs';

const generatedPathPattern = new RegExp(`(?:^|[\\${sep}])(build|dist|node_modules|vendor)(?:[\\${sep}]|$)`);

export function collectAuthoredSourceFiles(directoryPath) {
  return readdirSync(directoryPath, {withFileTypes: true}).flatMap(directoryEntry => {
    const filePath = join(directoryPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      return collectAuthoredSourceFiles(filePath);
    }
    if (/\.(js|ts)$/.test(directoryEntry.name) && !directoryEntry.name.endsWith('.d.ts')) {
      return [resolve(filePath)];
    }
    return [];
  });
}

export function getCoverageScopeDiagnostics({
  authoredSourceFiles,
  coverageSummary,
  sourcePaths
}) {
  const coverageFiles = Object.keys(coverageSummary).filter(filePath => filePath !== 'total');
  const absoluteCoverageFiles = coverageFiles.map(filePath => resolve(filePath));
  const invalidCoverageFiles = absoluteCoverageFiles.filter(absoluteFilePath => {
    return (
      !sourcePaths.some(sourcePath => isWithinSourcePath(absoluteFilePath, sourcePath)) ||
      generatedPathPattern.test(absoluteFilePath) ||
      absoluteFilePath.endsWith('.d.ts')
    );
  });
  const coveredFiles = new Set(absoluteCoverageFiles);
  const missingCoverageFiles = authoredSourceFiles
    .map(filePath => resolve(filePath))
    .filter(filePath => !coveredFiles.has(filePath));

  return {coverageFiles, invalidCoverageFiles, missingCoverageFiles};
}

function main() {
  const coveragePath = resolve('coverage/coverage-summary.json');
  const sourcePaths = COVERAGE_MODULES.map(module => resolve(module.sourcePath));
  if (!existsSync(coveragePath)) {
    throw new Error(`Coverage summary not found: ${coveragePath}`);
  }

  const coverageSummary = JSON.parse(readFileSync(coveragePath, 'utf8'));
  const authoredSourceFiles = sourcePaths.flatMap(collectAuthoredSourceFiles);
  const {coverageFiles, invalidCoverageFiles, missingCoverageFiles} = getCoverageScopeDiagnostics({
    authoredSourceFiles,
    coverageSummary,
    sourcePaths
  });

  if (invalidCoverageFiles.length > 0) {
    throw new Error(
      `Coverage includes files outside authored module source:\n${invalidCoverageFiles.join('\n')}`
    );
  }
  if (missingCoverageFiles.length > 0) {
    throw new Error(
      `Coverage omits authored module source files:\n${missingCoverageFiles.join('\n')}`
    );
  }

  console.log(`Coverage scope is valid (${coverageFiles.length} source files across ${sourcePaths.length} modules).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
