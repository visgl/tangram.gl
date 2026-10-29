// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {execFileSync} from 'node:child_process';

const packages = ['tangram-renderer', 'tangram-layers', 'basemap-layers'];
const expectedVersion = process.env.RELEASE_VERSION || '0.0.0';

/** Verify exported entry points and dependency metadata in packed artifacts. */
for (const packageName of packages) {
  const archive = `/tmp/${packageName}.tgz`;
  const files = new Set(execFileSync('tar', ['-tzf', archive], {encoding: 'utf8'}).trim().split('\n'));
  const read = path => execFileSync('tar', ['-xOzf', archive, path], {encoding: 'utf8'});
  const manifest = JSON.parse(read('package/package.json'));
  if (manifest.name !== `@tangram.gl/${packageName}` || manifest.version !== expectedVersion) {
    throw new Error(`${packageName}: unexpected packed package identity.`);
  }
  for (const dependencies of [manifest.dependencies, manifest.peerDependencies]) {
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
  if (packageName === 'basemap-layers') {
    const worker = read('package/dist/geojson-worker.js');
    if (/^\s*import\s/m.test(worker)) {
      throw new Error('basemap-layers: the browser worker has unresolved module imports.');
    }
  }
  console.log(`${manifest.name}@${manifest.version}: package exports verified`);
}
