// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {extname} from 'node:path';
import {pathToFileURL} from 'node:url';

const SPDX_LINE = 'SPDX-License-Identifier: MIT';
const TANGRAM_COPYRIGHT = 'Copyright (c) 2013-2016 Brett Camper and Mapzen';
const VISGL_COPYRIGHT = 'Copyright (c) vis.gl contributors';
const VISGL_2026_COPYRIGHT = 'Copyright (c) 2026 vis.gl contributors';

const LINE_COMMENT_EXTENSIONS = new Set(['.cjs', '.glsl', '.js', '.mjs', '.ts']);
const HASH_COMMENT_EXTENSIONS = new Set(['.yaml', '.yml']);
const BLOCK_COMMENT_EXTENSIONS = new Set(['.css']);
const HTML_COMMENT_EXTENSIONS = new Set(['.html', '.md', '.svg']);

const COMMENTABLE_SPECIAL_FILES = new Map([
  ['.editorconfig', 'hash'],
  ['.gitignore', 'hash'],
  ['robots.txt', 'hash'],
  ['biome.jsonc', 'line']
]);

const VENDORED_PATH_PREFIXES = [
  'examples/classic/lib/'
];

const TANGRAM_RENDERER_FILES = new Set([
  'examples/classic/leaflet-layer.js',
  'modules/tangram-renderer/src/builders/common.ts',
  'modules/tangram-renderer/src/builders/points.ts',
  'modules/tangram-renderer/src/builders/polygons.ts',
  'modules/tangram-renderer/src/builders/polylines.ts',
  'modules/tangram-renderer/src/builders/wireframe.ts',
  'modules/tangram-renderer/src/gl/constants.ts',
  'modules/tangram-renderer/src/gl/context.ts',
  'modules/tangram-renderer/src/gl/extensions.ts',
  'modules/tangram-renderer/src/gl/glsl.ts',
  'modules/tangram-renderer/src/gl/render_state.ts',
  'modules/tangram-renderer/src/gl/shader_program.ts',
  'modules/tangram-renderer/src/gl/texture.ts',
  'modules/tangram-renderer/src/gl/vao.ts',
  'modules/tangram-renderer/src/gl/vbo_mesh.ts',
  'modules/tangram-renderer/src/gl/vertex_data.ts',
  'modules/tangram-renderer/src/gl/vertex_elements.ts',
  'modules/tangram-renderer/src/gl/vertex_layout.ts',
  'modules/tangram-renderer/src/index.ts',
  'modules/tangram-renderer/src/labels/collision.ts',
  'modules/tangram-renderer/src/labels/collision_grid.ts',
  'modules/tangram-renderer/src/labels/intersect.ts',
  'modules/tangram-renderer/src/labels/label.ts',
  'modules/tangram-renderer/src/labels/label_line.ts',
  'modules/tangram-renderer/src/labels/label_point.ts',
  'modules/tangram-renderer/src/labels/main_pass.ts',
  'modules/tangram-renderer/src/labels/point_anchor.ts',
  'modules/tangram-renderer/src/labels/point_placement.ts',
  'modules/tangram-renderer/src/labels/repeat_group.ts',
  'modules/tangram-renderer/src/procedures/mvt-legacy.ts',
  'modules/tangram-renderer/src/procedures/mvt-properties.ts',
  'modules/tangram-renderer/src/procedures/scene-yaml-legacy.ts',
  'modules/tangram-renderer/src/procedures/web-mercator-legacy.ts',
  'modules/tangram-renderer/src/lights/ambient_light.glsl',
  'modules/tangram-renderer/src/lights/directional_light.glsl',
  'modules/tangram-renderer/src/lights/light.ts',
  'modules/tangram-renderer/src/lights/material.glsl',
  'modules/tangram-renderer/src/lights/material.ts',
  'modules/tangram-renderer/src/lights/point_light.glsl',
  'modules/tangram-renderer/src/lights/spot_light.glsl',
  'modules/tangram-renderer/src/scene/camera.ts',
  'modules/tangram-renderer/src/scene/globals.ts',
  'modules/tangram-renderer/src/scene/scene.ts',
  'modules/tangram-renderer/src/scene/scene_bundle.ts',
  'modules/tangram-renderer/src/scene/scene_debug.ts',
  'modules/tangram-renderer/src/scene/scene_loader.ts',
  'modules/tangram-renderer/src/scene/scene_worker.ts',
  'modules/tangram-renderer/src/scene/view.ts',
  'modules/tangram-renderer/src/selection/selection.ts',
  'modules/tangram-renderer/src/selection/selection_fragment.glsl',
  'modules/tangram-renderer/src/selection/selection_globals.glsl',
  'modules/tangram-renderer/src/selection/selection_vertex.glsl',
  'modules/tangram-renderer/src/sources/data_source.ts',
  'modules/tangram-renderer/src/sources/geojson.ts',
  'modules/tangram-renderer/src/sources/mvt.ts',
  'modules/tangram-renderer/src/sources/raster.ts',
  'modules/tangram-renderer/src/sources/sources.ts',
  'modules/tangram-renderer/src/sources/topojson.ts',
  'modules/tangram-renderer/src/styles/filter.ts',
  'modules/tangram-renderer/src/styles/layer.ts',
  'modules/tangram-renderer/src/styles/lines/dasharray.ts',
  'modules/tangram-renderer/src/styles/lines/lines.ts',
  'modules/tangram-renderer/src/styles/points/points.ts',
  'modules/tangram-renderer/src/styles/points/points_fragment.glsl',
  'modules/tangram-renderer/src/styles/points/points_vertex.glsl',
  'modules/tangram-renderer/src/styles/polygons/polygons.ts',
  'modules/tangram-renderer/src/styles/polygons/polygons_fragment.glsl',
  'modules/tangram-renderer/src/styles/polygons/polygons_vertex.glsl',
  'modules/tangram-renderer/src/styles/raster/raster.ts',
  'modules/tangram-renderer/src/styles/raster/raster_globals.glsl',
  'modules/tangram-renderer/src/styles/style.ts',
  'modules/tangram-renderer/src/styles/style_globals.glsl',
  'modules/tangram-renderer/src/styles/style_manager.ts',
  'modules/tangram-renderer/src/styles/style_parser.ts',
  'modules/tangram-renderer/src/styles/text/font_manager.ts',
  'modules/tangram-renderer/src/styles/text/text.ts',
  'modules/tangram-renderer/src/styles/text/text_canvas.ts',
  'modules/tangram-renderer/src/styles/text/text_labels.ts',
  'modules/tangram-renderer/src/styles/text/text_segments.ts',
  'modules/tangram-renderer/src/styles/text/text_settings.ts',
  'modules/tangram-renderer/src/styles/text/text_wrap.ts',
  'modules/tangram-renderer/src/tile/tile.ts',
  'modules/tangram-renderer/src/tile/tile_id.ts',
  'modules/tangram-renderer/src/tile/tile_manager.ts',
  'modules/tangram-renderer/src/tile/tile_pyramid.ts',
  'modules/tangram-renderer/src/utils/debounce.ts',
  'modules/tangram-renderer/src/utils/debug_settings.ts',
  'modules/tangram-renderer/src/utils/errors.ts',
  'modules/tangram-renderer/src/utils/functions.ts',
  'modules/tangram-renderer/src/utils/geo.ts',
  'modules/tangram-renderer/src/utils/gl-matrix.ts',
  'modules/tangram-renderer/src/utils/hash.ts',
  'modules/tangram-renderer/src/utils/log.ts',
  'modules/tangram-renderer/src/utils/media_capture.ts',
  'modules/tangram-renderer/src/utils/merge.ts',
  'modules/tangram-renderer/src/utils/obb.ts',
  'modules/tangram-renderer/src/utils/props.ts',
  'modules/tangram-renderer/src/utils/slice.ts',
  'modules/tangram-renderer/src/utils/subscribe.ts',
  'modules/tangram-renderer/src/utils/task.ts',
  'modules/tangram-renderer/src/utils/thread.ts',
  'modules/tangram-renderer/src/utils/urls.ts',
  'modules/tangram-renderer/src/utils/utils.ts',
  'modules/tangram-renderer/src/utils/vector.ts',
  'modules/tangram-renderer/src/utils/version.ts',
  'modules/tangram-renderer/src/utils/worker_broker.ts',
  'modules/tangram-renderer/test/data_source.browser.spec.js',
  'modules/tangram-renderer/test/camera.browser.spec.ts',
  'modules/tangram-renderer/test/fixtures/sample-scene.yaml',
  'modules/tangram-renderer/test/geo.browser.spec.ts',
  'modules/tangram-renderer/test/helpers.js',
  'modules/tangram-renderer/test/layer.browser.spec.js',
  'modules/tangram-renderer/test/merge.browser.spec.ts',
  'modules/tangram-renderer/test/obb.browser.spec.ts',
  'modules/tangram-renderer/test/rollup.config.worker.js',
  'modules/tangram-renderer/test/scene.browser.spec.js',
  'modules/tangram-renderer/test/style.browser.spec.js',
  'modules/tangram-renderer/test/subscribe.browser.spec.js',
  'modules/tangram-renderer/test/tile_manager.browser.spec.js',
  'modules/tangram-renderer/test/tile_pyramid.browser.spec.js',
  'modules/tangram-renderer/test/tile.browser.spec.ts',
  'modules/tangram-renderer/test/vertex_data.browser.spec.ts',
  'modules/tangram-renderer/test/vertex_layout.browser.spec.ts'
]);

