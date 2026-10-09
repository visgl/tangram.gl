// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// Deployment-prefix normalization follows visgl/luma.gl PR #2764.
import {existsSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';

/** Collect rendered documents only; static example assets are not documentation. */
function findMarkdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? findMarkdownFiles(path) : entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

/** Fail the production build with an actionable documentation-output error. */
function fail(message) {
  throw new Error(`LLM documentation output: ${message}`);
}

/** Remove plugin 1.2.2's duplicated URL prefix and deployment-only category headings. */
export function normalizeLlmMarkdown(markdown, config, isIndex = false) {
  const segments = config.baseUrl.split('/').filter(Boolean);
  const siteUrl = new URL(`/${segments.join('/')}${segments.length ? '/' : ''}`, config.url);
  if (segments.length) {
    const duplicatedUrl = new URL(`${segments.join('/')}/`, siteUrl).href;
    markdown = markdown.split(duplicatedUrl).join(siteUrl.href);
  }
  if (!isIndex || !segments.length) return markdown;
  const lines = markdown.split('\n');
  const firstSection = lines.findIndex(line => line.startsWith('## '));
  if (firstSection < 0) fail('llms.txt has no documentation section');
  if (lines[firstSection] === '## docs') return markdown;
  for (const [index, segment] of segments.entries()) {
    const heading = `${'#'.repeat(index + 2)} ${segment}`;
    if (lines[firstSection] !== heading) fail(`expected deployment heading ${heading}`);
    lines.splice(firstSection, 1);
    while (lines[firstSection] === '') lines.splice(firstSection, 1);
  }
  return lines.map(line => {
    const heading = /^(#+) (.+)$/.exec(line);
    return heading && heading[1].length >= segments.length + 2
      ? `${heading[1].slice(segments.length)} ${heading[2]}` : line;
  }).join('\n');
}

/** Collect explicit document IDs from nested categories without losing README routes. */
function getSidebarDocIds(items) {
  return items.flatMap(item => {
    if (typeof item === 'string') return [item];
    if (item.type === 'doc') return [item.id];
    if (item.type === 'category') return getSidebarDocIds(item.items);
    fail(`unsupported sidebar item ${item.type}`);
  });
}

/** Derive required Markdown siblings from Tangram's explicit documentation sidebar. */
export function getSidebarMarkdownPaths(items) {
  return getSidebarDocIds(items).map(id => `${id === 'README' ? 'docs' : `docs/${id.replace(/\/README$/, '')}`}.md`);
}

/** Extract ordinary Markdown links while ignoring fenced code examples. */
function getMarkdownLinks(markdown) {
  let fence;
  const prose = markdown.split('\n').filter(line => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      return false;
    }
    return !fence;
  }).join('\n');
  return [...prose.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)].map(match => match[1].replace(/^<|>$/g, ''));
}

/** Resolve same-site Markdown links without allowing an escape from the deployment root. */
function resolveMarkdownTarget(buildDirectory, sourcePath, link, siteUrl) {
  const sourceUrl = new URL(relative(buildDirectory, sourcePath).split('\\').join('/'), siteUrl);
  const targetUrl = new URL(link, sourceUrl);
  if (targetUrl.origin !== siteUrl.origin || !targetUrl.pathname.endsWith('.md')) return null;
  if (!targetUrl.pathname.startsWith(siteUrl.pathname)) fail(`${relative(buildDirectory, sourcePath)} links outside the website base: ${link}`);
  const targetPath = resolve(buildDirectory, decodeURIComponent(targetUrl.pathname.slice(siteUrl.pathname.length)));
  const localPath = relative(buildDirectory, targetPath);
  if (localPath.startsWith('..') || localPath.startsWith('/')) fail(`Markdown link escapes the build: ${link}`);
  return targetPath;
}

