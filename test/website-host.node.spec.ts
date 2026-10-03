// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {readFileSync, readdirSync} from 'node:fs';
import {describe, expect, test} from 'vitest';

/** Read repository-owned configuration without invoking a website build. */
function readSource(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('canonical documentation host', () => {
  test('uses vis.gl metadata and keeps local website build commands without publishing scripts', () => {
    for (const path of [
      'package.json',
      'modules/tangram-renderer/package.json',
      'modules/tangram-layers/package.json'
    ]) {
      expect(JSON.parse(readSource(path)).homepage).toBe('https://vis.gl/tangram.gl/');
    }
    const root = JSON.parse(readSource('package.json'));
    const website = JSON.parse(readSource('website/package.json'));
    expect(root.scripts['website:build']).toBeDefined();
    expect(root.scripts['website:start']).toBeDefined();
    expect(root.scripts['website:deploy']).toBeUndefined();
    expect(website.scripts.deploy).toBeUndefined();
    const config = readSource('website/docusaurus.config.js');
    expect(config).toContain("url: 'https://vis.gl'");
    expect(config).toContain("baseUrl: '/tangram.gl/'");
  });

  test('retains website CI but has no Pages deployment workflow or permissions', () => {
    const workflowFiles = readdirSync(new URL('../.github/workflows/', import.meta.url)).filter(
      path => /\.ya?ml$/.test(path)
    );
    const workflows = workflowFiles.map(path => readSource(`.github/workflows/${path}`)).join('\n');
    expect(workflows).toContain('yarn test-website');
    expect(workflows).not.toMatch(/actions\/(?:configure-pages|upload-pages-artifact|deploy-pages)@/);
    expect(workflows).not.toMatch(/pages:\s*write/);
  });

  test('documentation and tile-loader examples no longer depend on the repository Pages host', () => {
    for (const path of [
      'README.md',
      'examples/deck/README.md',
      'docs/api-reference/styling.md',
      'examples/classic/styles/loaders-mvt.yaml',
      'examples/classic/styles/loaders-mlt.yaml',
      'examples/classic/styles/loaders-pmtiles.yaml'
    ]) {
      const source = readSource(path);
      expect(source).not.toContain('visgl.github.io/tangram.gl');
      expect(source).toContain('https://vis.gl/tangram.gl/');
    }
  });
});