// Tangram-derived files that have received substantive vis.gl modifications.
// Keep the original Tangram notice and append the vis.gl modification notice.
const VISGL_MODIFIED_TANGRAM_FILES = new Set([
  'modules/tangram-renderer/src/gl/constants.ts',
  'modules/tangram-renderer/src/gl/extensions.ts',
  'modules/tangram-renderer/src/procedures/mvt-legacy.ts',
  'modules/tangram-renderer/src/procedures/mvt-properties.ts',
  'modules/tangram-renderer/src/procedures/scene-yaml-legacy.ts',
  'modules/tangram-renderer/src/procedures/web-mercator-legacy.ts',
  'modules/tangram-renderer/src/scene/camera.ts',
  'modules/tangram-renderer/src/scene/scene_bundle.ts',
  'modules/tangram-renderer/src/scene/globals.ts',
  'modules/tangram-renderer/src/sources/mvt.ts',
  'modules/tangram-renderer/src/sources/geojson.ts',
  'modules/tangram-renderer/src/sources/raster.ts',
  'modules/tangram-renderer/src/sources/topojson.ts',
  'modules/tangram-renderer/src/sources/data_source.ts',
  'modules/tangram-renderer/src/sources/sources.ts',
  'modules/tangram-renderer/src/styles/filter.ts',
  'modules/tangram-renderer/src/lights/material.ts',
  'modules/tangram-renderer/src/styles/lines/dasharray.ts',
  'modules/tangram-renderer/src/styles/raster/raster.ts',
  'modules/tangram-renderer/src/utils/media_capture.ts',
  'modules/tangram-renderer/src/utils/errors.ts',
  'modules/tangram-renderer/src/utils/functions.ts',
  'modules/tangram-renderer/src/utils/log.ts',
  'modules/tangram-renderer/src/utils/merge.ts',
  'modules/tangram-renderer/src/utils/obb.ts',
  'modules/tangram-renderer/src/utils/props.ts',
  'modules/tangram-renderer/src/utils/task.ts',
  'modules/tangram-renderer/src/utils/debug_settings.ts',
  'modules/tangram-renderer/src/utils/geo.ts',
  'modules/tangram-renderer/src/utils/gl-matrix.ts',
  'modules/tangram-renderer/src/utils/thread.ts',
  'modules/tangram-renderer/src/utils/urls.ts',
  'modules/tangram-renderer/src/utils/utils.ts',
  'modules/tangram-renderer/src/tile/tile_id.ts',
  'modules/tangram-renderer/src/utils/version.ts',
  'modules/tangram-renderer/src/utils/vector.ts',
  'modules/tangram-renderer/test/camera.browser.spec.ts',
  'modules/tangram-renderer/test/geo.browser.spec.ts'
]);

