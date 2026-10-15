// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {copyExampleAssets, copyBrowserMathAssets} from '../website/scripts/copy-example-assets.mjs';
import {MATH_BROWSER_ASSETS} from '../examples/browser-dependencies/math-assets.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

test.each(['complete', 'core.js', 'THIRD-PARTY-NOTICES.txt', 'empty'])('browser math copy validates all artifacts before publishing: %s', async missing => {
  const directory = await mkdtemp(join(tmpdir(), 'tangram-browser-math-copy-'));
  temporaryDirectories.push(directory);
  const source = join(directory, 'dist'), destination = join(directory, 'static');
  await mkdir(source);
  const filenames = [...Object.values(MATH_BROWSER_ASSETS), 'THIRD-PARTY-NOTICES.txt'];
  for (const filename of filenames) {
    if (filename !== missing) await writeFile(join(source, filename), missing === 'empty' && filename === 'core.js' ? '' : filename);
  }
  if (missing !== 'complete') {
    await expect(copyBrowserMathAssets(source, destination)).rejects.toThrow();
    await expect(readFile(join(destination, 'core.js'))).rejects.toMatchObject({code: 'ENOENT'});
    return;
  }
  await copyBrowserMathAssets(source, destination);
  for (const filename of filenames) expect(await readFile(join(destination, filename), 'utf8')).toBe(filename);
});

test.each(['classic', 'deck', 'webxr', 'projected', 'terrain'])('%s assets do not shadow the integrated example route', async example => {
  const directory = await mkdtemp(join(tmpdir(), 'tangram-website-assets-'));
  temporaryDirectories.push(directory);
  const source = join(directory, example);
  const destination = join(directory, 'static', example);
  await mkdir(join(source, 'styles'), {recursive: true});
  await writeFile(join(source, 'index.html'), '<html>Standalone example</html>');
  await writeFile(join(source, 'main.js'), 'const example = true;');
  await writeFile(join(source, 'styles', 'index.html'), 'Nested asset');

  await copyExampleAssets(source, destination);

  // A directory index wins over classic.html in Docusaurus's preview server.
  // Omitting it lets the clean route retain its base URL, scene query and hash.
  await expect(readFile(join(destination, 'index.html'))).rejects.toMatchObject({code: 'ENOENT'});
  expect(await readFile(join(destination, 'main.js'), 'utf8')).toBe('const example = true;');
  expect(await readFile(join(destination, 'styles', 'index.html'), 'utf8')).toBe('Nested asset');
  expect(await readFile(join(source, 'index.html'), 'utf8')).toContain('Standalone example');
});
