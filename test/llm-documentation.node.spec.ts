// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {getSidebarMarkdownPaths, normalizeLlmMarkdown, prepareLlmOutput} from '../website/scripts/llm-output.mjs';

const config = {url: 'https://vis.gl', baseUrl: '/tangram.gl/', title: 'tangram.gl'};
const directories: string[] = [];
const require = createRequire(import.meta.url);

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

/** Small offline site fixture reproduces the stable plugin's subpath duplication. */
function createFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tangram-llm-docs-'));
  directories.push(directory);
  mkdirSync(join(directory, 'docs/api-reference'), {recursive: true});
  mkdirSync(join(directory, 'docs/get-started'), {recursive: true});
  writeFileSync(join(directory, 'llms.txt'), '# tangram.gl\n\n> Current renderer and layer documentation.\n\n## tangram.gl\n\n### docs\n\n' +
    '[Overview](https://vis.gl/tangram.gl/tangram.gl/docs.md)\n' +
    '[Getting started](https://vis.gl/tangram.gl/tangram.gl/docs/get-started/getting-started.md)\n' +
    '[Styling](https://vis.gl/tangram.gl/tangram.gl/docs/api-reference/styling.md)\n');
  writeFileSync(join(directory, 'docs.md'), '# Overview\n\nCurrent renderer documentation, with [styling](https://vis.gl/tangram.gl/tangram.gl/docs/api-reference/styling.md).\n');
  writeFileSync(join(directory, 'docs/get-started/getting-started.md'), '# Getting started\n\nRead the [styling reference](../api-reference/styling.md#sources) before implementing a scene.\n');
  writeFileSync(join(directory, 'docs/api-reference/styling.md'), '# Styling\n\nBoth supported representations must survive rendered tab extraction.\n\n```yaml\nsources: {}\n```\n\n```json\n{"sources": {}}\n```\n');
  return directory;
}

test('normalizes canonical URLs and hierarchy once, preserving document headings', () => {
  const directory = createFixture();
  expect(prepareLlmOutput(directory, config, ['docs.md', 'docs/api-reference/styling.md'])).toBe(3);
  const index = readFileSync(join(directory, 'llms.txt'), 'utf8');
  expect(index).toContain('## docs\n');
  expect(index).not.toContain('## tangram.gl');
  expect(index).not.toContain('/tangram.gl/tangram.gl/');
  expect(readFileSync(join(directory, 'docs.md'), 'utf8')).toContain('https://vis.gl/tangram.gl/docs/api-reference/styling.md');
  expect(prepareLlmOutput(directory, config)).toBe(3);
  expect(readFileSync(join(directory, 'llms.txt'), 'utf8')).toBe(index);
  expect(normalizeLlmMarkdown('# Page\n\n## Heading\n', config)).toBe('# Page\n\n## Heading\n');
});

test.each([
  ['/', '# tangram.gl\n\n## docs\n'],
  ['/nested/tangram.gl/', '# tangram.gl\n\n## nested\n\n### tangram.gl\n\n#### docs\n']
])('handles %s deployment hierarchy', (baseUrl, index) => {
  expect(normalizeLlmMarkdown(index, {...config, baseUrl}, true)).toBe('# tangram.gl\n\n## docs\n');
});

test('sidebar inventory covers overview, nested categories and explicit document IDs', () => {
  expect(getSidebarMarkdownPaths([{type: 'category', items: ['README', {type: 'category', items: [
    {type: 'doc', id: 'api-reference/host-frame'}, 'developer-guide/working-with-ai'
  ]}]}])).toEqual(['docs.md', 'docs/api-reference/host-frame.md', 'docs/developer-guide/working-with-ai.md']);
});

test('requires every sidebar document in the generated index', () => {
  expect(() => prepareLlmOutput(createFixture(), config, ['docs/api-reference/host-frame.md'])).toThrow(/missing sidebar page/);
});

test.each([
  ['examples', '[Example](https://vis.gl/tangram.gl/examples/deck.md)\n', /examples must not be indexed/],
  ['missing output', '[Missing](https://vis.gl/tangram.gl/docs/missing.md)\n', /missing indexed Markdown/],
  ['external host', '[Wrong host](https://visgl.github.io/tangram.gl/docs.md)\n', /noncanonical index URL/],
  ['outside base', '[Wrong base](https://vis.gl/docs.md)\n', /noncanonical index URL/]
])('rejects %s in the index', (_name, link, message) => {
  const directory = createFixture();
  const path = join(directory, 'llms.txt');
  writeFileSync(path, readFileSync(path, 'utf8') + link);
  expect(() => prepareLlmOutput(directory, config)).toThrow(message);
});

test.each([
  ['broken link', '# Overview\n\nThis document contains a [broken link](docs/missing.md).\n', /broken Markdown link/],
  ['MDX', '# Overview\n\nThe extraction incorrectly left <DeckExample /> instead of rendered content.\n', /unprocessed MDX/],
  ['empty extraction', '# Overview\n', /empty extracted document/],
  ['escape', '# Overview\n\nThis document contains an [escaping link](../outside.md).\n', /outside the website base/]
])('rejects %s in extracted content', (_name, content, message) => {
  const directory = createFixture();
  writeFileSync(join(directory, 'docs.md'), content);
  expect(() => prepareLlmOutput(directory, config)).toThrow(message);
});

test('code samples and external links are not mistaken for broken local Markdown', () => {
  const directory = createFixture();
  writeFileSync(join(directory, 'docs.md'), '# Overview\n\n[External](https://example.test/document.md)\n\n```markdown\n[Example](missing.md)\n```\n');
  expect(prepareLlmOutput(directory, config)).toBe(3);
});

test('rejects a full-text dump and incomplete YAML/JSON tab extraction', () => {
  const directory = createFixture();
  writeFileSync(join(directory, 'llms-full.txt'), 'Do not generate a full-text dump.');
  expect(() => prepareLlmOutput(directory, config)).toThrow(/llms-full.txt/);
  rmSync(join(directory, 'llms-full.txt'));
  writeFileSync(join(directory, 'docs/api-reference/styling.md'), '# Styling\n\nOnly one format survived extraction.\n\n```yaml\nsources: {}\n```\n');
  expect(() => prepareLlmOutput(directory, config)).toThrow(/both YAML and JSON/);
});

test('production build uses the same site origin, exclusions and no full-text output', () => {
  const websiteConfig = require('../website/docusaurus.config.js');
  const plugin = websiteConfig.plugins.find((entry: unknown[]) => entry[0] === '@signalwire/docusaurus-plugin-llms-txt');
  expect(websiteConfig.url).toBe(config.url);
  expect(websiteConfig.baseUrl).toBe(config.baseUrl);
  expect(plugin[1]).toMatchObject({onRouteError: 'throw', content: {
    enableMarkdownFiles: true, enableLlmsFullTxt: false, relativePaths: false,
    includePages: false, includeVersionedDocs: false,
    excludeRoutes: ['/tangram.gl/examples/**', '/tangram.gl/docs/examples/**']
  }});
  const sidebar = require('../website/sidebars.js');
  expect(getSidebarMarkdownPaths(sidebar.docsSidebar)).toContain('docs/developer-guide/working-with-ai.md');
  const manifest = JSON.parse(readFileSync(new URL('../website/package.json', import.meta.url), 'utf8'));
  expect(manifest.scripts.build).toContain('docusaurus build && node scripts/prepare-llm-output.mjs');
});