const TANGRAM_ROOT_FILES = new Set([
  '.editorconfig',
  '.gitignore',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'ISSUE_TEMPLATE.md',
  'README.md',
  'babel.config.js',
  'circle.yml',
  'modules/tangram-renderer/README.md',
  'modules/tangram-renderer/build/bundle.mjs',
  'modules/tangram-renderer/build/intro.js',
  'modules/tangram-renderer/rollup.config.mjs'
]);

const TANGRAM_CLASSIC_FILES = new Set([
  'examples/classic/app/gui.js',
  'examples/classic/app/key.js',
  'examples/classic/app/rStats.js',
  'examples/classic/app/url.js',
  'examples/classic/css/main.css',
  'examples/classic/index.html',
  'examples/classic/main.js',
  'examples/classic/scene.yaml',
  'examples/classic/styles/dots.yaml',
  'examples/classic/styles/halftone.yaml',
  'examples/classic/styles/popup.yaml',
  'examples/classic/styles/rainbow.yaml',
  'examples/classic/styles/water.yaml',
  'examples/classic/styles/wood.yaml'
]);

function getTrackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'})
    .split('\0')
    .filter(filePath => filePath && existsSync(filePath));
}

function getCommentStyle(filePath) {
  if (VENDORED_PATH_PREFIXES.some(prefix => filePath.startsWith(prefix))) {
    return null;
  }

  const specialStyle = COMMENTABLE_SPECIAL_FILES.get(filePath);
  if (specialStyle) {
    return specialStyle;
  }

  const extension = extname(filePath);
  if (extension === '.md' && (filePath.startsWith('docs/') || filePath.startsWith('website/src/'))) {
    return 'mdx';
  }
  if (LINE_COMMENT_EXTENSIONS.has(extension)) {
    return 'line';
  }
  if (HASH_COMMENT_EXTENSIONS.has(extension)) {
    return 'hash';
  }
  if (BLOCK_COMMENT_EXTENSIONS.has(extension)) {
    return 'block';
  }
  if (HTML_COMMENT_EXTENSIONS.has(extension)) {
    return 'html';
  }
  return null;
}

