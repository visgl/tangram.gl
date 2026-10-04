// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync, readdirSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const allowlistPath = resolve(import.meta.dirname, 'typescript-migration-allowlist.json');
const suppressionAllowlistPath = resolve(import.meta.dirname, 'typescript-suppression-allowlist.json');
const sourceRoots = [
  resolve(repositoryRoot, 'modules/tangram-renderer/src'),
  resolve(repositoryRoot, 'modules/tangram-layers/src')
];

function collectSourceFiles(directoryPath, extensionPattern) {
  return readdirSync(directoryPath, {withFileTypes: true}).flatMap(directoryEntry => {
    const filePath = join(directoryPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      return collectSourceFiles(filePath, extensionPattern);
    }
    return extensionPattern.test(directoryEntry.name) ? [filePath] : [];
  });
}

function getRepositoryPath(filePath) {
  return relative(repositoryRoot, filePath).split(sep).join('/');
}

const allowedJavaScriptFiles = JSON.parse(readFileSync(allowlistPath, 'utf8'));
const currentJavaScriptFiles = sourceRoots
  .flatMap(directoryPath => collectSourceFiles(directoryPath, /\.(js|mjs)$/))
  .map(getRepositoryPath)
  .sort();
const allowedFileSet = new Set(allowedJavaScriptFiles);
const currentFileSet = new Set(currentJavaScriptFiles);
const addedFiles = currentJavaScriptFiles.filter(filePath => !allowedFileSet.has(filePath));
const migratedFiles = allowedJavaScriptFiles.filter(filePath => !currentFileSet.has(filePath));

if (addedFiles.length > 0 || migratedFiles.length > 0) {
  const diagnostics = [];
  if (addedFiles.length > 0) {
    diagnostics.push(`New JavaScript source files are not permitted:\n${addedFiles.join('\n')}`);
  }
  if (migratedFiles.length > 0) {
    diagnostics.push(
      `Remove migrated files from ${getRepositoryPath(allowlistPath)}:\n${migratedFiles.join('\n')}`
    );
  }
  throw new Error(diagnostics.join('\n\n'));
}

console.log(
  `TypeScript migration scope is valid (${currentJavaScriptFiles.length} legacy JavaScript files remain).`
);

// Keep existing lifecycle suppressions explicit, and never silently reintroduce
// a blanket suppression in a subsystem that has already been checked.
const allowedSuppressions = JSON.parse(readFileSync(suppressionAllowlistPath, 'utf8'));
const currentSuppressions = Object.fromEntries(sourceRoots
  .flatMap(directoryPath => collectSourceFiles(directoryPath, /\.ts$/))
  .map(filePath => [getRepositoryPath(filePath),
    [...readFileSync(filePath, 'utf8').matchAll(/@ts-(?:nocheck|ignore|expect-error)\b/g)].length])
  .filter(([, count]) => count > 0)
  .sort(([first], [second]) => first.localeCompare(second)));
const changedSuppressionFiles = [...new Set([
  ...Object.keys(allowedSuppressions), ...Object.keys(currentSuppressions)
])].filter(filePath => allowedSuppressions[filePath] !== currentSuppressions[filePath]);
if (changedSuppressionFiles.length > 0) {
  throw new Error(`TypeScript suppression baseline changed:\n${changedSuppressionFiles.join('\n')}\n` +
    'Remove resolved entries from scripts/typescript-suppression-allowlist.json; do not add new suppressions.');
}
console.log(`TypeScript suppression scope is valid (${Object.values(currentSuppressions)
  .reduce((total, count) => total + count, 0)} directives remain).`);
