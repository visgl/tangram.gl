// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

const packages = ['tangram-renderer', 'tangram-layers', 'basemap-layers'];
const expectedVersion = process.env.RELEASE_VERSION || '0.0.1';

/** Verify exported entry points and dependency metadata in packed artifacts. */
for (const packageName of packages) {
  const archive = join(process.env.PACKAGE_ARCHIVE_DIR || '/tmp', `${packageName}.tgz`);
  const files = new Set(execFileSync('tar', ['-tzf', archive], {encoding: 'utf8'}).trim().split('\n'));
  const read = path => execFileSync('tar', ['-xOzf', archive, path], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  const manifest = JSON.parse(read('package/package.json'));
  if (manifest.name !== `@tangram.gl/${packageName}` || manifest.version !== expectedVersion) {
    throw new Error(`${packageName}: unexpected packed package identity.`);
  }
  for (const dependencies of [manifest.dependencies, manifest.peerDependencies]) {
    if (Object.hasOwn(dependencies || {}, '@tangram.gl/map-utils')) {
      throw new Error(`${packageName}: private map-utils must not be a runtime dependency.`);
    }
    for (const value of Object.values(dependencies || {})) {
      if (typeof value === 'string' && value.startsWith('workspace:')) {
        throw new Error(`${packageName}: unresolved workspace dependency.`);
      }
    }
  }
  const verifyExport = entry => {
    if (typeof entry === 'string') {
      if (!entry.includes('*') && !files.has(`package/${entry.replace(/^\.\//, '')}`)) {
        throw new Error(`${packageName}: missing export ${entry}.`);
      }
    } else if (entry && typeof entry === 'object') {
      Object.values(entry).forEach(verifyExport);
    }
  };
  verifyExport(manifest.exports);
  const codeFiles = [...files].filter(file =>
    file.startsWith('package/dist/') && /\.(?:[cm]?js|d\.ts)$/.test(file)
  );
  const code = execFileSync('tar', ['-xOzf', archive, ...codeFiles], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024
  });
  if (/["']@tangram\.gl\/map-utils(?:\/[^"']*)?["']/.test(code)) {
    throw new Error(`${packageName}: emitted code references the private map-utils workspace.`);
  }
  if (packageName === 'tangram-renderer') {
    const worker = read('package/dist/scene-worker.js');
    if (/^\s*import\s/m.test(worker)) {
      throw new Error('tangram-renderer: the scene worker has unresolved module imports.');
    }
  }
  if (packageName === 'basemap-layers') {
    for (const path of ['package/dist/geojson-worker.js', 'package/dist/geojson-task-worker.js']) {
      const worker = read(path);
      if (/^\s*import\s/m.test(worker)) {
        throw new Error(`basemap-layers: ${path} has unresolved module imports.`);
      }
    }
  }
  console.log(`${manifest.name}@${manifest.version}: package exports verified`);
}