export function isTangramInherited(filePath) {
  if (TANGRAM_ROOT_FILES.has(filePath) || TANGRAM_CLASSIC_FILES.has(filePath)) {
    return true;
  }

  if (filePath.startsWith('modules/tangram-renderer/dist/tangram.')) {
    return true;
  }

  return TANGRAM_RENDERER_FILES.has(filePath);
}

export function getHeader(filePath, commentStyle) {
  const isInherited = isTangramInherited(filePath);
  const projectName = isInherited ? 'Tangram' : 'tangram-layers';
  const lines = [projectName, SPDX_LINE, isInherited ? TANGRAM_COPYRIGHT : VISGL_COPYRIGHT];
  if (VISGL_MODIFIED_TANGRAM_FILES.has(filePath)) {
    lines.push(VISGL_2026_COPYRIGHT);
  }

  switch (commentStyle) {
    case 'line':
      return `${lines.map(line => `// ${line}`).join('\n')}\n\n`;
    case 'hash':
      return `${lines.map(line => `# ${line}`).join('\n')}\n\n`;
    case 'block':
      return `/*\n${lines.map(line => ` * ${line}`).join('\n')}\n */\n\n`;
    case 'html':
      return `<!--\n${lines.join('\n')}\n-->\n\n`;
    case 'mdx':
      return `{/*\n${lines.join('\n')}\n */}\n\n`;
    default:
      throw new Error(`Unsupported comment style: ${commentStyle}`);
  }
}

export function insertHeader(filePath, source, header) {
  const insertionIndex = getHeaderInsertionIndex(filePath, source);
  return `${source.slice(0, insertionIndex)}${header}${source.slice(insertionIndex)}`;
}

export function getHeaderInsertionIndex(filePath, source) {
  if (source.startsWith('#!')) {
    const newlineIndex = source.indexOf('\n');
    return newlineIndex >= 0 ? newlineIndex + 1 : source.length;
  }

  if (filePath.endsWith('.md') && source.startsWith('---\n')) {
    const closingFrontMatterIndex = source.indexOf('\n---\n', 4);
    if (closingFrontMatterIndex >= 0) {
      return closingFrontMatterIndex + 6;
    }
  }

  if (filePath.endsWith('.html') && /^<!doctype html>/i.test(source)) {
    const newlineIndex = source.indexOf('\n');
    return newlineIndex + 1;
  }

  return 0;
}