/** Summarize rendered prose, not source-level MDX license comments or badge markup. */
function getDocumentDescription(markdown) {
  for (const paragraph of markdown.split(/\n\s*\n/)) {
    if (/^(?:[#>*|!<]|[-+]\s|\d+[.)]\s|```|~~~|\[!|\{\/\*)/.test(paragraph.trim())) continue;
    const text = paragraph.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return text.length <= 200 ? text : `${text.slice(0, 197).replace(/\s+\S*$/, '')}…`;
  }
  fail('document has no rendered prose for an index description');
}

/** Normalize and validate generated page Markdown and the curated, canonical llms.txt index. */
export function prepareLlmOutput(buildDirectory, config, requiredPages = []) {
  buildDirectory = resolve(buildDirectory);
  const indexPath = join(buildDirectory, 'llms.txt');
  const overviewPath = join(buildDirectory, 'docs.md');
  if (!existsSync(indexPath)) fail('missing llms.txt');
  if (existsSync(join(buildDirectory, 'llms-full.txt'))) fail('llms-full.txt must not be generated');
  const markdownPaths = [overviewPath, ...findMarkdownFiles(join(buildDirectory, 'docs'))];
  for (const path of [indexPath, ...markdownPaths]) {
    if (!existsSync(path) || !statSync(path).isFile()) fail(`missing ${relative(buildDirectory, path)}`);
    const original = readFileSync(path, 'utf8');
    const normalized = normalizeLlmMarkdown(original, config, path === indexPath);
    if (normalized !== original) writeFileSync(path, normalized);
  }
  let index = readFileSync(indexPath, 'utf8');
  if (!index.startsWith(`# ${config.title}\n`)) fail('unexpected llms.txt title');
  const pluginOptions = config.plugins?.find(entry => Array.isArray(entry) && entry[0] === '@signalwire/docusaurus-plugin-llms-txt')?.[1];
  if (pluginOptions?.siteDescription && !/^> /m.test(index)) {
    index = index.replace(`# ${config.title}\n`, `# ${config.title}\n\n> ${pluginOptions.siteDescription}\n`);
  }
  if (index.match(/^## .+$/m)?.[0] !== '## docs') fail('unexpected llms.txt documentation hierarchy');
  if (/\/examples(?:\/|\.md)/.test(index)) fail('examples must not be indexed');
  if (index.includes('{/*')) fail('unprocessed MDX description in llms.txt');
  const siteUrl = new URL(config.baseUrl, config.url);
  const indexedPaths = new Set();
  for (const link of getMarkdownLinks(index)) {
    const url = new URL(link);
    if (url.origin !== siteUrl.origin || !link.startsWith(siteUrl.href)) fail(`noncanonical index URL: ${link}`);
    const targetPath = resolveMarkdownTarget(buildDirectory, indexPath, link, siteUrl);
    if (!targetPath || !existsSync(targetPath)) fail(`missing indexed Markdown page: ${link}`);
    indexedPaths.add(targetPath);
  }
  for (const page of requiredPages) {
    if (!indexedPaths.has(join(buildDirectory, page))) fail(`missing sidebar page from index: ${page}`);
  }
  for (const path of markdownPaths) {
    const markdown = readFileSync(path, 'utf8');
    if (!indexedPaths.has(path)) fail(`generated document absent from index: ${relative(buildDirectory, path)}`);
    if (markdown.trim().length < 40) fail(`empty extracted document: ${relative(buildDirectory, path)}`);
    if (/<(?:Tabs|TabItem|DeckExample|WebXRExample)\b/.test(markdown)) fail(`unprocessed MDX: ${relative(buildDirectory, path)}`);
    for (const link of getMarkdownLinks(markdown)) {
      const targetPath = resolveMarkdownTarget(buildDirectory, path, link, siteUrl);
      if (targetPath && !existsSync(targetPath)) fail(`broken Markdown link in ${relative(buildDirectory, path)}: ${link}`);
    }
  }
  const stylingPath = join(buildDirectory, 'docs/api-reference/styling.md');
  if (existsSync(stylingPath)) {
    const styling = readFileSync(stylingPath, 'utf8');
    if (!styling.includes('```yaml') || !styling.includes('```json')) fail('styling extraction must include both YAML and JSON tabs');
  }
  index = index.split('\n').map(line => {
    const entry = /^(- \[[^\]]+\]\(([^)]+)\))(?::.*)?$/.exec(line);
    if (!entry) return line;
    const path = resolveMarkdownTarget(buildDirectory, indexPath, entry[2], siteUrl);
    return `${entry[1]}: ${getDocumentDescription(readFileSync(path, 'utf8'))}`;
  }).join('\n');
  if (index !== readFileSync(indexPath, 'utf8')) writeFileSync(indexPath, index);
  return markdownPaths.length;
}
