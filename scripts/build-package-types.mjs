// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve, relative} from 'node:path';
import ts from 'typescript';

const repositoryDirectory = resolve(import.meta.dirname, '..');
const packageDirectory = resolve(repositoryDirectory, process.argv[2]);
const sourceDirectory = resolve(packageDirectory, 'src');
const outputDirectory = resolve(packageDirectory, 'dist/types');
const configurationPath = resolve(repositoryDirectory, 'tsconfig.json');
const configuration = ts.readConfigFile(configurationPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, repositoryDirectory);
const entryPaths = process.argv.slice(3).map(entry => resolve(sourceDirectory, entry));
const ambientPaths = [...ts.sys.readDirectory(resolve(repositoryDirectory, 'types'), ['.d.ts']),
  ...(process.argv[2] === 'modules/tangram-renderer' ? ts.sys.readDirectory(sourceDirectory, ['.d.ts']) : [])];
const options = {...parsed.options, allowJs: false, noEmit: false, declaration: true,
  emitDeclarationOnly: true, rootDir: sourceDirectory, outDir: outputDirectory,
  ...(process.argv[2] === 'modules/tangram-renderer' ? {paths: {
    '@vis.gl/tangram-renderer': [resolve(sourceDirectory, 'index.d.ts')],
    '@vis.gl/tangram-renderer/core': [resolve(sourceDirectory, 'core.d.ts')]
  }} : {})};
const program = ts.createProgram([...ambientPaths, ...entryPaths], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => repositoryDirectory, getCanonicalFileName: path => path,
    getNewLine: () => '\n'
  }));
  process.exit(1);
}
const emitted = program.emit();
if (emitted.emitSkipped || emitted.diagnostics.length) {
  throw new Error('Public declaration generation failed');
}

// Existing handwritten entry declarations are inputs, not emitted by TypeScript.
for (const source of program.getSourceFiles()) {
  if (source.isDeclarationFile && source.fileName.startsWith(`${sourceDirectory}/`)) {
    const destination = resolve(outputDirectory, relative(sourceDirectory, source.fileName));
    mkdirSync(dirname(destination), {recursive: true});
    writeFileSync(destination, source.text);
  }
}

// Bundler-mode source imports may omit extensions. Public ESM declarations must
// resolve in Node16/NodeNext without requiring consumers to compile implementation files.
for (const path of ts.sys.readDirectory(outputDirectory, ['.d.ts'])) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const replacements = [];
  /** Rewrite only module specifiers, never arbitrary string literal types or documentation. */
  function visit(node) {
    if (ts.isStringLiteral(node) && /^\.{1,2}\//.test(node.text) && !/\.[a-z]+$/i.test(node.text) &&
      ((ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) ||
        (ts.isLiteralTypeNode(node.parent) && ts.isImportTypeNode(node.parent.parent)))) {
      replacements.push({start: node.getStart(source), end: node.end, text: JSON.stringify(`${node.text}.js`)});
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let contents = source.text;
  for (const replacement of replacements.sort((first, second) => second.start - first.start)) {
    contents = contents.slice(0, replacement.start) + replacement.text + contents.slice(replacement.end);
  }
  writeFileSync(path, contents);
}
