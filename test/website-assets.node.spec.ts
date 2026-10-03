// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {copyExampleAssets} from '../website/scripts/copy-example-assets.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));
});

test.each(['classic', 'deck', 'webxr'])('%s assets do not shadow the integrated example route', async example => {
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