function getExistingHeaderEnd(commentStyle, sourceAtHeader) {
  if (commentStyle === 'block' || commentStyle === 'html' || commentStyle === 'mdx') {
    const marker = commentStyle === 'block' ? '*/' : commentStyle === 'mdx' ? '*/}' : '-->';
    const markerIndex = sourceAtHeader.indexOf(marker);
    return markerIndex >= 0 ? markerIndex + marker.length : 0;
  }

  let headerEnd = 0;
  for (const line of sourceAtHeader.match(/[^\n]*(?:\n|$)/g) || []) {
    const headerValue = line.replace(/^(?:\/\/|#)\s?/, '').trim();
    const isHeaderLine =
      headerValue === 'Tangram' ||
      headerValue === 'tangram-layers' ||
      headerValue === SPDX_LINE ||
      headerValue.startsWith('Copyright');
    if (!isHeaderLine) {
      break;
    }
    headerEnd += line.length;
  }
  return headerEnd;
}

export function updateLicenseHeader(filePath, source) {
  const commentStyle = getCommentStyle(filePath);
  if (!commentStyle) {
    return {status: 'ignored', source};
  }

  const expectedHeader = getHeader(filePath, commentStyle);
  const expectedHeaderCore = expectedHeader.trimEnd();
  const insertionIndex = getHeaderInsertionIndex(filePath, source);
  const sourceAtHeader = source.slice(insertionIndex);
  if (sourceAtHeader.startsWith(expectedHeaderCore)) {
    return {status: 'current', source};
  }

  const headerPreamble = sourceAtHeader.slice(0, 300);
  const startsWithComment = headerPreamble.startsWith('//') ||
    headerPreamble.startsWith('#') ||
    headerPreamble.startsWith('/*') ||
    headerPreamble.startsWith('<!--') || headerPreamble.startsWith('{/*');
  if (startsWithComment && headerPreamble.includes(SPDX_LINE)) {
    const existingHeaderEnd = getExistingHeaderEnd(commentStyle, sourceAtHeader);
    if (existingHeaderEnd > 0) {
      const remainingSource = sourceAtHeader
        .slice(existingHeaderEnd)
        .replace(/^(?:\r?\n)+/, '');
      return {
        status: 'incorrect',
        source: `${source.slice(0, insertionIndex)}${expectedHeader}${remainingSource}`
      };
    }
  }

  return {status: 'missing', source: insertHeader(filePath, source, expectedHeader)};
}

export function checkLicenseHeaders({writeHeaders = false, files = getTrackedFiles()} = {}) {
  const missingHeaders = [];
  const incorrectCopyrights = [];
  const updatedFiles = [];

  for (const filePath of files) {
    const source = readFileSync(filePath, 'utf8');
    const result = updateLicenseHeader(filePath, source);
    if (result.status === 'current' || result.status === 'ignored') {
      continue;
    }
    if (writeHeaders) {
      writeFileSync(filePath, result.source);
      updatedFiles.push(filePath);
    } else if (result.status === 'incorrect') {
      incorrectCopyrights.push(filePath);
    } else {
      missingHeaders.push(filePath);
    }
  }

  return {missingHeaders, incorrectCopyrights, updatedFiles};
}

function reportLicenseHeaders({missingHeaders, incorrectCopyrights, updatedFiles}, writeHeaders) {
  if (missingHeaders.length || incorrectCopyrights.length) {
    if (missingHeaders.length) {
      console.error(
        `Missing SPDX license headers:\n${missingHeaders.map(file => `  ${file}`).join('\n')}`
      );
    }
    if (incorrectCopyrights.length) {
      console.error(
        `Files with incorrect copyright attribution:\n${incorrectCopyrights.map(file => `  ${file}`).join('\n')}`
      );
    }
    console.error('\nRun yarn lint:licenses:fix to update headers.');
    process.exitCode = 1;
    return;
  }

  if (writeHeaders) {
    console.log(`Updated SPDX license headers in ${updatedFiles.length} file(s).`);
  } else {
    console.log('SPDX license headers are current.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const writeHeaders = process.argv.includes('--write');
  reportLicenseHeaders(checkLicenseHeaders({writeHeaders}), writeHeaders);
}
